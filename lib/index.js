/**
 * dsh-agent-panel — 「拉 Agent 进会话」面板的宿主半边。
 *
 * 能力：
 *  - GET  /api/dsh-agent-panel/state  枚举在线会话（每个会话一个可选目标），合并
 *    名册成员与实时子代理，附聊天群频道消息与已安装 preset 列表。
 *  - POST /api/dsh-agent-panel/pull   把一个已安装 preset 拉成目标会话的常驻子代理：
 *    人格取自该 preset 组合，成员名自动去重，maxDepth=1，工具黑名单按目标会话
 *    工具域自动降级；聊天群会话（名册归属匹配）额外同步 roster.json 与 chat.log。
 *  - POST /api/dsh-agent-panel/retire 移出成员：聊天群改名册 + 落频道系统消息，
 *    一律回收子代理；名册写入失败则完全不改动。
 *  - 模型工具 agrp_pull：与 pull 路由同一套逻辑，供 agent 侧直接调用。
 *
 * 仅注入 webServer（硬依赖）；fs / sessions / agents / subagents / agentPresets
 * 一律 ctx.get 判空访问，缺失时在对应路由里报错，不因硬依赖卡住挂载。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const GROUP_DIR = '.agent-group'
const GROUP_NAME = '多 Agent 聊天群'
const EXCLUDED_PRESETS = ['agent-chat-group']
const MEMBER_TOOL_DENY = ['group_invite', 'group_list_presets', 'list_agents', 'interrupt_agent', 'ask_user_question']
const FALLBACK_DENY = ['list_agents', 'interrupt_agent', 'ask_user_question']

const NL = '\n'
const BS = '\\'

/** Child ids retired through this panel, per owner, persisted across restarts: the durable
 *  subagent catalog keeps listing released children forever (cold-resume is by design and
 *  has no delete primitive), so hiding them needs an owned `owner:child` tombstone store. */
const RETIRED_FILE = join(homedir(), '.dsh', 'dsh-agent-panel-retired.json')
const tombstone = (ownerId, childId) => ownerId + ':' + childId
const retired = new Set(readRetiredIds())

function readRetiredIds() {
	try {
		const parsed = JSON.parse(readFileSync(RETIRED_FILE, 'utf8'))
		return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string' && x.includes(':')) : []
	} catch (error) {
		return []
	}
}

function persistRetired() {
	try {
		mkdirSync(dirname(RETIRED_FILE), { recursive: true })
		writeFileSync(RETIRED_FILE, JSON.stringify([...retired], null, 2) + '\n', 'utf8')
	} catch (error) {
		console.error('dsh-agent-panel: persist retired ids failed: ' + errMsg(error))
	}
}

const errMsg = (error) => String((error && error.message) || error)
const nonEmpty = (value) => (typeof value === 'string' && value.length > 0 ? value : undefined)
const sepOf = (path) => (path.indexOf(BS) >= 0 ? BS : '/')
const joinPath = (base, name) => (base.endsWith('/') || base.endsWith(BS) ? base + name : base + sepOf(base) + name)

/**
 * The dynamic Host sandbox exposes no AbortController, yet subagents.startContinuable
 * requires a signal. dsh-subagent only ever calls throwIfAborted(), reads aborted, and
 * adds/removes an 'abort' listener, so a duck-typed never-aborting signal suffices.
 */
function makeSignal() {
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
    dispatchEvent() { return true },
  }
  return signal
}

/**
 * tools.restrict() validates deny names against the parent session's tool scope and its
 * rejection message enumerates exactly that set. Parse it; tools.schemas() from this
 * plugin's own scope is far narrower and would wrongly strip every name.
 */
function knownToolNamesFrom(message) {
  const marker = 'known global tools: '
  const at = message.indexOf(marker)
  if (at < 0) return undefined
  const names = new Set()
  for (const piece of message.slice(at + marker.length).split(',')) {
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

/** Column-0 `- id: <value>` row id, or undefined for anything else (incl. nested config rows). */
function rowIdOf(line) {
  if (line.slice(0, 2) !== '- ') return undefined
  const rest = line.slice(2)
  if (rest.slice(0, 3) !== 'id:') return undefined
  return rest.slice(3).trim()
}

/** Extract the persona row's `prefix:` literal/folded block (`|`, `|-`, `|+`, `>`, `>-`, `>+`). */
function parsePersonaPrefix(content) {
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
    const out = block.map((line) => (line === '' ? '' : line.slice(min))).join('\n').trim()
    if (out) return out
  }
  return null
}

async function extractPersona(agentPresets, presetId) {
  const content = await agentPresets.read(presetId)
  const block = parsePersonaPrefix(content)
  if (block) return block
  const list = await agentPresets.list()
  const meta = list.find((item) => item.id === presetId)
  return '你是「' + ((meta && meta.name) || presetId) + '」的成员。\n' + ((meta && meta.description) || '') + '\n你的身份来自已安装 preset "' + presetId + '"。'
}

async function readTextIfExists(fs, path) {
  let target
  try { target = await fs.resolve(path, {}) } catch (error) { return undefined }
  try { return await fs.readText(target) } catch (error) { return undefined }
}

function parseRoster(raw) {
  if (raw === undefined) return undefined
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return { owner: null, members: [] }
    return {
      owner: parsed.owner && typeof parsed.owner === 'object' ? parsed.owner : null,
      members: Array.isArray(parsed.members) ? parsed.members : [],
    }
  } catch (error) {
    return { owner: null, members: [] }
  }
}

async function readRoster(fs, cwd) {
  return parseRoster(await readTextIfExists(fs, joinPath(joinPath(cwd, GROUP_DIR), 'roster.json')))
}

/**
 * A roster belongs to exactly the session that created it. Same-workspace sessions share
 * the cwd, so without this check every session there would claim the group's roster and
 * silently redirect its pulls into the group owner session.
 */
async function readOwnedRoster(fs, cwd, sessionId) {
  const roster = await readRoster(fs, cwd)
  if (roster === undefined) return undefined
  const ownerId = roster.owner && typeof roster.owner.id === 'string' ? roster.owner.id : undefined
  return ownerId === sessionId ? roster : undefined
}

async function readChat(fs, cwd, limit) {
  const raw = await readTextIfExists(fs, joinPath(joinPath(cwd, GROUP_DIR), 'chat.log'))
  if (raw === undefined) return []
  const rows = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    try {
      const obj = JSON.parse(line)
      if (!obj || typeof obj !== 'object') continue
      rows.push({
        seq: typeof obj.seq === 'number' ? obj.seq : rows.length + 1,
        kind: typeof obj.kind === 'string' ? obj.kind : 'message',
        speaker: typeof obj.speaker === 'string' ? obj.speaker : '',
        text: typeof obj.text === 'string' ? obj.text : '',
      })
    } catch (error) { /* skip a corrupt line */ }
  }
  return rows.slice(-limit)
}

function dedupeName(base, taken) {
  if (taken.indexOf(base) < 0) return base
  let n = 2
  while (taken.indexOf(base + '-' + n) >= 0) n += 1
  return base + '-' + n
}

/**
 * The fs backend's default write policy denied dot-prefixed group paths, so state the
 * policy explicitly: workspace-write fenced at the group workspace first, and only if
 * that is refused, the same write under danger-full-access. Returns the first error
 * when escalation was needed, undefined on a clean first write.
 */
async function writeTextFenced(fs, target, content, cwd, ownerId) {
  const primary = { mode: 'workspace-write', workspaceRoot: cwd }
  if (ownerId !== undefined) primary.sessionId = ownerId
  try {
    await fs.writeText(target, content, undefined, undefined, primary)
    return undefined
  } catch (error) {
    const first = errMsg(error)
    const escalated = { mode: 'danger-full-access', workspaceRoot: cwd }
    if (ownerId !== undefined) escalated.sessionId = ownerId
    await fs.writeText(target, content, undefined, undefined, escalated)
    return first
  }
}

async function nextChatSeq(fs, cwd) {
  const raw = await readTextIfExists(fs, joinPath(joinPath(cwd, GROUP_DIR), 'chat.log'))
  if (raw === undefined) return { prefix: '', seq: 1 }
  let seq = 1
  for (const line of raw.split('\n')) { if (line.trim() !== '') seq += 1 }
  return { prefix: raw, seq }
}

/**
 * Members of one owner session. A chat-group session is authoritative: the roster alone
 * (live children only contribute running/idle status). A plain session shows its live
 * continuable children minus everything retired through this panel.
 */
async function membersOf(subagents, agents, roster, ownerId) {
  const children = new Map()
  if (subagents !== undefined && ownerId !== undefined) {
    try {
      const rows = await subagents.listChildren(ownerId)
      for (const row of rows) {
        if (!row || row.kind !== 'child') continue
        children.set(String(row.id), {
          label: row.label !== undefined && row.label !== null ? String(row.label) : '',
          status: row.activity === 'running' ? 'running' : 'idle',
        })
      }
    } catch (error) { /* listing unavailable */ }
  }

  const members = []
  const removed = []
  if (roster !== undefined) {
    for (const member of (roster.members || [])) {
      const child = children.get(String(member.id))
      members.push({
        id: String(member.id),
        name: String(member.name),
        preset_id: String(member.preset_id || ''),
        status: child !== undefined ? child.status : 'ready',
      })
    }
  } else if (ownerId !== undefined) {
    for (const [id, child] of children) {
      if (retired.has(tombstone(ownerId, id))) continue
      members.push({ id, name: child.label || id, preset_id: '', status: child.status })
    }
  }
  // Removed markers apply to every session type: catalog children carrying a tombstone,
  // surfaced separately so the user can tell released history from active members.
  if (ownerId !== undefined) {
    for (const [id, child] of children) {
      if (!retired.has(tombstone(ownerId, id))) continue
      removed.push({ id, name: child.label || id })
    }
  }

  let ownerLive = false
  if (ownerId !== undefined && agents !== undefined) {
    try { ownerLive = agents.get(ownerId) !== undefined } catch (error) { ownerLive = false }
  }
  return { members, removed, ownerLive }
}

function makeService(ctx) {
  async function state() {
    const fs = ctx.get('fs')
    const sessions = ctx.get('sessions')
    const agents = ctx.get('agents')
    const agentPresets = ctx.get('agentPresets')
    const subagents = ctx.get('subagents')

    const groups = []
    if (sessions !== undefined) {
      const seen = new Set()
      let live = []
      try { live = sessions.list() } catch (error) { live = [] }
      for (const session of live) {
        let cwd
        let origin
        let sessionId
        try { sessionId = String(session.id) } catch (error) { sessionId = undefined }
        try { cwd = session.header && session.header.cwd } catch (error) { cwd = undefined }
        try { origin = session.header && session.header.origin } catch (error) { origin = undefined }
        if (sessionId === undefined || typeof cwd !== 'string' || cwd.length === 0) continue
        if (origin === 'subagent') continue
        if (seen.has(sessionId)) continue
        seen.add(sessionId)
        let roster
        if (fs !== undefined) {
          try { roster = await readOwnedRoster(fs, cwd, sessionId) } catch (error) { roster = undefined }
        }
        const merged = await membersOf(subagents, agents, roster, sessionId)
        groups.push({
          session_id: sessionId,
          cwd,
          owner_id: sessionId,
          owner_name: (roster && roster.owner && roster.owner.name) || '主持人',
          owner_live: merged.ownerLive,
          has_roster: roster !== undefined,
          members: merged.members,
          removed: merged.removed,
          messages: roster !== undefined && fs !== undefined ? await readChat(fs, cwd, 12) : [],
        })
      }
    }

    let presets = []
    if (agentPresets !== undefined) {
      try {
        const list = await agentPresets.list()
        presets = list
          .filter((item) => EXCLUDED_PRESETS.indexOf(item.id) < 0)
          .map((item) => ({
            id: item.id,
            name: item.name || item.id,
            description: item.description || '',
            trust: item.trust || '',
          }))
      } catch (error) { presets = [] }
    }

    return {
      groups,
      presets,
      caps: {
        fs: fs !== undefined,
        sessions: sessions !== undefined,
        agents: agents !== undefined,
        subagents: subagents !== undefined,
        agentPresets: agentPresets !== undefined,
      },
    }
  }

  async function pull(args) {
    const presetId = nonEmpty(args && args.presetId)
    if (presetId === undefined) return { ok: false, error: '拉取需要 presetId' }

    const fs = ctx.get('fs')
    const agents = ctx.get('agents')
    const sessions = ctx.get('sessions')
    const subagents = ctx.get('subagents')
    const agentPresets = ctx.get('agentPresets')
    if (agents === undefined) return { ok: false, error: 'agents 服务不可用' }
    if (subagents === undefined) return { ok: false, error: 'subagents 服务不可用' }
    if (agentPresets === undefined) return { ok: false, error: 'agentPresets 服务不可用' }

    const ownerId = nonEmpty(args && args.ownerId) || nonEmpty(args && args.sessionId)
    if (ownerId === undefined) return { ok: false, error: '找不到目标会话 id' }

    let cwd = nonEmpty(args && args.cwd)
    if (cwd === undefined && sessions !== undefined) {
      try {
        const session = sessions.get(ownerId)
        cwd = session && session.header && session.header.cwd
      } catch (error) { cwd = undefined }
    }
    if (typeof cwd !== 'string' || cwd.length === 0) return { ok: false, error: '无法确定目标会话的工作目录' }

    let roster
    if (fs !== undefined) {
      try { roster = await readOwnedRoster(fs, cwd, ownerId) } catch (error) { roster = undefined }
    }
    const isGroup = roster !== undefined

    let parent
    try { parent = agents.get(ownerId) } catch (error) { parent = undefined }
    if (parent === undefined) return { ok: false, error: '目标会话不在线（' + ownerId + '）：请先在浏览器里打开它' }

    let available = []
    try { available = await agentPresets.list() } catch (error) { return { ok: false, error: '读取 preset 列表失败：' + errMsg(error) } }
    const meta = available.find((item) => item.id === presetId)
    if (meta === undefined) return { ok: false, error: 'preset 不存在：' + presetId }

    let personaText
    try { personaText = await extractPersona(agentPresets, presetId) } catch (error) { return { ok: false, error: '读取 preset 人格失败：' + errMsg(error) } }

    const taken = ((roster && roster.members) || []).map((member) => String(member.name))
    try {
      const rows = await subagents.listChildren(ownerId)
      for (const row of rows) {
        if (!row || row.kind !== 'child') continue
        if (retired.has(tombstone(ownerId, String(row.id)))) continue
        if (row.label !== undefined && row.label !== null) taken.push(String(row.label))
      }
    } catch (error) { /* dedupe degrades gracefully */ }
    const explicit = nonEmpty(args && args.name)
    let name
    if (explicit !== undefined) {
      if (taken.indexOf(explicit) >= 0) return { ok: false, error: '成员名「' + explicit + '」已被占用' }
      name = explicit
    } else {
      name = dedupeName(String(meta.name || presetId), taken)
    }

    const ownerLabel = (roster && roster.owner && roster.owner.name) || '主持人'
    const joinNotice = '你现在是「' + GROUP_NAME + '」群聊成员，群内名字「' + name + '」。用 group_send 发言（mentions 可 @ 成员或「' + ownerLabel + '」）、group_read 看频道、group_members 看成员。你不能直接给其他成员发消息；被 @ 时主持人会用 send_message 唤醒你，届时先 group_read 补上下文再干活。完成后 group_send 把结论发频道并 @ 相关人，再 send_message 向主持人（agent_id=' + ownerId + '）简短汇报。不要用 group_invite/group_list_presets。'
    const plainNotice = '你是「' + name + '」，由主持人通过前端面板拉进本会话协作。先补看会话上下文，按主持人指示干活；完成后 send_message 向主持人（agent_id=' + ownerId + '）简报结论。'
    const notice = isGroup ? joinNotice : plainNotice
    const welcome = '欢迎「' + name + '」。主持人 id：' + ownerId + '。\n' + notice
    const persona = personaText + '\n\n' + notice
    const startSpec = (denyNames) => ({
      provider: 'spawn',
      label: name,
      signal: makeSignal(),
      request: {
        prompt: [{ type: 'text', text: welcome }],
        parent,
        persona,
        toolFilter: { deny: denyNames },
        maxDepth: 1,
      },
    })

    let childId
    let degraded = false
    let denied = MEMBER_TOOL_DENY.join(', ')
    try {
      let started
      try {
        started = await subagents.startContinuable(startSpec(MEMBER_TOOL_DENY))
      } catch (error) {
        const message = errMsg(error)
        if (message.indexOf('restrict()') < 0) throw error
        const known = knownToolNamesFrom(message)
        const filtered = (known !== undefined
          ? MEMBER_TOOL_DENY.filter((toolName) => known.has(toolName))
          : FALLBACK_DENY).filter((toolName) => toolName !== 'group_invite' && toolName !== 'group_list_presets')
        started = await subagents.startContinuable(startSpec(filtered))
        degraded = true
        denied = filtered.join(', ')
      }
      childId = String(started.childId)
    } catch (error) {
      return { ok: false, error: '拉人失败：' + errMsg(error) }
    }

    const notes = []
    // In a plain session the member never had group tools at all, so dropping those two
    // names is lossless and expected — only a chat-group target losing them is a real leak.
    if (degraded && isGroup) {
      notes.push('警告：聊天群会话的工具域未识别 group_invite/group_list_presets，成员黑名单已裁剪为：' + denied + '。该成员可能可以继续拉人，建议改用群内 group_invite 重新拉取。')
    }

    // Only chat-group sessions keep roster/channel files; plain sessions stay file-free.
    if (isGroup && fs !== undefined) {
      try {
        const dir = joinPath(cwd, GROUP_DIR)
        const rosterTarget = await fs.resolve(joinPath(dir, 'roster.json'), {})
        const nextRoster = {
          owner: { id: ownerId, name: ownerLabel },
          members: (roster.members || []).concat([{ id: childId, name, preset_id: presetId, invited_at: Date.now() }]),
        }
        const firstError = await writeTextFenced(fs, rosterTarget, JSON.stringify(nextRoster, null, 2) + '\n', cwd, ownerId)
        if (firstError !== undefined) notes.push('名册写入经沙箱升级完成（首次拒绝：' + firstError + '）')

        const chat = await nextChatSeq(fs, cwd)
        const chatTarget = await fs.resolve(joinPath(dir, 'chat.log'), {})
        const entry = JSON.stringify({ kind: 'system', seq: chat.seq, ts: Date.now(), text: name + ' 加入群聊（前端面板拉入）' }) + '\n'
        const chatError = await writeTextFenced(fs, chatTarget, chat.prefix + entry, cwd, ownerId)
        if (chatError !== undefined && firstError === undefined) notes.push('频道写入经沙箱升级完成（首次拒绝：' + chatError + '）')
      } catch (error) {
        notes.push('成员已拉起，但名册/频道写入失败：' + errMsg(error))
      }
    }

    const result = { ok: true, member_id: childId, name, preset_id: presetId, group: isGroup }
    if (notes.length > 0) result.warning = notes.join('；')
    return result
  }

  async function retire(args) {
    const memberId = nonEmpty(args && args.memberId)
    if (memberId === undefined) return { ok: false, error: '移出需要 memberId' }

    const fs = ctx.get('fs')
    const agents = ctx.get('agents')
    const sessions = ctx.get('sessions')
    const subagents = ctx.get('subagents')
    if (subagents === undefined) return { ok: false, error: 'subagents 服务不可用' }

    const ownerId = nonEmpty(args && args.ownerId) || nonEmpty(args && args.sessionId)
    if (ownerId === undefined) return { ok: false, error: '找不到目标会话 id' }

    let cwd = nonEmpty(args && args.cwd)
    if (cwd === undefined && sessions !== undefined) {
      try {
        const session = sessions.get(ownerId)
        cwd = session && session.header && session.header.cwd
      } catch (error) { cwd = undefined }
    }

    let roster
    if (cwd !== undefined && fs !== undefined) {
      try { roster = await readOwnedRoster(fs, cwd, ownerId) } catch (error) { roster = undefined }
    }

    const member = roster !== undefined
      ? (roster.members || []).find((item) => String(item.id) === memberId)
      : undefined
    const name = member !== undefined ? String(member.name) : memberId
    const notes = []

    if (roster !== undefined && fs !== undefined) {
      const ownerLabel = (roster.owner && roster.owner.name) || '主持人'
      const remaining = (roster.members || []).filter((item) => String(item.id) !== memberId)
      try {
        const dir = joinPath(cwd, GROUP_DIR)
        const rosterTarget = await fs.resolve(joinPath(dir, 'roster.json'), {})
        const nextRoster = {
          owner: { id: ownerId, name: ownerLabel },
          members: remaining,
        }
        const rosterError = await writeTextFenced(fs, rosterTarget, JSON.stringify(nextRoster, null, 2) + '\n', cwd, ownerId)
        if (rosterError !== undefined) notes.push('名册写入经沙箱升级完成（首次拒绝：' + rosterError + '）')

        const chat = await nextChatSeq(fs, cwd)
        const chatTarget = await fs.resolve(joinPath(dir, 'chat.log'), {})
        const entry = JSON.stringify({ kind: 'system', seq: chat.seq, ts: Date.now(), text: name + ' 移出群聊' }) + '\n'
        const chatError = await writeTextFenced(fs, chatTarget, chat.prefix + entry, cwd, ownerId)
        if (chatError !== undefined && rosterError === undefined) notes.push('频道写入经沙箱升级完成（首次拒绝：' + chatError + '）')
      } catch (error) {
        return { ok: false, error: '移出失败（名册未改动）：' + errMsg(error) }
      }
    }

    let parent
    try { parent = agents === undefined ? undefined : agents.get(ownerId) } catch (error) { parent = undefined }
    if (parent !== undefined) {
      try { await subagents.drainContinuableChildren(parent, [memberId]) } catch (error) {
        notes.push('成员代理回收失败（不影响名册）：' + errMsg(error))
      }
    } else {
      notes.push('目标会话不在线，代理将在其会话结束时回收')
    }
    retired.add(tombstone(ownerId, memberId))
    persistRetired()

    const result = { ok: true, name }
    if (notes.length > 0) result.warning = notes.join('；')
    return result
  }

  /** Un-hide a retired member: drop the tombstone; the released agent itself is untouched
   *  (it stays released until something explicitly messages it, which cold-resumes it). */
  async function restore(args) {
    const memberId = nonEmpty(args && args.memberId)
    const ownerId = nonEmpty(args && args.ownerId) || nonEmpty(args && args.sessionId)
    if (memberId === undefined || ownerId === undefined) return { ok: false, error: '恢复需要 sessionId 与 memberId' }
    if (!retired.delete(tombstone(ownerId, memberId))) return { ok: false, error: '该成员不在已移除列表' }
    persistRetired()
    return { ok: true }
  }

  /**
   * One session's subagents, named by their agent label (the name they were pulled under),
   * minus everything retired here. Backs the client `@` source that lists a session's own
   * agents, so the menu can offer agent names instead of session titles.
   */
  async function subagents(args) {
    const sessionId = nonEmpty(args && args.sessionId)
    if (sessionId === undefined) return { ok: false, error: '需要 sessionId', members: [] }
    const service = ctx.get('subagents')
    const members = []
    if (service !== undefined) {
      try {
        const rows = await service.listChildren(sessionId)
        for (const row of rows) {
          if (!row || row.kind !== 'child') continue
          const id = String(row.id)
          if (retired.has(tombstone(sessionId, id))) continue
          const label = row.label === undefined || row.label === null ? '' : String(row.label)
          members.push({
            id,
            name: label.length > 0 ? label : id,
            status: row.activity === 'running' ? 'running' : 'idle',
            mode: row.mode === 'continuable' ? 'continuable' : 'one-shot',
          })
        }
      } catch (error) { /* catalog unavailable: an empty list degrades to "no agents" */ }
    }
    return { ok: true, sessionId, members }
  }

  return { state, pull, retire, restore, subagents }
}

/** Loopback-only fence: the panel drives local sessions, so remote callers must not. */
function isLoopbackRequest(req) {
  const remote = req && req.socket && req.socket.remoteAddress
  if (typeof remote !== 'string') return false
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
}

function writeJson(res, status, body, extra) {
  res.writeHead(status, Object.assign({ 'content-type': 'application/json; charset=utf-8' }, extra || {}))
  res.end(JSON.stringify(body))
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 1024 * 1024) { resolve({}); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim() === '') { resolve({}); return }
      try { resolve(JSON.parse(raw)) } catch (error) { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })
}

/**
 * Hide other sessions' subagents from the `@` session-reference menu.
 *
 * Referencing a session is a feature (the chosen session's snapshot is injected into the
 * prompt), so root sessions must stay listed. The problem is that the shipped resolver
 * lists EVERY session except self with no notion of subagents: subagent sessions inherit
 * their parent's cwd, so cwd-affinity ranking floats other sessions' workers to the top.
 *
 * The remote face calls `this.listCandidates(...)`, so replacing the instance method is a
 * live, reversible interception point. Kept: root sessions + the current session's own
 * subagent tree (any depth). Dropped: subagents whose lineage never reaches the caller.
 * Unclassifiable candidates (cold records absent from the listing) are kept, so a failure
 * here degrades to the shipped behaviour instead of hiding real sessions.
 */
function installMentionFilter(ctx) {
  const resolver = ctx.get('sessionReferenceResolver')
  if (resolver === undefined || typeof resolver.listCandidates !== 'function') return undefined
  const original = resolver.listCandidates
  let cachedAt = 0
  let cached = null

  const lineageOf = async (signal) => {
    const now = Date.now()
    if (cached !== null && now - cachedAt < 2000) return cached
    const query = resolver.ctx !== undefined ? resolver.ctx.sessionQuery : undefined
    if (query === undefined || typeof query.listSessions !== 'function') return null
    const rows = await query.listSessions(signal)
    const map = new Map()
    for (const row of rows) {
      const header = row.header
      if (header === undefined) continue
      map.set(String(header.id), {
        origin: header.origin,
        parent: header.parentSession === undefined ? undefined : String(header.parentSession),
      })
    }
    cached = map
    cachedAt = now
    return map
  }

  const inOwnTree = (map, sessionId, selfId) => {
    let cursor = map.get(String(sessionId))
    let guard = 0
    while (cursor !== undefined && guard < 64) {
      if (cursor.parent === selfId) return true
      if (cursor.parent === undefined) return false
      cursor = map.get(cursor.parent)
      guard += 1
    }
    return false
  }

  resolver.listCandidates = async function (agent, query, limit, signal) {
    const rows = await original.call(this, agent, query, limit, signal)
    try {
      const selfId = agent !== undefined && agent.id !== undefined ? String(agent.id) : undefined
      if (selfId === undefined) return rows
      const map = await lineageOf(signal)
      if (map === null) return rows
      return rows.filter((row) => {
        const record = map.get(String(row.sessionId))
        if (record === undefined) return true
        if (record.origin !== 'subagent') return true
        return inOwnTree(map, row.sessionId, selfId)
      })
    } catch (error) {
      return rows
    }
  }

  return () => { resolver.listCandidates = original }
}

export const name = 'dsh-agent-panel'

export const inject = ['webServer']

/** Exported for the package's own logic test; not part of the plugin surface. */
export { installMentionFilter }

export function apply(ctx) {
  const service = makeService(ctx)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-agent-panel/state',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) { writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' }); return }
      try {
        writeJson(res, 200, await service.state(), { 'cache-control': 'no-store' })
      } catch (error) {
        writeJson(res, 500, { ok: false, error: errMsg(error) })
      }
    },
  }), 'dsh-agent-panel: state route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-agent-panel/pull',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) { writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' }); return }
      if (req.method !== 'POST') { writeJson(res, 405, { ok: false, error: 'method not allowed' }); return }
      const args = await readJsonBody(req)
      try {
        writeJson(res, 200, await service.pull(args), { 'cache-control': 'no-store' })
      } catch (error) {
        writeJson(res, 500, { ok: false, error: errMsg(error) })
      }
    },
  }), 'dsh-agent-panel: pull route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-agent-panel/retire',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) { writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' }); return }
      if (req.method !== 'POST') { writeJson(res, 405, { ok: false, error: 'method not allowed' }); return }
      const args = await readJsonBody(req)
      try {
        writeJson(res, 200, await service.retire(args), { 'cache-control': 'no-store' })
      } catch (error) {
        writeJson(res, 500, { ok: false, error: errMsg(error) })
      }
    },
  }), 'dsh-agent-panel: retire route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-agent-panel/restore',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) { writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' }); return }
      if (req.method !== 'POST') { writeJson(res, 405, { ok: false, error: 'method not allowed' }); return }
      const args = await readJsonBody(req)
      try {
        writeJson(res, 200, await service.restore(args), { 'cache-control': 'no-store' })
      } catch (error) {
        writeJson(res, 500, { ok: false, error: errMsg(error) })
      }
    },
  }), 'dsh-agent-panel: restore route')

  const tools = ctx.get('tools')
  if (tools !== undefined) {
    tools.register({
      name: 'agrp_pull',
      description: [
        '通过前端面板同一套逻辑把一个已安装 preset 拉进某个在线会话（默认第一个在线会话；有聊天群名册的会话会同步 roster.json/chat.log）。',
        '省略 preset_id 时只返回当前状态。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          preset_id: { type: 'string', description: '要拉进会话的 preset id。' },
          session_id: { type: 'string', description: '可选，目标会话 id；缺省用第一个在线会话。' },
          name: { type: 'string', description: '可选，成员显示名。' },
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args) {
        const snap = await service.state()
        const presetId = nonEmpty(args && args.preset_id)
        if (presetId === undefined) return JSON.stringify(snap, null, 2)
        const sessionId = nonEmpty(args && args.session_id) || (snap.groups.length > 0 ? snap.groups[0].session_id : undefined)
        if (sessionId === undefined) return '没有在线会话'
        const result = await service.pull({ sessionId, presetId, name: args && args.name })
        return JSON.stringify(result, null, 2)
      },
    })
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-agent-panel/subagents',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) { writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' }); return }
      if (req.method !== 'GET') { writeJson(res, 405, { ok: false, error: 'method not allowed' }); return }
      let sessionId
      try { sessionId = new URL(req.url, 'http://127.0.0.1').searchParams.get('sessionId') || undefined } catch (error) { sessionId = undefined }
      try {
        writeJson(res, 200, await service.subagents({ sessionId }), { 'cache-control': 'no-store' })
      } catch (error) {
        writeJson(res, 500, { ok: false, error: errMsg(error), members: [] })
      }
    },
  }), 'dsh-agent-panel: subagents route')

  // The reference menu filter waits for the resolver when our row mounts before it does.
  ctx.effect(() => {
    let dispose = installMentionFilter(ctx)
    if (dispose === undefined) {
      ctx.inject(['sessionReferenceResolver'], () => {
        if (dispose === undefined) dispose = installMentionFilter(ctx)
      })
    }
    return () => { if (typeof dispose === 'function') dispose() }
  }, 'dsh-agent-panel: @ menu filter')
}
