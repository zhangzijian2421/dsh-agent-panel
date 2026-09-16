/**
 * 群聊服务单测（v2.2：**空会话变成群聊**）。
 *
 * 钉住的语义：
 *   - 建群必须给 `session_id`：群 = 那个空会话本身（它本来就在工作区下面，无需归属操作）；
 *   - **群主 preset 固定**（「群聊 Agent」= group-host，决定整群成员的能力上限）：
 *     先按会话自己的 preset 启动（adopt/resume，不与记录冲突），再用原生 `agentPresets.select`
 *     换成它——只有空白会话能换（非空白会抛 locked，此时保留原 preset 并在结果里如实说明）；
 *     调用方传进来的 `preset_id` 一律忽略；
 *   - 标题加 👥 前缀，在侧边栏里区别于普通会话；
 *   - 拉人 = 群主会话下的具名常驻子代理（persona 来自被拉 preset，黑名单 + maxDepth=1）；
 *   - `state()` 报告群、成员（含"群主拉的"未注册成员）与能力面告警；
 *   - 解散 = 释放成员 + 归档会话 + 清注册表。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import {
  FALLBACK_DENY,
  MEMBER_TOOL_DENY,
  capabilityWarning,
  createGroupService,
  extractPersona,
  knownToolNamesFrom,
  makeSignal,
  mapChildRows,
  memberNotice,
  memberWelcome,
  parsePersonaPrefix
} from '../lib/group.js'
import { readRegistryFile } from '../lib/store.js'

const results = []
async function check(label, fn) {
	try {
		await fn()
		results.push({ label, ok: true })
		console.log('  ok   ' + label)
	} catch (error) {
		results.push({ label, ok: false })
		console.log('  FAIL ' + label + ' → ' + String((error && error.message) || error))
	}
}

const PRESETS = [
	{ id: 'group-host', name: '群聊 Agent', description: '群聊主控：盘点成员能力边界并派活', trust: 'user' },
	{ id: 'standard', name: '标准模式', description: '完整编码 agent', trust: 'system' },
	{ id: 'minimal', name: '极简模式', description: '只有 shell', trust: 'system' },
	{ id: 'se', name: 'SE 需求分析', description: '只做需求分析', trust: 'user' }
]
const SE_DOC = [
	'- id: persona',
	'  prefix: |',
	'    你是 SE，只做需求分析与方案设计。',
	'- id: tools',
	'  mode: standard'
].join('\n')

/** 桩宿主：只实现本服务真正用到的方法。 */
function makeHost(options) {
	const state = {
		agents: new Map(),
		children: new Map(),
		sessions: new Map(),
		titles: [],
		archived: [],
		specs: [],
		ensureCalls: [],
		creates: [],
		resumes: [],
		selects: [],
		drained: [],
		disposed: [],
		startFails: (options && options.startFails) || null,
		selectFails: (options && options.selectFails) || null,
		presetByAgent: new Map(),
		titleBySession: new Map()
	}
	let child = 0
	function makeAgent(id, cwd, preset) {
		return {
			id,
			status: 'idle',
			ctx: { agentId: id },
			options: { provider: 'deepseek-official', model: 'deepseek-flash' },
			session: { header: { cwd, agentPreset: preset } }
		}
	}
	/** `AgentHandle`：句柄持有者才能把 agent 从活会话表里摘掉（dispose 是能力）。 */
	function makeHandle(agent) {
		return {
			agent,
			async dispose() {
				state.disposed.push(agent.id)
				state.agents.delete(agent.id)
				state.sessions.delete(agent.id)
			}
		}
	}
	const ctx = {
		get(name) {
			if (name === 'agents') {
				return {
					get: (id) => state.agents.get(id),
					async create(options2) {
						state.creates.push({ sessionId: options2.sessionId, cwd: options2.meta.cwd, preset: options2.meta.agentPreset, agentOptions: options2.agentOptions })
						if (typeof options2.setup === 'function') await options2.setup({ agentId: options2.sessionId })
						const agent = makeAgent(options2.sessionId, options2.meta.cwd, options2.meta.agentPreset)
						state.agents.set(agent.id, agent)
						state.sessions.set(agent.id, { id: agent.id, header: { cwd: options2.meta.cwd, agentPreset: options2.meta.agentPreset } })
						return makeHandle(agent)
					},
					async resume(options2) {
						state.resumes.push({ id: options2.resumeSessionId, agentOptions: options2.agentOptions })
						if (typeof options2.setup === 'function') await options2.setup({ agentId: options2.resumeSessionId })
						const agent = makeAgent(options2.resumeSessionId, 'D:\\work', 'standard')
						state.agents.set(agent.id, agent)
						state.sessions.set(agent.id, { id: agent.id, header: { cwd: 'D:\\work', agentPreset: 'standard' } })
						return makeHandle(agent)
					}
				}
			}
			if (name === 'subagents') {
				return {
					async listChildren(id) { return state.children.get(id) || [] },
					async startContinuable(spec) {
						if (state.startFails !== null) {
							const failure = state.startFails
							state.startFails = null
							throw new Error(failure)
						}
						state.specs.push(spec)
						child += 1
						const childId = 'child-' + child
						const rows = state.children.get(spec.request.parent.id) || []
						rows.push({ kind: 'child', id: childId, label: spec.label, activity: 'running', mode: 'continuable' })
						state.children.set(spec.request.parent.id, rows)
						return { childId, messageId: 'msg-' + child }
					},
					async drainContinuableChildren(parent, ids) {
						state.drained.push({ parent: parent.id, ids: [...ids] })
						const rows = (state.children.get(parent.id) || []).filter((row) => ids.indexOf(row.id) < 0)
						state.children.set(parent.id, rows)
					}
				}
			}
			if (name === 'agentPresets') {
				return {
					// fixedPresetMissing：模拟"群聊 preset 没装"——建群必须当场失败并说清怎么装。
					async list() { return options && options.fixedPresetMissing === true ? PRESETS.filter((row) => row.id !== 'group-host') : PRESETS },
					async read(id) { return id === 'se' ? SE_DOC : '' },
					async mount(agentCtx, id) { state.presetByAgent.set(String(agentCtx.agentId), String(id)); return { id } },
					composedPreset(agentCtx) { return state.presetByAgent.get(String(agentCtx.agentId)) || null },
					async select(agent, id) {
						if (state.selectFails !== null) {
							const failure = state.selectFails
							state.selectFails = null
							throw new Error(failure)
						}
						state.selects.push({ agent: String(agent.id), preset: String(id) })
						state.presetByAgent.set(String(agent.id), String(id))
						return String(id)
					}
				}
			}
			if (name === 'sessions') {
				return { get: (id) => state.sessions.get(id) }
			}
			if (name === 'sessionController') {
				// 静态插件里 controller 通常**不可用**；noController 用来跑那条兜底路径（它才拿得到句柄）。
				if (options && options.noController === true) return undefined
				return {
					async ensureSession(id, cwd, check, preset) {
						state.ensureCalls.push({ id, cwd, check, preset })
						const agent = makeAgent(id, cwd, preset)
						state.agents.set(id, agent)
						state.sessions.set(id, { id, header: { cwd, agentPreset: preset } })
						state.presetByAgent.set(id, String(preset))
						return agent
					}
				}
			}
			if (name === 'sessionTitle') {
				return {
					rename: (session, title) => { state.titles.push({ id: session.id, title }); state.titleBySession.set(String(session.id), String(title)) },
					get: (session) => ({ title: state.titleBySession.get(String(session.id)) || '' })
				}
			}
			if (name === 'workspaceRegistry') {
				return {
					list: () => [],
					get: () => undefined,
					async archiveSession(id) { state.archived.push(id) }
				}
			}
			if (name === 'sessionTitle') {
				return { rename: (session, title) => { state.titles.push({ id: session.id, title }) } }
			}
			return undefined
		}
	}
	return { state, ctx }
}

console.log('group: 纯函数')
await check('mapChildRows 只保留 child，边角字段有兜底', () => {
	const rows = mapChildRows([
		{ kind: 'child', id: 'c1', label: 'SE', activity: 'running', mode: 'continuable' },
		{ kind: 'child', id: 'c2', activity: 'inactive', mode: 'one-shot' },
		{ kind: 'parent', id: 'p1' },
		null
	])
	assert.equal(rows.length, 2)
	assert.deepEqual(rows[0], { id: 'c1', name: 'SE', status: 'running', mode: 'continuable' })
	assert.deepEqual(rows[1], { id: 'c2', name: 'c2', status: 'idle', mode: 'one-shot' })
})
await check('memberNotice 交代群名、群主 id、汇报方式与「没任务别动手」', () => {
	const text = memberNotice({ groupName: '群聊 · 1', memberName: 'SE', groupId: 'group-abc' })
	assert.match(text, /群聊 · 1/)
	assert.match(text, /SE/)
	assert.match(text, /send_message\(agent_id="group-abc"\)/)
	assert.match(text, /兄弟会话/)
	// 没有任务的握手消息不能触发调研（实机踩过：成员自发跑了 15 步 / 21 次 bash）。
	assert.match(text, /没带任务的问候／握手消息不是任务/)
	assert.match(text, /不要调研/)
})
await check('memberWelcome 是一条明确无任务的握手，并禁止调工具', () => {
	const text = memberWelcome({ groupName: '群聊 · 1', memberName: 'SE', presetId: 'se' })
	assert.match(text, /本轮没有任务/)
	assert.match(text, /不要调用任何工具/)
	assert.match(text, /已就位 · SE/)
	assert.match(text, /preset se/)
})
await check('capabilityWarning 只对 minimal 群主报警', () => {
	assert.equal(capabilityWarning('standard'), undefined)
	assert.equal(capabilityWarning('cordis'), undefined)
	assert.match(capabilityWarning('minimal'), /read\/write\/edit/)
})
await check('knownToolNamesFrom 从 restrict 报错里解析工具域', () => {
	const names = knownToolNamesFrom('tools.restrict() names unknown global tools: read, write, list_agents')
	assert.deepEqual([...names].sort(), ['list_agents', 'read', 'write'])
	assert.equal(knownToolNamesFrom('完全不相干的报错'), undefined)
})
await check('parsePersonaPrefix 支持 | 与 > 块标量，并按下一个顶层条目收尾', () => {
	assert.equal(parsePersonaPrefix(SE_DOC), '你是 SE，只做需求分析与方案设计。')
	const folded = ['- id: persona', '  prefix: >-', '    第一行', '    第二行', '- id: tools'].join('\n')
	assert.equal(parsePersonaPrefix(folded), '第一行 第二行')
	assert.equal(parsePersonaPrefix('- id: tools\n  mode: standard'), null)
})
await check('extractPersona：有 persona 用 persona，读不到就退化成元数据身份', async () => {
	const source = { read: async (id) => (id === 'se' ? SE_DOC : ''), list: async () => PRESETS }
	assert.match(await extractPersona(source, 'se'), /只做需求分析/)
	const fallback = await extractPersona({ read: async () => { throw new Error('nope') }, list: async () => PRESETS }, 'se')
	assert.match(fallback, /SE 需求分析/)
	assert.match(fallback, /preset "se"/)
})
await check('makeSignal 满足 startContinuable 的鸭子类型要求', () => {
	const signal = makeSignal()
	assert.equal(signal.aborted, false)
	assert.doesNotThrow(() => signal.throwIfAborted())
})

console.log('group: 建群（空会话 → 群聊）')
await check('建群：启动空会话 + 原生 select 换成固定的群主 preset + 👥 标题 + 注册表', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'agrp-group-'))
	try {
		const host = makeHost()
		const service = createGroupService(host.ctx, { registryFile: join(dir, 'groups.json') })
		// 用户先建一个空会话（GUI 默认 minimal），再点「创建群聊」——群主 preset 由宿主固定。
		host.state.sessions.set('session-blank', { id: 'session-blank', header: { cwd: 'D:\\work', agentPreset: 'minimal' } })
		// 顺手证明"调用方传进来的 preset_id 会被忽略"。
		const created = await service.createGroup({ session_id: 'session-blank', preset_id: 'minimal' })
		assert.equal(created.ok, true, created.error)
		assert.equal(created.id, 'session-blank', '群 = 这个空会话本身')
		assert.equal(created.name, '群聊 · 1')
		assert.equal(created.title, '👥 群聊 · 1', '侧边栏标题带 👥 前缀')
		assert.equal(created.preset_id, 'group-host', '群主 preset 固定为群聊 Agent，忽略调用方传的值')
		assert.equal(created.preset_error, undefined)
		assert.deepEqual(host.state.ensureCalls, [{ id: 'session-blank', cwd: 'D:\\work', check: true, preset: 'minimal' }], '先按会话自己的 preset 启动')
		assert.deepEqual(host.state.selects, [{ agent: 'session-blank', preset: 'group-host' }], '再用空白特权换成固定的群主 preset')
		assert.deepEqual(host.state.titles, [{ id: 'session-blank', title: '👥 群聊 · 1' }])
		const registry = JSON.parse(readFileSync(join(dir, 'groups.json'), 'utf8'))
		assert.equal(registry.groups['session-blank'].presetId, 'group-host')
	} finally { rmSync(dir, { recursive: true, force: true }) }
})
await check('建群失败路径：缺 session_id / 会话不存在 / 会话无 cwd / 群聊 preset 未安装', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'agrp-group-'))
	try {
		const host = makeHost()
		const service = createGroupService(host.ctx, { registryFile: join(dir, 'groups.json') })
		const noSession = await service.createGroup({})
		assert.equal(noSession.ok, false)
		assert.match(noSession.error, /需要 session_id/)
		const ghost = await service.createGroup({ session_id: 'session-nope' })
		assert.equal(ghost.ok, false)
		assert.match(ghost.error, /会话不存在/)
		host.state.sessions.set('session-nocwd', { id: 'session-nocwd', header: {} })
		const noCwd = await service.createGroup({ session_id: 'session-nocwd' })
		assert.equal(noCwd.ok, false)
		assert.match(noCwd.error, /没有工作目录/)
		// 群聊 preset 是我们硬依赖的：目录不在就该当场失败并说清怎么装。
		const bare = makeHost({ fixedPresetMissing: true })
		bare.state.sessions.set('session-p', { id: 'session-p', header: { cwd: 'D:\\work', agentPreset: 'minimal' } })
		const bareService = createGroupService(bare.ctx, { registryFile: join(dir, 'bare.json') })
		const missing = await bareService.createGroup({ session_id: 'session-p' })
		assert.equal(missing.ok, false)
		assert.match(missing.error, /group-host/)
		assert.match(missing.error, /\.agent-presets/)
	} finally { rmSync(dir, { recursive: true, force: true }) }
})
await check('非空白会话：select 被拒时保留原 preset 并如实说明', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'agrp-group-'))
	try {
		const host = makeHost({ selectFails: 'agent-preset/locked: the session has already started' })
		host.state.sessions.set('session-started', { id: 'session-started', header: { cwd: 'D:\\work', agentPreset: 'minimal' } })
		const service = createGroupService(host.ctx, { registryFile: join(dir, 'groups.json') })
		const created = await service.createGroup({ session_id: 'session-started' })
		assert.equal(created.ok, true, created.error)
		assert.equal(created.preset_id, 'minimal', '保留会话原有 preset')
		assert.match(created.preset_error, /locked/)
		const registry = JSON.parse(readFileSync(join(dir, 'groups.json'), 'utf8'))
		assert.equal(registry.groups['session-started'].presetId, 'minimal')
	} finally { rmSync(dir, { recursive: true, force: true }) }
})

await check('会话已经在线时不再开第二个写句柄（active write handle 冲突）', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'agrp-group-'))
	try {
		const host = makeHost()
		// 模拟"用户正开着这个会话"：agent 已在线
		host.state.agents.set('session-live', {
			id: 'session-live',
			ctx: { agentId: 'session-live' },
			options: { provider: 'deepseek-official', model: 'deepseek-flash' },
			session: { header: { cwd: 'D:\\work', agentPreset: 'standard' } }
		})
		host.state.sessions.set('session-live', { id: 'session-live', header: { cwd: 'D:\\work', agentPreset: 'standard' } })
		host.state.presetByAgent.set('session-live', 'standard')
		const service = createGroupService(host.ctx, { registryFile: join(dir, 'groups.json') })
		const created = await service.createGroup({ session_id: 'session-live', name: '在线建群' })
		assert.equal(created.ok, true, created.error)
		assert.equal(host.state.resumes.length, 0, '在线会话不能 resume（会撞 already owned by an active write handle）')
		assert.equal(host.state.ensureCalls.length, 0, '在线会话也不该再走 ensureSession')
		assert.equal(created.preset_id, 'group-host', '在线的会话也会被切成固定的群主 preset')
		assert.equal(created.owner_model, 'deepseek-official/deepseek-flash')
	} finally { rmSync(dir, { recursive: true, force: true }) }
})
await check('重复创建同一个群：保留既有成员与创建时间', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'agrp-group-'))
	try {
		const host = makeHost()
		host.state.sessions.set('session-g', { id: 'session-g', header: { cwd: 'D:\\work', agentPreset: 'minimal' } })
		const service = createGroupService(host.ctx, { registryFile: join(dir, 'groups.json') })
		const first = await service.createGroup({ session_id: 'session-g', cwd: 'D:\\work', name: '验证群' })
		const pulled = await service.pull({ group_id: first.id, preset_id: 'se' })
		assert.equal(pulled.ok, true, pulled.error)
		const again = await service.createGroup({ session_id: 'session-g' })
		assert.equal(again.ok, true, again.error)
		assert.equal(again.name, '验证群', '再次创建不该改名')
		const registry = JSON.parse(readFileSync(join(dir, 'groups.json'), 'utf8'))
		assert.equal(registry.groups['session-g'].members.length, 1, '名册不能被清空')
		assert.equal(registry.groups['session-g'].members[0].name, 'SE 需求分析')
	} finally { rmSync(dir, { recursive: true, force: true }) }
})

console.log('group: 拉人')
async function setupGroup() {
	const dir = mkdtempSync(join(tmpdir(), 'agrp-group-'))
	const host = makeHost()
	const service = createGroupService(host.ctx, { registryFile: join(dir, 'groups.json') })
	// 空会话是 GUI 建的（默认 minimal）；建群把它变成群聊。
	host.state.sessions.set('session-g', { id: 'session-g', header: { cwd: 'D:\\work', agentPreset: 'minimal' } })
	const created = await service.createGroup({ session_id: 'session-g', name: '验证群' })
	if (created.ok !== true) throw new Error('setup 失败: ' + created.error)
	return { dir, host, service, groupId: created.id, created }
}
await check('拉人：label/persona/黑名单/maxDepth 与注册表都正确', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'agrp-group-'))
	try {
		const { dir: dir2, host, service, groupId } = await setupGroup()
		const pulled = await service.pull({ group_id: groupId, preset_id: 'se' })
		assert.equal(pulled.ok, true, pulled.error)
		assert.equal(pulled.member_id, 'child-1')
		assert.equal(pulled.name, 'SE 需求分析')
		const spec = host.state.specs[0]
		assert.equal(spec.provider, 'spawn')
		assert.equal(spec.request.parent.id, groupId, '成员挂在群主会话下')
		assert.equal(spec.request.maxDepth, 1)
		assert.deepEqual(spec.request.toolFilter.deny, MEMBER_TOOL_DENY)
		assert.match(spec.request.persona, /只做需求分析/)
		// 第一轮必须是握手（明确无任务、禁调工具），否则成员会把入群当任务自发开工。
		assert.match(spec.request.prompt[0].text, /入群握手 · 本轮没有任务/)
		assert.match(spec.request.prompt[0].text, /不要调用任何工具/)
		assert.doesNotMatch(spec.request.prompt[0].text, /先动手/)
		assert.ok(spec.signal && typeof spec.signal.throwIfAborted === 'function')
		const registry = JSON.parse(readFileSync(join(dir2, 'groups.json'), 'utf8'))
		assert.equal(registry.groups[groupId].members[0].presetId, 'se')
		assert.match(pulled.capability, /群主 preset（group-host）/)
	} finally { rmSync(dir, { recursive: true, force: true }) }
})
await check('同名成员自动退避 -2；显式重名直接拒绝', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'agrp-group-'))
	try {
		const { service, groupId } = await setupGroup()
		const first = await service.pull({ group_id: groupId, preset_id: 'se' })
		const second = await service.pull({ group_id: groupId, preset_id: 'se' })
		assert.equal(first.name, 'SE 需求分析')
		assert.equal(second.name, 'SE 需求分析-2')
		const clash = await service.pull({ group_id: groupId, preset_id: 'se', name: 'SE 需求分析' })
		assert.equal(clash.ok, false)
		assert.match(clash.error, /已被占用/)
	} finally { rmSync(dir, { recursive: true, force: true }) }
})
await check('降级：工具域不认全部黑名单时按解析结果裁剪并出告警', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'agrp-group-'))
	try {
		const host = makeHost({ startFails: 'tools.restrict() names unknown global tools: pwsh, list_agents, interrupt_agent, ask_user_question' })
		host.state.sessions.set('session-g', { id: 'session-g', header: { cwd: 'D:\\work', agentPreset: 'minimal' } })
		const service = createGroupService(host.ctx, { registryFile: join(dir, 'groups.json') })
		const group = await service.createGroup({ session_id: 'session-g', cwd: 'D:\\work' })
		const pulled = await service.pull({ group_id: group.id, preset_id: 'se' })
		assert.equal(pulled.ok, true, JSON.stringify(pulled))
		assert.deepEqual(host.state.specs[0].request.toolFilter.deny, ['list_agents', 'interrupt_agent', 'ask_user_question'])
		assert.match(pulled.warning, /黑名单已裁剪/)
	} finally { rmSync(dir, { recursive: true, force: true }) }
})
await check('拉人失败路径：群不存在 / preset 不存在 / 群聊 preset 不能当成员 / 群主起不来', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'agrp-group-'))
	try {
		const { dir: setupDir, host, service, groupId } = await setupGroup()
		assert.equal((await service.pull({ group_id: 'group-nope', preset_id: 'se' })).ok, false)
		assert.equal((await service.pull({ group_id: groupId, preset_id: 'ghost' })).ok, false)
		// 群聊 preset 是"群主"：它的人格是"我不亲自干活"，拉成成员只会得到一个不肯动手的人。
		const owner = await service.pull({ group_id: groupId, preset_id: 'group-host' })
		assert.equal(owner.ok, false)
		assert.match(owner.error, /群主专用/)
		assert.equal(host.state.specs.length, 0, '拒绝的拉人不该真的开工')
		host.state.agents.clear()
		const noController = { get: (name) => (name === 'agents' ? { get: () => undefined } : host.ctx.get(name)) }
		const offline = createGroupService(noController, { registryFile: join(setupDir, 'groups.json') })
		const failed = await offline.pull({ group_id: groupId, preset_id: 'se' })
		assert.equal(failed.ok, false)
		assert.match(failed.error, /不可用/)
	} finally { rmSync(dir, { recursive: true, force: true }) }
})

console.log('group: 状态')
await check('状态：注册成员 + 原生外来成员 + minimal 告警', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'agrp-group-'))
	try {
		const host = makeHost()
		const service = createGroupService(host.ctx, { registryFile: join(dir, 'groups.json') })
		host.state.sessions.set('session-g', { id: 'session-g', header: { cwd: 'D:\\work', agentPreset: 'minimal' } })
		const group = await service.createGroup({ session_id: 'session-g', cwd: 'D:\\work', name: '验证群' })
		await service.pull({ group_id: group.id, preset_id: 'se' })
		host.state.children.set(group.id, [
			{ kind: 'child', id: 'child-1', label: 'SE 需求分析', activity: 'running', mode: 'continuable' },
			{ kind: 'child', id: 'child-9', label: '野生成员', activity: 'inactive', mode: 'continuable' }
		])
		const row = (await service.state()).groups.find((item) => item.id === group.id)
		assert.equal(row.owner_live, true)
		assert.equal(row.members.length, 2, '注册成员 + 群主自己拉的都要看得见')
		assert.equal(row.members[0].status, 'running')
		assert.equal(row.members[0].registered, true)
		assert.equal(row.members[1].registered, false)
		assert.equal(row.capability_warning, undefined)
		// 新建群已固定 group-host，minimal 群主只可能是历史遗留（老版本建的群）：
		// 直接写注册表模拟，确认面板仍会对它报警。
		const registryPath = join(dir, 'groups.json')
		const registry = JSON.parse(readFileSync(registryPath, 'utf8'))
		registry.groups['session-legacy'] = {
			id: 'session-legacy', name: '弱群', cwd: 'D:\\work', presetId: 'minimal', createdAt: Date.now(), members: []
		}
		writeFileSync(registryPath, JSON.stringify(registry))
		const legacyRow = (await service.state()).groups.find((item) => item.id === 'session-legacy')
		assert.match(legacyRow.capability_warning, /minimal/)
	} finally { rmSync(dir, { recursive: true, force: true }) }
})

console.log('group: 移除 / 恢复 / 解散 / 改名')
await check('移除：释放子代理 + 软删除；恢复：撤销软删除（状态 inactive）', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'agrp-group-'))
	try {
		const { host, service, groupId, memberId } = await setupWithMember()
		const released = await service.release({ group_id: groupId, member_id: memberId })
		assert.equal(released.ok, true, released.error)
		assert.equal(released.released, true)
		assert.deepEqual(host.state.drained, [{ parent: groupId, ids: [memberId] }])
		let row = (await service.state()).groups.find((item) => item.id === groupId)
		assert.deepEqual(row.members, [])
		assert.deepEqual(row.removed.map((member) => member.id), [memberId])
		await service.restore({ group_id: groupId, member_id: memberId })
		row = (await service.state()).groups.find((item) => item.id === groupId)
		assert.deepEqual(row.removed, [])
		const back = row.members.find((member) => member.id === memberId)
		assert.equal(back.status, 'inactive', '恢复显示后成员是 inactive（原生子代理已释放）')
	} finally { rmSync(dir, { recursive: true, force: true }) }
})
async function setupWithMember() {
	const dir = mkdtempSync(join(tmpdir(), 'agrp-group-'))
	const host = makeHost()
	const service = createGroupService(host.ctx, { registryFile: join(dir, 'groups.json') })
	host.state.sessions.set('session-g', { id: 'session-g', header: { cwd: 'D:\\work', agentPreset: 'minimal' } })
	const created = await service.createGroup({ session_id: 'session-g', cwd: 'D:\\work', name: '验证群' })
	const pulled = await service.pull({ group_id: created.id, preset_id: 'se' })
	return { dir, host, service, groupId: created.id, memberId: pulled.member_id }
}
await check('群主离线时移除：只标记名册并给出说明', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'agrp-group-'))
	try {
		const { host, service, groupId, memberId } = await setupWithMember()
		host.state.agents.clear()
		const released = await service.release({ group_id: groupId, member_id: memberId })
		assert.equal(released.ok, true)
		assert.equal(released.released, false)
		assert.match(released.note, /未驻留/)
	} finally { rmSync(dir, { recursive: true, force: true }) }
})
console.log('group: 标题自愈（👥 前缀）')
await check('在线群会话缺 👥 前缀时自愈，且不重复刷', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'agrp-group-'))
	try {
		const host = makeHost()
		host.state.sessions.set('session-g', { id: 'session-g', header: { cwd: 'D:\\work', agentPreset: 'minimal' } })
		const service = createGroupService(host.ctx, { registryFile: join(dir, 'groups.json') })
		await service.createGroup({ session_id: 'session-g', cwd: 'D:\\work', name: '验证群' })
		assert.ok(host.state.titles.some((row) => row.title === '👥 验证群'), '建群即写 👥 标题: ' + JSON.stringify(host.state.titles))
		// 模拟"老群"：当前标题里没有 👥 前缀（只清日志不够，要清真正的当前标题）
		host.state.titles.length = 0
		host.state.titleBySession.clear()
		await service.state()
		const renamed = host.state.titles.filter((row) => row.title === '👥 验证群').length
		assert.ok(renamed >= 1, 'state() 应自愈标题')
		const before = host.state.titles.length
		await service.state()
		await service.state()
		assert.equal(host.state.titles.length, before, '标题已正确时不再刷')
	} finally { rmSync(dir, { recursive: true, force: true }) }
})
await check('pull 自愈标题：拉人时老群的标题也会补上', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'agrp-group-'))
	try {
		const host = makeHost()
		host.state.sessions.set('session-g', { id: 'session-g', header: { cwd: 'D:\\work', agentPreset: 'minimal' } })
		const service = createGroupService(host.ctx, { registryFile: join(dir, 'groups.json') })
		const created = await service.createGroup({ session_id: 'session-g', cwd: 'D:\\work', name: '验证群' })
		host.state.titles.length = 0
		host.state.titleBySession.clear()
		const pulled = await service.pull({ group_id: created.id, preset_id: 'se' })
		assert.equal(pulled.ok, true, pulled.error)
		assert.equal(host.state.titleBySession.get(created.id), '👥 验证群', '拉人应自愈标题')
	} finally { rmSync(dir, { recursive: true, force: true }) }
})
await check('解散：释放成员 + 归档会话 + 清注册表', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'agrp-group-'))
	try {
		const { host, service, groupId, memberId } = await setupWithMember()
		const dissolved = await service.dissolve({ group_id: groupId })
		assert.equal(dissolved.ok, true, dissolved.error)
		assert.equal(dissolved.drained, 1)
		assert.equal(dissolved.archived, true)
		assert.deepEqual(host.state.drained[0].ids, [memberId])
		assert.deepEqual(host.state.archived, [groupId])
		assert.deepEqual((await service.state()).groups, [])
	} finally { rmSync(dir, { recursive: true, force: true }) }
})
await check('解散：持有句柄时把群主 agent 也下线（否则归档删除会跳过整族）', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'agrp-group-'))
	try {
		const host = makeHost({ noController: true })
		host.state.sessions.set('session-g', { id: 'session-g', header: { cwd: 'D:\\work', agentPreset: 'minimal' } })
		const service = createGroupService(host.ctx, { registryFile: join(dir, 'groups.json') })
		const created = await service.createGroup({ session_id: 'session-g', name: '验证群' })
		assert.equal(created.ok, true, created.error)
		assert.equal(host.state.resumes.length, 1, '兜底路径自己 resume（这条路径句柄归我们）')
		const dissolved = await service.dissolve({ group_id: created.id })
		assert.equal(dissolved.owner_released, 'disposed')
		assert.deepEqual(host.state.disposed, [created.id])
		assert.equal(dissolved.owner_live, false)
		assert.equal(dissolved.delete_hint, undefined, '群主已下线，不需要重启提示')
	} finally { rmSync(dir, { recursive: true, force: true }) }
})
await check('解散：句柄不在我们手里（GUI 拉的）时如实报告仍需重启', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'agrp-group-'))
	try {
		const host = makeHost()
		host.state.sessions.set('session-g', { id: 'session-g', header: { cwd: 'D:\\work', agentPreset: 'minimal' } })
		const service = createGroupService(host.ctx, { registryFile: join(dir, 'groups.json') })
		const created = await service.createGroup({ session_id: 'session-g', name: '验证群' })
		const dissolved = await service.dissolve({ group_id: created.id })
		assert.equal(dissolved.owner_released, 'not-owned')
		assert.equal(dissolved.owner_live, true)
		assert.match(dissolved.delete_hint, /重启一次 DSH/)
	} finally { rmSync(dir, { recursive: true, force: true }) }
})
await check('改名：注册表 + 会话标题（带 👥 前缀）一起改', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'agrp-group-'))
	try {
		const { host, service, groupId } = await setupWithMember()
		const renamed = await service.renameGroup({ group_id: groupId, name: '前端小组' })
		assert.equal(renamed.ok, true)
		const last = host.state.titles[host.state.titles.length - 1]
		assert.equal(last.title, '👥 前端小组')
		assert.equal((await service.state()).groups[0].name, '前端小组')
	} finally { rmSync(dir, { recursive: true, force: true }) }
})
await check('members()：@ 菜单拿某个会话自己的常驻成员', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'agrp-group-'))
	try {
		const host = makeHost()
		const service = createGroupService(host.ctx, { registryFile: join(dir, 'groups.json') })
		host.state.children.set('session-x', [{ kind: 'child', id: 'c1', label: 'SE', activity: 'running', mode: 'continuable' }])
		const payload = await service.members({ sessionId: 'session-x' })
		assert.equal(payload.ok, true)
		assert.deepEqual(payload.members, [{ id: 'c1', name: 'SE', status: 'running', mode: 'continuable' }])
	} finally { rmSync(dir, { recursive: true, force: true }) }
})

const failed = results.filter((row) => !row.ok)
console.log('')
console.log(failed.length === 0 ? 'ALL PASS (' + results.length + ')' : failed.length + ' FAILED of ' + results.length)
process.exit(failed.length === 0 ? 0 : 1)
