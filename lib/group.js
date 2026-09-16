/**
 * 群聊服务（v2 架构的核心）。
 *
 * 一个群 = 一个由本插件创建的**独立群主会话**：
 *
 *   group-<uuid>  ← root 会话，preset 由建群时指定（默认 standard），群主 agent 就是它
 *        └── 成员：续存型子代理（`subagents.startContinuable`），label 即群内名字，
 *            人格取自被拉的 preset，能力面 = 群主 preset 的工具面 ∩ 成员黑名单
 *
 * 于是三样东西全部交给原生机制，插件不再自建：
 *   - 名册与状态 → 原生子代理目录（`subagents.listChildren`）
 *   - 频道       → 群主会话自己的记录（成员的回复收尾消息原生落进父会话；工具面里
 *                 有 `send_message` 时成员还能主动提前汇报）
 *   - 唤醒/转达  → 群主 agent 自带的 `send_message`（standard/cordis preset 都有）
 *
 * 唯一自建状态是"哪些会话是群、群叫什么、成员当初用哪个 preset 拉的"（见 ./store.js）。
 *
 * 关于"每个成员跑自己的 preset 工具面"：本版本**做不到**，且已实测四条路全部封死——
 * 子 agent 只能继承父会话 preset；生成后用 `agentPresets.select` 换会被拒（"has already
 * started; its agent preset is fixed"）；`recompose` 虽无守卫，但不写 `agent-preset/selected`
 * 且实测会让成员当场不可达；跨会话注入要求相邻父子。因此本服务采用契约内模型：
 * **能力面由群主 preset 决定，角色差异用 persona + toolFilter(deny) 表达。**
 */

import {
  DEFAULT_GROUP_PRESET,
  activeMembers,
  dedupeName,
  markMemberRemoved,
  markMemberRestored,
  nextGroupName,
  putGroup,
  putMember,
  readRegistryFile,
  registryPath,
  removeGroup,
  removedMembers,
  takenMemberNames,
  updateGroup,
  writeRegistryFile
} from './store.js'

/**
 * 成员黑名单。这里刻意只放"会让群结构变乱"的工具：
 * 成员不该再拉人/建群（`group_pull` / `group_create`）、不该枚举或打断别的成员
 * （`list_agents` / `interrupt_agent`）、也不该越过群主直接问人类（`ask_user_question`）。
 *
 * 名字必须**确实存在于群主会话的工具域**里：`tools.restrict()` 遇到不认识的名字会拒绝整个
 * 名单（v1 的 `group_invite` / `agrp_pull` 都已不存在，留着只会让每次拉人都走降级并弹告警）。
 */
export const MEMBER_TOOL_DENY = ['group_pull', 'group_create', 'list_agents', 'interrupt_agent', 'ask_user_question']
/** 名字解析不出来时的保守黑名单。 */
export const FALLBACK_DENY = ['list_agents', 'interrupt_agent', 'ask_user_question']

/** 会话标题前缀：侧边栏里靠它区分群聊会话与普通会话。 */
const TITLE_PREFIX = '\u{1F465} '
const errMsg = (error) => String((error && error.message) || error)
const nonEmpty = (value) => (typeof value === 'string' && value.length > 0 ? value : undefined)

/**
 * 子代理启动需要一个 AbortSignal，而宿主进程里并不总有 AbortController 可用；
 * dsh-subagent 只会读 `aborted`、调 `throwIfAborted()`、增删 `abort` 监听，
 * 所以一个鸭子类型的"永不中止"信号就够了。
 */
export function makeSignal() {
  const listeners = []
  const signal = {
    aborted: false,
    reason: undefined,
    onabort: null,
    throwIfAborted() { if (signal.aborted) throw new Error('operation aborted') },
    addEventListener(type, listener) {
      if (type === 'abort' && typeof listener === 'function' && listeners.indexOf(listener) < 0) listeners.push(listener)
    },
    removeEventListener(type, listener) {
      const at = listeners.indexOf(listener)
      if (at >= 0) listeners.splice(at, 1)
    },
    dispatchEvent() { return true }
  }
  return signal
}

/**
 * `tools.restrict()` 会按父会话的工具域校验名字，并在报错里列出该工具域。
 * 从报错文本里解析出它，比从本插件自己的作用域查 `tools.schemas()` 准确得多。
 */
export function knownToolNamesFrom(message) {
  const marker = 'known global tools: '
  const at = String(message).indexOf(marker)
  if (at < 0) return undefined
  const names = new Set()
  for (const piece of String(message).slice(at + marker.length).split(',')) {
    const name = piece.trim()
    if (name.length > 0) names.add(name)
  }
  return names.size > 0 ? names : undefined
}

function indentOf(line) {
  let n = 0
  while (n < line.length && (line.charAt(n) === ' ' || line.charAt(n) === '\t')) n += 1
  return n
}

/** 只看列 0 的 `- id: <value>` 行，避免把嵌套配置行当成新条目。 */
function rowIdOf(line) {
  if (line.slice(0, 2) !== '- ') return undefined
  const rest = line.slice(2)
  if (rest.slice(0, 3) !== 'id:') return undefined
  return rest.slice(3).trim()
}

/** 取 persona 行的 `prefix:` 块标量（`|`、`|-`、`|+`、`>`、`>-`、`>+`）。 */
export function parsePersonaPrefix(content) {
  if (typeof content !== 'string' || content.length === 0) return null
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  let start = -1
  for (let i = 0; i < lines.length; i += 1) { if (rowIdOf(lines[i]) === 'persona') { start = i; break } }
  if (start < 0) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) { if (rowIdOf(lines[i]) !== undefined) { end = i; break } }
  for (let i = start + 1; i < end; i += 1) {
    const text = lines[i].trim()
    if (!text.startsWith('prefix:')) continue
    const marker = text.slice(7).trim()
    const head = marker.charAt(0)
    if (head !== '|' && head !== '>') continue
    const keyIndent = indentOf(lines[i])
    const block = []
    for (let j = i + 1; j < end; j += 1) {
      const inner = lines[j]
      if (inner.trim() === '') { block.push(''); continue }
      if (indentOf(inner) <= keyIndent) break
      block.push(inner)
    }
    while (block.length > 0 && block[0] === '') block.shift()
    while (block.length > 0 && block[block.length - 1] === '') block.pop()
    if (block.length === 0) continue
    let min = Infinity
    for (const line of block) { if (line !== '') { const n = indentOf(line); if (n < min) min = n } }
    if (min === Infinity) min = 0
    const lines2 = block.map((line) => (line === '' ? '' : line.slice(min)))
    // `>` 是折叠标量：单个换行折成空格，空行仍是换行；`|` 是字面标量，原样保留换行。
    const out = (head === '>'
      ? lines2.reduce((acc, line) => {
        if (line === '') return acc + '\n'
        if (acc.length > 0 && acc.charAt(acc.length - 1) !== '\n') return acc + ' ' + line
        return acc + line
      }, '')
      : lines2.join('\n')).trim()
    if (out) return out
  }
  return null
}

/** 成员人格 = 被拉 preset 的 persona 前缀；没有就退化成一个说明性的身份段。 */
export async function extractPersona(source, presetId) {
  try {
    const content = await source.read(presetId)
    const block = parsePersonaPrefix(content)
    if (block) return block
  } catch (error) { /* fall through to the metadata form */ }
  let meta
  try {
    const list = await source.list()
    meta = (list || []).find((item) => item.id === presetId)
  } catch (error) { meta = undefined }
  return '你是「' + ((meta && meta.name) || presetId) + '」。\n' + ((meta && meta.description) || '')
    + '\n你的身份来自已安装的 agent preset "' + presetId + '"，工具能力面由群主会话决定。'
}

/** 原生子代理行 → 面板用的成员行（纯函数，便于单测）。 */
export function mapChildRows(rows) {
  const out = []
  for (const row of rows || []) {
    if (!row || row.kind !== 'child') continue
    const id = String(row.id)
    const label = row.label === undefined || row.label === null ? '' : String(row.label)
    out.push({
      id,
      name: label.length > 0 ? label : id,
      status: row.activity === 'running' ? 'running' : 'idle',
      mode: row.mode === 'continuable' ? 'continuable' : 'one-shot'
    })
  }
  return out
}

/**
 * 成员的入群说明（拼在 persona 后面常驻）。只写三件事：叫谁、怎么汇报、什么时候才动手。
 *
 * 「什么时候动手」这条是实机教训：拉人必然触发成员的第一轮，而第一轮只有握手消息、
 * 没有任务。旧文案写的是"收到群主派活后先动手"，成员读不出"这轮没活"，于是把入群当任务，
 * 自发调研了 15 步 / 21 次 bash、憋出一份 52 行的报告交上来（实机复现过一次，群主又被
 * 收尾消息唤起跟着烧了一轮）。所以这里必须显式区分**握手轮**与**任务轮**。
 */
export function memberNotice(input) {
  return '你是聊天群「' + input.groupName + '」的成员，群内名字「' + input.memberName + '」，'
    + '群主会话 id 是 ' + input.groupId + '（你的直接父代理）。\n'
    + '怎么看消息：只有消息里**带了具体任务**才动手。带任务的按任务干：先动手，做完把结论汇报出去，再结束本轮。'
    + '没带任务的问候／握手消息不是任务——回一行就位确认即可，不要调研、不要读文件、不要产出任何交付物。\n'
    + '怎么汇报：把结论写在本轮回复的正文里，群主一定会收到你的收尾消息；'
    + '如果你的工具面里有 send_message，也可以在结论出来时主动 send_message(agent_id="' + input.groupId + '") 提前汇报。\n'
    + '边界：DSH 不允许兄弟会话之间直接互发，所以不要试图直接联系其他成员，也不要再拉新人进来。'
}

/**
 * 拉人时发给成员的**第一轮**消息：一次明确定义为「无任务」的握手。
 *
 * `startContinuable` 必须带一条初始 prompt，且投递即开轮（`delivery: 'queue'`），
 * 所以"拉进来先待命"只能靠这条消息把这一轮钉死成一个不花钱的握手：
 * 不调研、不调工具、只回一行。等群主真正派活时，任务消息才是下一轮。
 */
export function memberWelcome(input) {
  return '【入群握手 · 本轮没有任务】你是聊天群「' + input.groupName + '」的成员「' + input.memberName
    + '」（人格取自 preset ' + input.presetId + '）。\n'
    + '本轮不要调研、不要读文件、不要调用任何工具、不要输出任何报告或规格。'
    + '只回一行就位确认：已就位 · ' + input.memberName + '。\n'
    + '等群主在消息里带来具体任务后再动手。'
}

/** 群主 preset 太弱时的显式提示（这正是"成员只有 pwsh"那个坑的现场）。 */
export function capabilityWarning(presetId) {
  if (presetId === 'minimal') {
    return '群主 preset 是 minimal（只有持久 shell），成员的能力面会被它限制：成员拿不到 read/write/edit/grep 等工具。'
      + '建议把群聊建在 standard / cordis 上。'
  }
  return undefined
}

/**
 * 建立群聊服务。所有 Cordis 服务都按需 `ctx.get` 并判空——面板的功能可以局部降级，
 * 但插件本身不该因为某个服务缺席而挂载失败。
 */
export function createGroupService(ctx, options) {
  const file = (options && options.registryFile) || registryPath()
  const readFile = () => readRegistryFile(file)
  const writeFile = (data) => writeRegistryFile(file, data)

  /**
   * 我们自己把群会话拉上线时拿到的句柄（`AgentHandle`）。`dispose()` 是**持有者专属的能力**：
   * 只有持有它的那一方能把 agent 从活会话表（`ctx.sessions.list()`）里摘掉。
   *
   * 为什么必须留着它：`@linxin666/dsh-session-archive`（设置里的会话归档/删除）把
   * **进程内仍然 live 的会话**标成受保护（原因 `attached`：会话仍被 DSH 进程占用），
   * 而"族里只要有受保护成员就整族跳过"的规则会连带保住成员会话——实机现象就是
   * **群聊会话删不掉、它的子 agent 会话也没被删**。DSH 自己（GUI 的启动路径）是
   * `(await agents.resume(...)).agent`，句柄当场丢掉，所以凡是被打开过的会话整轮进程都冷不下来；
   * 我们至少不要在自己这条路上再漏一个。
   */
  const ownedHandles = new Map()
  const agents = () => ctx.get('agents')
  const subagents = () => ctx.get('subagents')
  const presets = () => ctx.get('agentPresets')
  const sessions = () => ctx.get('sessions')
  const controller = () => ctx.get('sessionController')
  const sessionTitle = () => ctx.get('sessionTitle')

  async function listPresets() {
    const service = presets()
    if (service === undefined) return []
    try {
      const rows = await service.list()
      return rows.map((row) => ({
        id: String(row.id),
        name: String(row.name === undefined || row.name === null ? row.id : row.name),
        description: row.description === undefined ? '' : String(row.description),
        trust: row.trust === undefined ? '' : String(row.trust)
      }))
    } catch (error) { return [] }
  }

  async function childrenOf(sessionId) {
    const service = subagents()
    if (service === undefined) return []
    try { return mapChildRows(await service.listChildren(sessionId)) } catch (error) { return [] }
  }

  function liveAgent(sessionId) {
    const service = agents()
    if (service === undefined) return undefined
    try { return service.get(sessionId) } catch (error) { return undefined }
  }

  /**
   * 确保群会话的标题是 `👥 <群名>`——侧边栏里靠这个前缀区分群聊会话与普通会话。
   * 只对**在线**的会话生效（冷会话等它上线后由下一次自愈补上）；标题已正确时跳过，不刷事件。
   */
  function ensureTitle(group) {
    const service = sessionTitle()
    const sessionsService = sessions()
    if (service === undefined || sessionsService === undefined) return false
    let session
    try { session = sessionsService.get(group.id) } catch (error) { return false }
    if (session === undefined) return false
    const wanted = TITLE_PREFIX + group.name
    let current
    try {
      const snapshot = typeof service.get === 'function' ? service.get(session) : undefined
      current = snapshot && snapshot.title !== undefined && snapshot.title !== null ? String(snapshot.title) : undefined
    } catch (error) { current = undefined }
    if (current === wanted) return false
    try {
      service.rename(session, wanted)
      return true
    } catch (error) { return false }
  }

  async function state() {
    const registry = readFile()
    const groups = []
    for (const id of Object.keys(registry.groups)) {
      const group = registry.groups[id]
      const children = await childrenOf(id)
      const byId = new Map(children.map((row) => [row.id, row]))
      const members = activeMembers(group).map((member) => {
        const live = byId.get(member.childId)
        return {
          id: member.childId,
          name: member.name,
          preset_id: member.presetId,
          status: live === undefined ? 'inactive' : live.status,
          registered: true
        }
      })
      // 群主自己用 subagent 工具拉来的人（或历史遗留成员）也要看得见，否则面板会"少人"。
      for (const row of children) {
        if (group.members.some((member) => member.childId === row.id)) continue
        members.push({ id: row.id, name: row.name, preset_id: '', status: row.status, registered: false })
      }
      const owner = liveAgent(id)
      const ownerModel = agentModelOf(owner)
      // 顺手自愈标题（👥 前缀）：只对在线会话生效，已正确时 rename 都不会发生。
      if (owner !== undefined) ensureTitle(group)
      const warnings = []
      const presetWarning = capabilityWarning(group.presetId)
      if (presetWarning !== undefined) warnings.push(presetWarning)
      // 没有模型的群主是残的（实机验证时踩到过：群主 {{model}} 报错、成员继承不到 provider/model）。
      if (owner !== undefined && ownerModel === null) {
        warnings.push('群主 agent 没有 provider/model（agent-default-model 设置缺失）：这个群无法工作，建议解散后重建。')
      }
      groups.push({
        id,
        name: group.name,
        cwd: group.cwd,
        preset_id: group.presetId,
        owner_live: owner !== undefined,
        owner_model: ownerModel,
        created_at: group.createdAt,
        members,
        removed: removedMembers(group).map((member) => ({ id: member.childId, name: member.name, preset_id: member.presetId })),
        capability_warning: warnings.length === 0 ? undefined : warnings.join('\n')
      })
    }
    groups.sort((left, right) => Number(right.created_at) - Number(left.created_at))
    return {
      groups,
      presets: await listPresets(),
      default_group_preset: DEFAULT_GROUP_PRESET,
      caps: {
        sessions: sessions() !== undefined,
        agents: agents() !== undefined,
        subagents: subagents() !== undefined,
        agentPresets: presets() !== undefined,
        sessionController: controller() !== undefined
      }
    }
  }

  /**
   * 默认 provider/model。与 `sessionController.agentOptions()` 同源（都是
   * `agentDefaultModel.currentSelection()`），兜底路径必须自己带上：
   * **没有它的 agent 就是残的**——症状是群主会话报
   * `prompt variable "{{model}}" has no value`，而它拉出来的成员报
   * `agent "…" has no provider/model`（实机验证时踩到过）。
   */
  function defaultAgentOptions() {
    const service = ctx.get('agentDefaultModel')
    if (service === undefined || typeof service.currentSelection !== 'function') return undefined
    try {
      const selection = service.currentSelection()
      if (selection === null || typeof selection !== 'object') return undefined
      const provider = nonEmpty(selection.provider)
      const model = nonEmpty(selection.model)
      if (provider === undefined || model === undefined) return undefined
      const effort = nonEmpty(selection.reasoningEffort)
      return effort === undefined ? { provider, model } : { provider, model, reasoningEffort: effort }
    } catch (error) { return undefined }
  }

  /** 活的 agent 的模型（`provider/model`）；没有就是 null。 */
  function agentModelOf(agent) {
    if (agent === undefined || agent === null) return null
    let options
    try { options = agent.options } catch (error) { return null }
    if (options === null || typeof options !== 'object') return null
    const provider = nonEmpty(options.provider)
    const model = nonEmpty(options.model)
    if (provider === undefined || model === undefined) return null
    return provider + '/' + model
  }

  /**
   * 把一个会话变成在线 agent。
   *
   * 首选 GUI 自己的启动路径 `sessionController.ensureSession`（adopt 在线 / resume 冷会话 /
   * create 新会话，并负责把 preset 写进会话头）。但 `sessionController` 并不在 cordis 的公开
   * catalog 里，所以这里必须有一条**只依赖 catalog 内原语**的兜底：
   * `agents.create` / `agents.resume` + `agentPresets.mount` —— 这正是 api-session-controller
   * 内部那条路（`composeAgent()` = `installSelection` + `mount`，调用方再传 `agentOptions`）。
   */
  async function bringOnline(sessionId, cwd, presetId, creating) {
    // 已经在线就直接复用：`agents.resume()` 会尝试**再开一个写句柄**，而它已被现有 Agent 持有——
    // 实机错误：`session "…" is already owned by an active write handle`（用户在正开着的会话里建群时必踩）。
    if (liveAgent(sessionId) !== undefined) return 'already-live'
    const engine = controller()
    if (engine !== undefined && typeof engine.ensureSession === 'function') {
      await engine.ensureSession(sessionId, cwd, true, presetId)
      return 'sessionController'
    }
    const agentsService = agents()
    if (agentsService === undefined) throw new Error('agents 服务不可用，无法启动会话')
    const presetsService = presets()
    const setup = async (agentCtx) => { await presetsService.mount(agentCtx, presetId) }
    const agentOptions = defaultAgentOptions()
    const extra = agentOptions === undefined ? {} : { agentOptions }
    // 句柄必须留着：它是唯一能把这个 agent 从活会话表里摘掉的能力（解散时用）。
    const keep = (handle) => {
      if (handle !== undefined && handle !== null && typeof handle.dispose === 'function') ownedHandles.set(sessionId, handle)
      return handle
    }
    if (creating) {
      keep(await agentsService.create({ sessionId, meta: { cwd, agentPreset: presetId }, ...extra, setup }))
      return 'agents.create'
    }
    keep(await agentsService.resume({ resumeSessionId: sessionId, setup }))
    return 'agents.resume'
  }

  /**
   * 把群主 agent 从活会话表里摘掉——**只在我们持有句柄时**可行（GUI 自己 resume 的会话
   * 句柄在它手里，插件无权下线）。会话正在跑时不摘，避免打断用户的一轮。
   * @returns 'disposed' | 'not-owned' | 'running' | 'dispose-failed'
   */
  async function releaseOwnerAgent(groupId) {
    const handle = ownedHandles.get(groupId)
    if (handle === undefined) return 'not-owned'
    const agent = liveAgent(groupId)
    if (agent !== undefined && agent.status === 'running') return 'running'
    ownedHandles.delete(groupId)
    try {
      await handle.dispose()
      return 'disposed'
    } catch (error) {
      return 'dispose-failed'
    }
  }

  /**
   * 把群会话**归属**到它目录对应的工作区。
   *
   * 这是"群聊出现在左侧工作区下面"的唯一条件：工作区持有自己的 `sessionIds`，没归属的会话
   * 不在那棵树里（客户端把它显示为"未分组"）。注意两条 API 的区别：
   *   - `Workspace.attachSession(sessionId)` ← **归属**（会把会话插到列表最前）；
   *   - `Workspace.insertSessionBefore(sessionId, …)` ← 只重排**已归属**的会话，对外部会话报
   *     `the session is not accounted`（实机踩过）。
   * 目录不是工作区时如实返回错误，由调用方决定是否先创建/加入工作区。
   */
  /**
   * 建群（v2.2）：把一个**空会话**变成群聊。
   *
   * 空会话本来就是 GUI 建的、就挂在工作区下面，所以**不需要任何归属操作**；
   * 建群 = 启动它的 agent（沿用会话自己的 preset，避免冲突）→ 用空白的特权切到固定的
   * 群主 preset（`agentPresets.select`，非空白会抛 locked）→ 注册进面板 →
   * 标题改成 `👥 <名字>`，让它在侧边栏里**区别于普通会话**。
   *
   * **群主 preset 是固定的**（`DEFAULT_GROUP_PRESET` = 「群聊 Agent」）：它决定整群成员的
   * 能力上限，也是"盘点成员能力 + 派活"那套纪律的载体，所以调用方传进来的 `preset_id`
   * 一律忽略。会话一旦开始，`select` 会拒绝（locked），此时保留原 preset 并如实告知，
   * 不会让会话处于半途状态。
   * @param args - { session_id, name? }（`preset_id` 会被忽略）
   */
  async function createGroup(args) {
    const sessionId = nonEmpty(args && args.session_id) || nonEmpty(args && args.sessionId)
    if (sessionId === undefined) return { ok: false, error: '需要 session_id：请在一个空会话里创建群聊' }
    const sessionsService = sessions()
    if (sessionsService === undefined) return { ok: false, error: 'sessions 服务不可用' }
    let session
    try { session = sessionsService.get(sessionId) } catch (error) { session = undefined }
    if (session === undefined) return { ok: false, error: '会话不存在：' + sessionId + '（请先新建一个空会话）' }
    const header = session.header === undefined ? {} : session.header
    const cwd = nonEmpty(header.cwd)
    if (cwd === undefined) return { ok: false, error: '该会话没有工作目录，不能作为群聊' }
    const wanted = DEFAULT_GROUP_PRESET
    const available = await listPresets()
    if (available.length > 0 && !available.some((preset) => preset.id === wanted)) {
      return {
        ok: false,
        error: '群聊 preset「' + wanted + '」未安装：请把预设目录放到 ~/.dsh/.agent-presets/' + wanted + '/'
          + '（含 agent.cordis.yml 与 preset.yml），然后重启 DSH。'
      }
    }
    // 会话自己的 preset（头里记录的）：先按它启动，避免 assertPresetUnchanged 冲突，
    // 然后再用空白的特权换成固定的群主 preset。
    const ownPreset = nonEmpty(header.agentPreset)
    let agent
    try {
      agent = await bringOnline(sessionId, cwd, ownPreset, false)
    } catch (error) {
      return { ok: false, error: '会话无法启动：' + errMsg(error) }
    }
    agent = liveAgent(sessionId) || agent
    if (agent === undefined) return { ok: false, error: '会话没有上线' }
    const ownerModel = agentModelOf(agent)
    if (ownerModel === null) {
      return { ok: false, error: '会话的 agent 没有 provider/model（agent-default-model 设置缺失），不能作为群聊' }
    }

    const presetsService = presets()
    const composedPresetOf = (target) => {
      try { return presetsService === undefined ? undefined : presetsService.composedPreset(target.ctx) } catch (error) { return undefined }
    }
    const currentPreset = composedPresetOf(agent)
    let presetError
    if (wanted !== currentPreset) {
      try {
        await presetsService.select(agent, wanted)
      } catch (error) {
        presetError = errMsg(error)
      }
    }
    const finalPreset = composedPresetOf(liveAgent(sessionId)) || currentPreset || wanted

    const registry = readFile()
    // 已经是群就保留原有成员与创建时间（重复点「创建群聊」不该清空名册）。
    const existing = registry.groups[sessionId]
    const name = nonEmpty(args && args.name) || (existing !== undefined ? existing.name : nextGroupName(registry.groups))
    const group = {
      id: sessionId,
      name,
      cwd,
      presetId: finalPreset || wanted || DEFAULT_GROUP_PRESET,
      createdAt: existing !== undefined ? existing.createdAt : Date.now(),
      members: existing !== undefined ? existing.members : []
    }
    writeFile(putGroup(registry, group))
    await applyTitle(group, TITLE_PREFIX + group.name)
    return {
      ok: true,
      id: sessionId,
      name: group.name,
      title: TITLE_PREFIX + group.name,
      preset_id: group.presetId,
      cwd,
      owner_model: ownerModel,
      preset_error: presetError,
      capability_warning: capabilityWarning(group.presetId)
    }
  }

  /** 群名写进会话标题（群聊带 👥 前缀，在侧边栏里区别于普通会话）。 */
  async function applyTitle(group, titleOverride) {
    const service = sessionTitle()
    const sessionsService = sessions()
    if (service === undefined || sessionsService === undefined) return false
    const title = titleOverride === undefined ? group.name : titleOverride
    try {
      const session = sessionsService.get(group.id)
      if (session === undefined) return false
      service.rename(session, title)
      return true
    } catch (error) { return false }
  }

  async function renameGroup(args) {
    const id = nonEmpty(args && args.group_id) || nonEmpty(args && args.groupId)
    const name = nonEmpty(args && args.name)
    if (id === undefined || name === undefined) return { ok: false, error: '需要 group_id 与 name' }
    const registry = readFile()
    if (registry.groups[id] === undefined) return { ok: false, error: '群聊不存在：' + id }
    writeFile(updateGroup(registry, id, (group) => ({ ...group, name })))
    await applyTitle({ id, name }, TITLE_PREFIX + name)
    return { ok: true, id, name }
  }

  /** 确保群主 agent 在线（冷会话按它记录的 preset 恢复；全新 id 走 create 分支）。 */
  async function ensureGroupAgent(group) {
    let agent = liveAgent(group.id)
    if (agent === undefined) {
      await bringOnline(group.id, group.cwd, group.presetId, false)
      agent = liveAgent(group.id)
    }
    if (agent === undefined) throw new Error('群主会话没有上线')
    if (agentModelOf(agent) === null) {
      throw new Error('群主 agent 没有 provider/model（agent-default-model 设置缺失），成员会继承不到模型')
    }
    return agent
  }

  async function pull(args) {
    const id = nonEmpty(args && args.group_id) || nonEmpty(args && args.groupId)
    const presetId = nonEmpty(args && args.preset_id) || nonEmpty(args && args.presetId)
    if (id === undefined) return { ok: false, error: '需要 group_id' }
    if (presetId === undefined) return { ok: false, error: '需要 preset_id' }
    // 群聊 preset 是"群主"，不是成员：把它拉进群只会得到一个不肯干活的成员。
    if (presetId === DEFAULT_GROUP_PRESET) {
      return { ok: false, error: '群聊 preset「' + DEFAULT_GROUP_PRESET + '」是群主专用（负责盘点能力并派活），不能作为成员被拉进群' }
    }
    const registry = readFile()
    const group = registry.groups[id]
    if (group === undefined) return { ok: false, error: '群聊不存在：' + id }
    const available = await listPresets()
    const meta = available.find((preset) => preset.id === presetId)
    if (available.length > 0 && meta === undefined) return { ok: false, error: 'preset 不存在：' + presetId }
    const service = subagents()
    if (service === undefined) return { ok: false, error: 'subagents 服务不可用' }

    let parent
    try {
      parent = await ensureGroupAgent(group)
    } catch (error) {
      return { ok: false, error: '群主会话不可用：' + errMsg(error) }
    }
    // 拉人时顺手把群主会话的标题自愈成 👥 前缀（老群第一次在线时补上）。
    ensureTitle(group)

    const persona = await extractPersona({ read: (preset) => presets().read(preset), list: listPresets }, presetId)
    const taken = takenMemberNames(group)
    const existing = await childrenOf(group.id)
    for (const row of existing) taken.push(row.name)
    const explicit = nonEmpty(args && args.name)
    let name
    if (explicit !== undefined) {
      if (taken.indexOf(explicit) >= 0) return { ok: false, error: '成员名「' + explicit + '」已被占用' }
      name = explicit
    } else {
      name = dedupeName(String((meta && meta.name) || presetId), taken)
    }

    const notice = memberNotice({ groupName: group.name, memberName: name, groupId: group.id })
    // 第一轮只能是握手（startContinuable 投递即开轮）：把它说成"没任务"，成员才不会自发干活。
    const welcome = memberWelcome({ groupName: group.name, memberName: name, presetId })
    const spec = (deny) => ({
      provider: 'spawn',
      label: name,
      signal: makeSignal(),
      request: {
        prompt: [{ type: 'text', text: welcome }],
        parent,
        persona: persona + '\n\n' + notice,
        toolFilter: { deny },
        maxDepth: 1
      }
    })

    let started
    let degraded = false
    let denied = MEMBER_TOOL_DENY.join(', ')
    try {
      try {
        started = await service.startContinuable(spec(MEMBER_TOOL_DENY))
      } catch (error) {
        const message = errMsg(error)
        if (message.indexOf('restrict()') < 0) throw error
        const known = knownToolNamesFrom(message)
        const filtered = (known === undefined ? FALLBACK_DENY : MEMBER_TOOL_DENY.filter((tool) => known.has(tool)))
        started = await service.startContinuable(spec(filtered))
        degraded = true
        denied = filtered.join(', ')
      }
    } catch (error) {
      return { ok: false, error: '拉人失败：' + errMsg(error) }
    }

    const memberId = String(started.childId)
    writeFile(putMember(readFile(), group.id, { childId: memberId, name, presetId, addedAt: Date.now() }))
    return {
      ok: true,
      group_id: group.id,
      member_id: memberId,
      name,
      preset_id: presetId,
      denied,
      warning: degraded
        ? '目标会话的工具域里没有 ' + MEMBER_TOOL_DENY.join('/') + ' 全部条目，成员黑名单已裁剪为：' + denied
        : undefined,
      capability: '成员工具面 = 群主 preset（' + group.presetId + '）∩ 黑名单（' + denied + '）；人格来自 preset ' + presetId
    }
  }

  async function release(args) {
    const id = nonEmpty(args && args.group_id) || nonEmpty(args && args.groupId)
    const memberId = nonEmpty(args && args.member_id) || nonEmpty(args && args.memberId)
    if (id === undefined || memberId === undefined) return { ok: false, error: '需要 group_id 与 member_id' }
    const registry = readFile()
    const group = registry.groups[id]
    if (group === undefined) return { ok: false, error: '群聊不存在：' + id }
    const member = group.members.find((row) => row.childId === memberId)
    const agent = liveAgent(id)
    let released = false
    if (agent !== undefined) {
      const service = subagents()
      if (service === undefined) return { ok: false, error: 'subagents 服务不可用' }
      try {
        await service.drainContinuableChildren(agent, [memberId])
        released = true
      } catch (error) {
        return { ok: false, error: '释放子代理失败：' + errMsg(error) }
      }
    }
    writeFile(markMemberRemoved(readFile(), id, memberId, Date.now()))
    return {
      ok: true,
      group_id: id,
      member_id: memberId,
      name: member === undefined ? memberId : member.name,
      released,
      note: released ? undefined : '群主会话不在线：已只从名册标记移除，子代理本身未驻留'
    }
  }

  async function restore(args) {
    const id = nonEmpty(args && args.group_id) || nonEmpty(args && args.groupId)
    const memberId = nonEmpty(args && args.member_id) || nonEmpty(args && args.memberId)
    if (id === undefined || memberId === undefined) return { ok: false, error: '需要 group_id 与 member_id' }
    const registry = readFile()
    if (registry.groups[id] === undefined) return { ok: false, error: '群聊不存在：' + id }
    writeFile(markMemberRestored(readFile(), id, memberId))
    return { ok: true, group_id: id, member_id: memberId }
  }

  /**
   * 启动自愈：把注册表里所有**在线**群会话的标题补成 `👥 <群名>`。
   * 插件加载时跑一次（fire-and-forget）；冷会话跳过，等它上线后的下一次自愈补上。
   */
  async function repairTitles() {
    const registry = readFile()
    let renamed = 0
    for (const id of Object.keys(registry.groups)) {
      try { if (ensureTitle(registry.groups[id])) renamed += 1 } catch (error) { /* 单个失败不影响其他 */ }
    }
    return renamed
  }

  /**
   * 解散：释放所有成员 → 归档群主会话 → 删注册表记录。
   *
   * 顺序有意为之：先 drain 成员（成员是**续存型子代理**，不释放就会一直挂在进程里），
   * 再尝试把群主 agent 也下线（只有我们自己拉上来时才持有句柄）。
   *
   * 这两步都是为了后面"在设置里彻底删除"能成功：归档/删除插件把**进程内 live 的会话**
   * 视作受保护（`attached`），且"族里有受保护成员就整族跳过"，所以只要群主或任一成员
   * 还 live，父会话与成员会话就都删不掉。返回值里的 `owner_live` / `delete_hint` 会如实
   * 告诉用户还需不需要重启。
   */
  async function dissolve(args) {
    const id = nonEmpty(args && args.group_id) || nonEmpty(args && args.groupId)
    if (id === undefined) return { ok: false, error: '需要 group_id' }
    const registry = readFile()
    const group = registry.groups[id]
    if (group === undefined) return { ok: false, error: '群聊不存在：' + id }
    const agent = liveAgent(id)
    const service = subagents()
    let drained = 0
    if (agent !== undefined && service !== undefined) {
      const ids = activeMembers(group).map((member) => member.childId)
      if (ids.length > 0) {
        try {
          await service.drainContinuableChildren(agent, ids)
          drained = ids.length
        } catch (error) {
          return { ok: false, error: '释放成员失败，未解散：' + errMsg(error) }
        }
      }
    }
    const ownerReleased = await releaseOwnerAgent(id)
    let archived = false
    const workspaces = ctx.get('workspaceRegistry')
    if (workspaces !== undefined && typeof workspaces.archiveSession === 'function') {
      try {
        await workspaces.archiveSession(id)
        archived = true
      } catch (error) { archived = false }
    }
    writeFile(removeGroup(readFile(), id))
    const ownerLive = liveAgent(id) !== undefined
    return {
      ok: true,
      group_id: id,
      name: group.name,
      drained,
      archived,
      owner_released: ownerReleased,
      owner_live: ownerLive,
      // 群主还 live 时，"设置 → 会话归档"的删除会把它跳过（连成员一起保），说清楚怎么办。
      delete_hint: ownerLive
        ? '群主会话仍在 DSH 进程里（不是我们拉上线的，插件无权下线）：要在「设置 → 会话归档」里彻底删除它，先重启一次 DSH 且不要再打开这个会话。'
        : undefined
    }
  }

  /** `@` 菜单用：某个会话自己的常驻成员。 */
  async function members(args) {
    const sessionId = nonEmpty(args && args.sessionId) || nonEmpty(args && args.session_id)
    if (sessionId === undefined) return { ok: false, error: '需要 sessionId', members: [] }
    return { ok: true, sessionId, members: await childrenOf(sessionId) }
  }

  /**
   * 这个会话是不是我方注册的群。派活拦截（./dispatch.js）用它把"群里 @ 成员"与
   * "别处的普通 @ 引用"区分开——只读注册表，不碰任何服务。
   */
  function isGroup(sessionId) {
    const id = nonEmpty(sessionId)
    if (id === undefined) return false
    try { return readFile().groups[id] !== undefined } catch (error) { return false }
  }

  return { state, createGroup, renameGroup, pull, release, restore, dissolve, repairTitles, members, isGroup, file }
}
