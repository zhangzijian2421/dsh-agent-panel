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
 *   - 频道       → 群主会话自己的记录（成员 `send_message` 给父会话，原生落进上下文）
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

import { randomUUID } from 'node:crypto'
import {
  DEFAULT_GROUP_PRESET,
  GROUP_ID_PREFIX,
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
 * 成员不该再拉人（`group_pull`）、不该枚举/打断别的成员（`list_agents`/`interrupt_agent`）、
 * 也不该越过群主直接问人类（`ask_user_question`）。
 */
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

const BS = '\\'
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

/** 成员的入群说明：怎么汇报、为什么不能直接找其他成员。 */
export function memberNotice(input) {
  return '你现在是聊天群「' + input.groupName + '」的成员，群内名字「' + input.memberName + '」，'
    + '群主会话 id 是 ' + input.groupId + '（就是你现在的直接父代理）。\n'
    + '汇报方式：用 send_message(agent_id="' + input.groupId + '") 把进展与结论发给群主；群主会转达给其他成员。\n'
    + 'DSH 不允许兄弟会话之间直接互发，所以不要试图直接联系其他成员，也不要再拉新人进来。\n'
    + '收到群主派活后先动手，完成后先 send_message 汇报，再结束本轮。'
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
    if (creating) {
      await agentsService.create({ sessionId, meta: { cwd, agentPreset: presetId }, ...extra, setup })
      return 'agents.create'
    }
    await agentsService.resume({ resumeSessionId: sessionId, setup })
    return 'agents.resume'
  }

  async function createGroup(args) {
    let cwd = nonEmpty(args && args.cwd)
    // 浏览器不知道自己的 cwd，所以允许只给 session_id，由宿主从会话头解析。
    if (cwd === undefined) {
      const sessionId = nonEmpty(args && args.session_id) || nonEmpty(args && args.sessionId)
      const sessionsService = sessions()
      if (sessionId !== undefined && sessionsService !== undefined) {
        try {
          const session = sessionsService.get(sessionId)
          const header = session === undefined ? undefined : session.header
          cwd = header === undefined ? undefined : nonEmpty(header.cwd)
        } catch (error) { cwd = undefined }
      }
    }
    if (cwd === undefined) return { ok: false, error: '无法确定工作目录（需要 cwd 或可解析 cwd 的 session_id）' }
    const wanted = nonEmpty(args && args.preset_id) || nonEmpty(args && args.presetId) || DEFAULT_GROUP_PRESET
    const available = await listPresets()
    if (available.length > 0 && !available.some((preset) => preset.id === wanted)) {
      return { ok: false, error: 'preset 不存在：' + wanted }
    }
    const id = GROUP_ID_PREFIX + randomUUID()
    let startedVia
    try {
      startedVia = await bringOnline(id, cwd, wanted, true)
    } catch (error) {
      return { ok: false, error: '创建群聊会话失败：' + errMsg(error) }
    }
    // 没有模型的群主 agent 是残的（成员会继承不到 provider/model）。只有"agent 确实存在却没模型"
    // 才算坏；`agents.get` 一时读不到不能把好群归档掉。
    const createdAgent = liveAgent(id)
    const ownerModel = agentModelOf(createdAgent)
    if (createdAgent !== undefined && ownerModel === null) {
      const workspaces = ctx.get('workspaceRegistry')
      if (workspaces !== undefined && typeof workspaces.archiveSession === 'function') {
        try { await workspaces.archiveSession(id) } catch (error) { /* 归档失败不影响报错 */ }
      }
      return {
        ok: false,
        started_via: startedVia,
        error: '群主会话建出来了但 agent 没有 provider/model（agent-default-model 设置缺失或未生效），已归档，请检查设置后重试。'
      }
    }
    const registry = readFile()
    const group = {
      id,
      name: nonEmpty(args && args.name) || nextGroupName(registry.groups),
      cwd,
      presetId: wanted,
      createdAt: Date.now(),
      members: []
    }
    writeFile(putGroup(registry, group))
    await applyTitle(group)
    return {
      ok: true,
      id,
      name: group.name,
      preset_id: wanted,
      cwd,
      started_via: startedVia,
      owner_model: ownerModel,
      capability_warning: capabilityWarning(wanted)
    }
  }

  /** 群名同时写进会话标题，这样会话列表里看到的就是"群聊 · N"。 */
  async function applyTitle(group) {
    const service = sessionTitle()
    const sessionsService = sessions()
    if (service === undefined || sessionsService === undefined) return false
    try {
      const session = sessionsService.get(group.id)
      if (session === undefined) return false
      service.rename(session, group.name)
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
    await applyTitle({ id, name })
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
    const spec = (deny) => ({
      provider: 'spawn',
      label: name,
      signal: makeSignal(),
      request: {
        prompt: [{ type: 'text', text: '欢迎「' + name + '」加入群聊「' + group.name + '」。\n' + notice }],
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

  /** 解散：释放所有成员 → 归档群主会话 → 删注册表记录。 */
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
    let archived = false
    const workspaces = ctx.get('workspaceRegistry')
    if (workspaces !== undefined && typeof workspaces.archiveSession === 'function') {
      try {
        await workspaces.archiveSession(id)
        archived = true
      } catch (error) { archived = false }
    }
    writeFile(removeGroup(readFile(), id))
    return { ok: true, group_id: id, name: group.name, drained, archived }
  }

  /** `@` 菜单用：某个会话自己的常驻成员。 */
  async function members(args) {
    const sessionId = nonEmpty(args && args.sessionId) || nonEmpty(args && args.session_id)
    if (sessionId === undefined) return { ok: false, error: '需要 sessionId', members: [] }
    return { ok: true, sessionId, members: await childrenOf(sessionId) }
  }

  return { state, createGroup, renameGroup, pull, release, restore, dissolve, members, file }
}
