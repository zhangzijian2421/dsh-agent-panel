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
/** Subdirectory holding one directory per group (multi-group workspace support). */
const GROUPS_SUBDIR = 'groups'
/** Channel tools the panel owns itself, so a group works without the chat-group preset. */
const GROUP_TOOL_NAMES = ['group_send', 'group_read', 'group_members']
const DEFAULT_READ_LIMIT = 100
const MAX_READ_LIMIT = 500
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

/** New multi-group layout: one directory per owning session. */
function groupDirFor(cwd, ownerId) {
  return joinPath(joinPath(joinPath(cwd, GROUP_DIR), GROUPS_SUBDIR), String(ownerId))
}

/**
 * Resolve which directory holds one owner's group state.
 *
 * Multi-group layout: `<cwd>/.agent-group/groups/<ownerSessionId>/` — one workspace hosts any
 * number of independent groups, each owned by its own session.
 * Legacy layout (single group per workspace): `<cwd>/.agent-group/` — used ONLY when its
 * roster records this exact owner, so previously created groups keep working untouched.
 *
 * A failed roster read means "absent", never an error: resolving must not fail a pull.
 */
async function resolveGroupDir(fs, cwd, ownerId) {
  const modern = groupDirFor(cwd, ownerId)
  if (fs === undefined || ownerId === undefined) return { dir: modern, roster: undefined, legacy: false }
  let modernRoster
  try { modernRoster = parseRoster(await readTextIfExists(fs, joinPath(modern, 'roster.json'))) } catch (error) { modernRoster = undefined }
  if (modernRoster !== undefined) return { dir: modern, roster: modernRoster, legacy: false }
  const legacyDir = joinPath(cwd, GROUP_DIR)
  let legacyRoster
  try { legacyRoster = parseRoster(await readTextIfExists(fs, joinPath(legacyDir, 'roster.json'))) } catch (error) { legacyRoster = undefined }
  if (legacyRoster !== undefined) {
    const owner = legacyRoster.owner && typeof legacyRoster.owner.id === 'string' ? legacyRoster.owner.id : undefined
    if (owner === String(ownerId)) return { dir: legacyDir, roster: legacyRoster, legacy: true }
  }
  return { dir: modern, roster: undefined, legacy: false }
}

async function readChat(fs, dir, limit) {
  const raw = await readTextIfExists(fs, joinPath(dir, 'chat.log'))
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

async function nextChatSeq(fs, dir) {
  const raw = await readTextIfExists(fs, joinPath(dir, 'chat.log'))
  if (raw === undefined) return { prefix: '', seq: 1 }
  let seq = 1
  for (const line of raw.split('\n')) { if (line.trim() !== '') seq += 1 }
  return { prefix: raw, seq }
}

/**
 * The group a caller belongs to: the host's own session, or a member's parent session.
 * Members are continuable children, so `header.parentSession` is their group owner.
 */
function callerOwnerId(exec) {
  const header = exec && exec.agent && exec.agent.session ? exec.agent.session.header : undefined
  if (header === undefined) return undefined
  if (header.origin === 'subagent') {
    return typeof header.parentSession === 'string' && header.parentSession.length > 0 ? header.parentSession : undefined
  }
  return typeof header.id === 'string' ? header.id : undefined
}

/** Resolve the caller's group: workspace from its own session header + the owner above. */
async function callerGroup(fs, exec, channelDir) {
  const header = exec && exec.agent && exec.agent.session ? exec.agent.session.header : undefined
  const cwd = header ? header.cwd : undefined
  const ownerId = callerOwnerId(exec)
  if (typeof cwd !== 'string' || cwd.length === 0 || ownerId === undefined) {
    return { error: '无法确定调用者所属会话或工作区' }
  }
  let resolved
  try { resolved = await resolveGroupDir(fs, cwd, ownerId) } catch (error) { resolved = undefined }
  if (resolved === undefined || resolved.roster === undefined) {
    return { error: '当前会话还没有聊天群（在面板里拉一个 agent 会自动创建，或用「多 Agent 聊天群」预设的 group_invite）' }
  }
  return { cwd, ownerId, dir: resolved.dir, roster: resolved.roster, base: joinPath(cwd, channelDir) }
}

/** Name → id resolution against the roster; unknown names are ignored (as in the preset). */
function resolveMentionIds(mentionNames, roster) {
  const names = []
  const ids = []
  for (const raw of mentionNames) {
    const name = String(raw)
    if (roster.owner && name === roster.owner.name) { names.push(name); ids.push(String(roster.owner.id)); continue }
    const member = (roster.members || []).find((item) => String(item.name) === name)
    if (member !== undefined) { names.push(name); ids.push(String(member.id)) }
  }
  return { names, ids }
}

/**
 * Register the channel tools at the plugin's own (root) scope.
 *
 * Root registration is deliberate: a member's scope resolves root tools (its own session
 * may have no group preset at all), which is exactly what lets ANY session with a group
 * directory do real group chat. Each call is guarded at runtime by `callerGroup`, so a
 * session without a group gets an actionable error instead of a silent no-op.
 */
function installGroupTools(ctx) {
  const tools = ctx.get('tools')
  if (tools === undefined || tools === null || typeof tools.register !== 'function') return

  ctx.tools.register({
    name: 'group_send',
    description: [
      '在当前聊天群频道发言（写入该群的 chat.log）。mentions 可 @ 成员名或主持人名，未知名忽略。',
      '仅当当前会话已有聊天群（群目录）时可用：主持人用自己会话的群，成员用其父会话的群。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要发到频道的内容。' },
        mentions: { type: 'array', items: { type: 'string' }, description: '可选，@ 的成员名 / 主持人名。' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          seq: { type: 'number' },
          speaker: { type: 'string' },
          channel: { type: 'string' },
        },
        required: ['seq', 'speaker', 'channel'],
      },
      render: (_args, value) => [{ type: 'text', text: `已发送（seq ${value.seq}，发言者 ${value.speaker}）` }],
    },
    async execute(args, exec) {
      const fs = ctx.get('fs')
      if (fs === undefined) throw new Error('fs 服务不可用')
      const text = typeof args.text === 'string' ? args.text : ''
      if (text.length === 0) throw new Error('group_send 需要 text')
      const group = await callerGroup(fs, exec, DEFAULT_CHANNEL_DIR)
      if (group.error !== undefined) throw new Error(group.error)
      const roster = group.roster
      const isMember = callerOwnerId(exec) !== (exec.agent && exec.agent.id)
      const member = (roster.members || []).find((item) => String(item.id) === String(exec.agent.id))
      const speaker = isMember
        ? String((member && member.name) || exec.agent.id)
        : String((roster.owner && roster.owner.name) || '主持人')
      const mentionNames = Array.isArray(args.mentions) ? args.mentions.filter((item) => typeof item === 'string' && item.length > 0) : []
      const { names, ids } = resolveMentionIds(mentionNames, roster)
      const chatPath = joinPath(group.dir, 'chat.log')
      let seq = 0
      const chat = await nextChatSeq(fs, group.dir)
      seq = chat.seq
      const entry = JSON.stringify({
        kind: 'message',
        seq,
        ts: Date.now(),
        speaker,
        speaker_id: exec.agent.id,
        mentions: names,
        mention_ids: ids,
        text,
      }) + '\n'
      const target = await fs.resolve(chatPath, {})
      const firstError = await writeTextFenced(fs, target, chat.prefix + entry, group.cwd, group.ownerId)
      if (firstError !== undefined) throw new Error('频道写入失败：' + firstError)
      return { seq, speaker, channel: chatPath }
    },
  })

  ctx.tools.register({
    name: 'group_read',
    description: [
      '读当前聊天群频道（chat.log 尾部，正序）。limit 1..500（默认 100）；给 mentions 则只返回与这些名字相关的消息。',
      '仅当当前会话已有聊天群（群目录）时可用。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: MAX_READ_LIMIT, description: '最多返回条数，默认 100。' },
        mentions: { type: 'array', items: { type: 'string' }, description: '可选，按 @ 名过滤。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          messages: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                seq: { type: 'number' },
                kind: { type: 'string' },
                speaker: { type: 'string' },
                text: { type: 'string' },
              },
              required: ['seq', 'kind', 'speaker', 'text'],
            },
          },
          channel: { type: 'string' },
        },
        required: ['messages', 'channel'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.messages.length === 0
          ? '(无消息)'
          : value.messages.map((m) => `#${m.seq} ${m.kind === 'system' ? '[系统]' : m.speaker}\n${m.text}`).join('\n'),
      }],
    },
    async execute(args, exec) {
      const fs = ctx.get('fs')
      if (fs === undefined) throw new Error('fs 服务不可用')
      const group = await callerGroup(fs, exec, DEFAULT_CHANNEL_DIR)
      if (group.error !== undefined) throw new Error(group.error)
      const rawLimit = Number.isInteger(args.limit) ? args.limit : DEFAULT_READ_LIMIT
      const limit = Math.min(Math.max(rawLimit, 1), MAX_READ_LIMIT)
      const mentionFilter = Array.isArray(args.mentions) ? args.mentions.filter((item) => typeof item === 'string' && item.length > 0) : []
      const chatPath = joinPath(group.dir, 'chat.log')
      const raw = await readTextIfExists(fs, chatPath)
      const rows = []
      if (raw !== undefined) {
        for (const line of raw.split('\n')) {
          if (line.trim() === '') continue
          let obj
          try { obj = JSON.parse(line) } catch (error) { continue }
          if (!obj || typeof obj !== 'object') continue
          if (mentionFilter.length > 0) {
            const rowMentions = Array.isArray(obj.mentions) ? obj.mentions : []
            if (!rowMentions.some((name) => mentionFilter.includes(name))) continue
          }
          rows.push({
            seq: typeof obj.seq === 'number' ? obj.seq : rows.length + 1,
            kind: typeof obj.kind === 'string' ? obj.kind : 'message',
            speaker: typeof obj.speaker === 'string' ? obj.speaker : '',
            text: typeof obj.text === 'string' ? obj.text : '',
          })
        }
      }
      return { messages: rows.slice(-limit), channel: chatPath }
    },
  })

  ctx.tools.register({
    name: 'group_members',
    description: [
      '列出当前聊天群的群主与成员（含 running/idle 状态）。',
      '仅当当前会话已有聊天群（群目录）时可用。',
    ].join('\n'),
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          host: {
            type: 'object',
            additionalProperties: false,
            properties: { name: { type: 'string' }, id: { type: 'string' } },
            required: ['name', 'id'],
          },
          members: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                preset_id: { type: 'string' },
                status: { type: 'string' },
              },
              required: ['id', 'name', 'preset_id', 'status'],
            },
          },
        },
        required: ['host', 'members'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: `主持人：${value.host.name}（${value.host.id}）\n` + (
          value.members.length === 0
            ? '(暂无成员)'
            : value.members.map((m) => `${m.name}（${m.id}）[${m.status}] preset=${m.preset_id}`).join('\n')
        ),
      }],
    },
    async execute(_args, exec) {
      const fs = ctx.get('fs')
      if (fs === undefined) throw new Error('fs 服务不可用')
      const group = await callerGroup(fs, exec, DEFAULT_CHANNEL_DIR)
      if (group.error !== undefined) throw new Error(group.error)
      const roster = group.roster
      const activity = new Map()
      const subagents = ctx.get('subagents')
      if (subagents !== undefined) {
        try {
          const rows = await subagents.listChildren(group.ownerId)
          for (const row of rows) {
            if (row && row.kind === 'child') activity.set(String(row.id), row.activity === 'running' ? 'running' : 'idle')
          }
        } catch (error) { /* status degrades to ready */ }
      }
      const members = (roster.members || []).map((member) => ({
        id: String(member.id),
        name: String(member.name),
        preset_id: String(member.preset_id || ''),
        status: activity.get(String(member.id)) || 'ready',
      }))
      return {
        host: {
          name: String((roster.owner && roster.owner.name) || '主持人'),
          id: group.ownerId,
        },
        members,
      }
    },
  })
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
    const liveCwds = new Set()
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
        liveCwds.add(cwd)
        let resolved = { dir: groupDirFor(cwd, sessionId), roster: undefined, legacy: false }
        if (fs !== undefined) {
          try { resolved = await resolveGroupDir(fs, cwd, sessionId) } catch (error) { resolved = { dir: groupDirFor(cwd, sessionId), roster: undefined, legacy: false } }
        }
        const roster = resolved.roster
        const merged = await membersOf(subagents, agents, roster, sessionId)
        groups.push({
          session_id: sessionId,
          cwd,
          owner_id: sessionId,
          owner_name: (roster && roster.owner && roster.owner.name) || '主持人',
          owner_live: merged.ownerLive,
          has_roster: roster !== undefined,
          multi_group: !resolved.legacy,
          members: merged.members,
          removed: merged.removed,
          messages: roster !== undefined && fs !== undefined ? await readChat(fs, resolved.dir, 12) : [],
        })
      }
    }

    // Groups whose owning session is not loaded right now: still list them so several
    // independent groups in one workspace stay visible (read-only: pull is disabled).
    if (fs !== undefined && liveCwds.size > 0) {
      for (const cwd of liveCwds) {
        let entries = []
        try {
          const target = await fs.resolve(joinPath(joinPath(cwd, GROUP_DIR), GROUPS_SUBDIR), {})
          entries = await fs.listDir(target)
        } catch (error) { entries = [] }
        for (const entry of entries) {
          if (!entry || entry.type !== 'directory') continue
          const ownerId = String(entry.name)
          if (groups.some((item) => item.session_id === ownerId)) continue
          let roster
          try { roster = parseRoster(await readTextIfExists(fs, joinPath(groupDirFor(cwd, ownerId), 'roster.json'))) } catch (error) { roster = undefined }
          if (roster === undefined) continue
          groups.push({
            session_id: ownerId,
            cwd,
            owner_id: ownerId,
            owner_name: (roster.owner && roster.owner.name) || '主持人',
            owner_live: false,
            has_roster: true,
            multi_group: true,
            members: await membersOf(subagents, agents, roster, ownerId).then((merged) => merged.members),
            removed: [],
            messages: await readChat(fs, groupDirFor(cwd, ownerId), 12),
          })
        }
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

    let resolved = { dir: groupDirFor(cwd, ownerId), roster: undefined, legacy: false }
    if (fs !== undefined) {
      try { resolved = await resolveGroupDir(fs, cwd, ownerId) } catch (error) { resolved = { dir: groupDirFor(cwd, ownerId), roster: undefined, legacy: false } }
    }
    const roster = resolved.roster
    const groupDir = resolved.dir
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
    const fullCapabilityRequested = !!(args && args.fullCapability)
    // Group members live on group tools (group_send/group_read); recomposing would strip
    // exactly those, so full capability is ignored for chat-group members (with a note).
    const fullCapability = fullCapabilityRequested && !isGroup
    const fullCapabilityIgnored = fullCapabilityRequested && isGroup
    // Group tools are provided by the panel itself (root scope, runtime-guarded), so a
    // member has them whether or not its session composes the chat-group preset. The
    // fallback sentence stays for the case where the panel is not mounted in that scope.
    const notice = '你现在是聊天群成员，群内名字「' + name + '」，主持人称「' + ownerLabel + '」。'
      + '\n用 group_send 在频道发言（mentions 可 @ 成员或主持人）、group_read 看频道、group_members 看成员。'
      + '\n先 group_read 补上下文再干活；完成后把结论 group_send 落频道并 @ 相关人，再用 send_message 向主持人（agent_id=' + ownerId + '）简短汇报（若你确实看不到 group_send，则只用 send_message 汇报）。'
      + '\n你不能直接给其他成员发消息；被 @ 时主持人会用 send_message 唤醒你；不要用 group_invite / group_list_presets。'
    const welcome = '欢迎「' + name + '」。主持人 id：' + ownerId + '。\n' + notice
    const persona = personaText + '\n\n' + notice

    // Full-capability pulls spawn NEUTRAL (the real persona and tools arrive through
    // recompose), so the preset's identity is not applied twice.
    const neutralPersona = '你是「' + name + '」，被主持人拉进本会话协作（完整能力模式）。保持在线，等待指示。'
    const spawnPersona = fullCapability ? neutralPersona : persona
    const spawnPromptText = fullCapability
      ? '欢迎「' + name + '」加入本会话（完整能力模式，配置中）。请保持在线，等待主持人下一步指示。'
      : welcome
    const startSpec = (denyNames) => ({
      provider: 'spawn',
      label: name,
      signal: makeSignal(),
      request: {
        prompt: [{ type: 'text', text: spawnPromptText }],
        parent,
        persona: spawnPersona,
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

    // Full capability: recompose the child scope to the target preset so it really owns
    // that preset's tool surface (verified behaviourally: a read-less child gained read).
    // Group members are exempt — recomposing would strip exactly the group tools they need.
    if (fullCapability) {
      try {
        const childAgent = agents.get(childId)
        if (childAgent === undefined) {
          notes.push('完整能力：子代理未驻留，跳过 recompose（成员保持基础状态）')
        } else {
          await agentPresets.recompose(childAgent.ctx, presetId)
          notes.push('已按「完整能力」recompose 为 ' + presetId + '：子代理获得该 preset 的真实工具集')
          const fullBriefing = '「' + name + '」已按完整能力模式配置（你拥有 ' + presetId + ' 的真实工具集）。主持人 id：' + ownerId + '。请简短向主持人（send_message）报到你已就位与当前可用工具，然后等待任务。'
          try {
            await subagents.sendMessage(parent, childId, [{ type: 'text', text: fullBriefing }], { signal: makeSignal() })
          } catch (error) {
            notes.push('完整能力简报投递失败（不影响 recompose）：' + errMsg(error))
          }
        }
      } catch (error) {
        notes.push('完整能力 recompose 失败（成员保持基础状态）：' + errMsg(error))
      }
    } else if (fullCapabilityIgnored) {
      notes.push('聊天群成员保持群工具（group_send/group_read），已忽略「完整能力」选项。')
    }

    // Every pull turns the target session into a group: if it has no group directory yet,
    // create one now, so the panel, the roster and the channel agree afterwards. A session
    // that runs the chat-group preset has already created it on its first step (idempotent).
    let autoGrouped = false
    let effectiveDir = groupDir
    let effectiveRoster = roster
    if (!isGroup && fs !== undefined) {
      const created = await ensureGroup(fs, cwd, ownerId, ownerLabel)
      if (created.roster !== undefined) {
        autoGrouped = true
        effectiveDir = created.dir
        effectiveRoster = created.roster
      }
    }

    if ((isGroup || autoGrouped) && fs !== undefined) {
      try {
        const dir = effectiveDir
        const rosterTarget = await fs.resolve(joinPath(dir, 'roster.json'), {})
        const nextRoster = {
          owner: { id: ownerId, name: ownerLabel },
          members: ((effectiveRoster && effectiveRoster.members) || []).concat([{ id: childId, name, preset_id: presetId, invited_at: Date.now() }]),
        }
        const firstError = await writeTextFenced(fs, rosterTarget, JSON.stringify(nextRoster, null, 2) + '\n', cwd, ownerId)
        if (firstError !== undefined) notes.push('名册写入经沙箱升级完成（首次拒绝：' + firstError + '）')

        const chat = await nextChatSeq(fs, dir)
        const chatTarget = await fs.resolve(joinPath(dir, 'chat.log'), {})
        const entry = JSON.stringify({ kind: 'system', seq: chat.seq, ts: Date.now(), text: name + ' 加入群聊（前端面板拉入）' }) + '\n'
        const chatError = await writeTextFenced(fs, chatTarget, chat.prefix + entry, cwd, ownerId)
        if (chatError !== undefined && firstError === undefined) notes.push('频道写入经沙箱升级完成（首次拒绝：' + chatError + '）')
      } catch (error) {
        notes.push('成员已拉起，但名册/频道写入失败：' + errMsg(error))
      }
    }
    const result = { ok: true, member_id: childId, name, preset_id: presetId, group: isGroup || autoGrouped, autoGrouped }
    if (autoGrouped) {
      result.info = '已自动为该会话创建独立群聊目录（自动变群）。若该会话未使用群预设，成员没有 group_send 等群工具，将通过 send_message 私信汇报。'
    }
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

    let resolved = { dir: cwd === undefined ? undefined : groupDirFor(cwd, ownerId), roster: undefined, legacy: false }
    if (cwd !== undefined && fs !== undefined) {
      try { resolved = await resolveGroupDir(fs, cwd, ownerId) } catch (error) { resolved = { dir: groupDirFor(cwd, ownerId), roster: undefined, legacy: false } }
    }
    const roster = resolved.roster

    const member = roster !== undefined
      ? (roster.members || []).find((item) => String(item.id) === memberId)
      : undefined
    const name = member !== undefined ? String(member.name) : memberId
    const notes = []

    if (roster !== undefined && fs !== undefined) {
      const ownerLabel = (roster.owner && roster.owner.name) || '主持人'
      const remaining = (roster.members || []).filter((item) => String(item.id) !== memberId)
      try {
        const dir = resolved.dir
        const rosterTarget = await fs.resolve(joinPath(dir, 'roster.json'), {})
        const nextRoster = {
          owner: { id: ownerId, name: ownerLabel },
          members: remaining,
        }
        const rosterError = await writeTextFenced(fs, rosterTarget, JSON.stringify(nextRoster, null, 2) + '\n', cwd, ownerId)
        if (rosterError !== undefined) notes.push('名册写入经沙箱升级完成（首次拒绝：' + rosterError + '）')

        const chat = await nextChatSeq(fs, dir)
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
   * Create this session's own group directory when it has none (idempotent).
   *
   * This is what makes "pull into any session" turn that session into a chat group:
   * the roster's existence is the marker the panel reads, so creating it here is what
   * the UI shows as 自动变群. `fs.writeText` creates missing parent directories.
   */
  async function ensureGroup(fs, cwd, ownerId, ownerName) {
    let resolved = { dir: groupDirFor(cwd, ownerId), roster: undefined, legacy: false }
    try { resolved = await resolveGroupDir(fs, cwd, ownerId) } catch (error) { /* treat as absent */ }
    if (resolved.roster !== undefined) return resolved
    const dir = groupDirFor(cwd, ownerId)
    try {
      const target = await fs.resolve(joinPath(dir, 'roster.json'), {})
      const roster = { owner: { id: ownerId, name: ownerName || '主持人' }, members: [] }
      await writeTextFenced(fs, target, JSON.stringify(roster, null, 2) + '\n', cwd, ownerId)
    } catch (error) { /* fall through: the caller then keeps plain-session behaviour */ }
    try { resolved = await resolveGroupDir(fs, cwd, ownerId) } catch (error) { /* keep previous */ }
    return resolved
  }

  /**
   * Turn one session into a chat group: create its own group directory
   * (`<cwd>/.agent-group/groups/<sessionId>/roster.json`) with an empty member list.
   * This is what makes several independent groups coexist in one workspace — the host
   * agent's `group_invite` creates the same directory on its first invite.
   */
  async function initGroup(args) {
    const ownerId = nonEmpty(args && args.sessionId) || nonEmpty(args && args.ownerId)
    if (ownerId === undefined) return { ok: false, error: '需要 sessionId' }
    const fs = ctx.get('fs')
    const sessions = ctx.get('sessions')
    if (fs === undefined) return { ok: false, error: 'fs 服务不可用' }

    let cwd = nonEmpty(args && args.cwd)
    if (cwd === undefined && sessions !== undefined) {
      try {
        const session = sessions.get(ownerId)
        cwd = session && session.header && session.header.cwd
      } catch (error) { cwd = undefined }
    }
    if (typeof cwd !== 'string' || cwd.length === 0) return { ok: false, error: '无法确定目标会话的工作目录' }

    let existing = { dir: groupDirFor(cwd, ownerId), roster: undefined, legacy: false }
    try { existing = await resolveGroupDir(fs, cwd, ownerId) } catch (error) { /* treat as absent */ }
    if (existing.roster !== undefined) {
      return { ok: true, already: true, dir: existing.dir, legacy: existing.legacy, members: (existing.roster.members || []).length }
    }

    const ownerName = nonEmpty(args && args.name) || '主持人'
    const created = await ensureGroup(fs, cwd, ownerId, ownerName)
    if (created.roster === undefined) return { ok: false, error: '创建群聊目录失败（写入被拒绝或工作区不可写）' }
    return { ok: true, created: true, dir: created.dir, legacy: created.legacy }
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

  return { state, pull, retire, restore, subagents, initGroup }
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

/** Exported for the package's own logic tests; not part of the plugin surface. */
export { installMentionFilter, resolveGroupDir, groupDirFor, callerOwnerId, callerGroup }

export function apply(ctx) {
  const service = makeService(ctx)

  // Channel tools owned by the panel (not the preset): any session with a group directory
  // gets working group chat for its host AND its members — members resolve root tools even
  // when their session composes no chat-group preset.
  installGroupTools(ctx)

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

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-agent-panel/init',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) { writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' }); return }
      if (req.method !== 'POST') { writeJson(res, 405, { ok: false, error: 'method not allowed' }); return }
      const args = await readJsonBody(req)
      try {
        writeJson(res, 200, await service.initGroup(args), { 'cache-control': 'no-store' })
      } catch (error) {
        writeJson(res, 500, { ok: false, error: errMsg(error) })
      }
    },
  }), 'dsh-agent-panel: init route')

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
