/**
 * 宿主链路端到端测试（v2.2：空会话变成群聊）：`apply()` 挂载真实插件 → 假 req/res 打真实路由 →
 * 桩宿主提供 agents / subagents / agentPresets / sessions / sessionController / sessionTitle /
 * workspaceRegistry。覆盖 路由 ↔ 服务 ↔ 注册表 的整条链，以及两个模型工具。
 *
 * 注册表落在临时 HOME 下（改 USERPROFILE，`os.homedir()` 每次调用都重读），不碰用户真实状态。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const home = mkdtempSync(join(tmpdir(), 'agrp-e2e-'))
const previousProfile = process.env.USERPROFILE
process.env.USERPROFILE = home

const { apply } = await import('../lib/index.js')

const results = []
async function check(label, fn) {
	try {
		await fn()
		results.push({ label, ok: true })
		console.log('  ok   ' + label)
	} catch (error) {
		results.push({ label, ok: false })
		console.log('  FAIL ' + label + ' → ' + String((error && error.message) || error))
		console.log(String((error && error.stack) || error).split('\n').slice(0, 4).join('\n'))
	}
}

const PRESETS = [
	{ id: 'group-host', name: '群聊 Agent', description: '群聊主控：盘点成员能力边界并派活', trust: 'user' },
	{ id: 'standard', name: '标准模式', description: '完整编码 agent', trust: 'system' },
	{ id: 'minimal', name: '极简模式', description: '只有 shell', trust: 'system' },
	{ id: 'se', name: 'SE 需求分析', description: '只做需求分析', trust: 'user' }
]
const SE_DOC = ['- id: persona', '  prefix: |', '    你是 SE，只做需求分析与方案设计。', '- id: tools', '  mode: standard'].join('\n')

function makeHarness() {
	const state = {
		agents: new Map(),
		children: new Map(),
		sessions: new Map([['session-me', { id: 'session-me', header: { cwd: 'D:\\work', agentPreset: 'minimal' } }]]),
		titles: [],
		archived: [],
		specs: [],
		ensureCalls: [],
		drained: [],
		presetByAgent: new Map(),
		workspaces: [{
			id: 'ws-1', path: 'D:\\work', title: '项目A', sessionIds: ['session-me'],
			async attachSession(sessionId) { state.workspaces[0].sessionIds = [String(sessionId), ...state.workspaces[0].sessionIds] }
		}]
	}
	const routes = []
	const tools = []
	let child = 0
	const ctx = {
		webServer: { register(route) { routes.push(route); return () => {} } },
		effect(callback) { const disposer = callback(); return () => { if (typeof disposer === 'function') disposer() } },
		inject() {},
		get(service) {
			if (service === 'tools') return { register(definition) { tools.push(definition); return () => {} } }
			if (service === 'agents') {
				return {
					get: (id) => state.agents.get(id),
					async create(options2) {
						if (typeof options2.setup === 'function') await options2.setup({ agentId: options2.sessionId })
						const agent = makeAgent(options2.sessionId, options2.meta.cwd, options2.meta.agentPreset)
						state.agents.set(agent.id, agent)
						state.sessions.set(agent.id, { id: agent.id, header: { cwd: options2.meta.cwd, agentPreset: options2.meta.agentPreset } })
						return { agent }
					},
					async resume(options2) {
						if (typeof options2.setup === 'function') await options2.setup({ agentId: options2.resumeSessionId })
						const agent = makeAgent(options2.resumeSessionId, 'D:\\work', 'standard')
						state.agents.set(agent.id, agent)
						return { agent }
					}
				}
			}
			if (service === 'subagents') {
				return {
					async listChildren(id) { return state.children.get(id) || [] },
					async startContinuable(spec) {
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
			if (service === 'agentPresets') {
				return {
					async list() { return PRESETS },
					async read(id) { return id === 'se' ? SE_DOC : '' },
					async mount(agentCtx, id) { state.presetByAgent.set(String(agentCtx.agentId), String(id)); return { id } },
					composedPreset(agentCtx) { return state.presetByAgent.get(String(agentCtx.agentId)) || null },
					async select(agent, id) {
						state.selects = state.selects || []
						state.selects.push({ agent: String(agent.id), preset: String(id) })
						state.presetByAgent.set(String(agent.id), String(id))
						return String(id)
					}
				}
			}
			if (service === 'sessions') return { get: (id) => state.sessions.get(id) }
			if (service === 'sessionController') {
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
			if (service === 'sessionTitle') return { rename: (session, title) => { state.titles.push({ id: session.id, title }) } }
			if (service === 'workspaceRegistry') {
				return {
					list: () => state.workspaces,
					get: (id) => state.workspaces.find((item) => String(item.id) === String(id)),
					async archiveSession(id) { state.archived.push(id) }
				}
			}
			return undefined
		}
	}
	apply(ctx)
	return { state, routes, tools, ctx }
}

function makeAgent(id, cwd, preset) {
	return {
		id,
		ctx: { agentId: id },
		options: { provider: 'deepseek-official', model: 'deepseek-flash' },
		session: { header: { cwd, agentPreset: preset } }
	}
}

/** 用假 req/res 打真实路由。 */
async function call(routes, path, method, body, query) {
	const route = routes.find((item) => item.path === path)
	if (route === undefined) throw new Error('没有注册路由：' + path)
	const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
	const req = {
		method,
		url: path + (query === undefined ? '' : '?' + query),
		socket: { remoteAddress: '127.0.0.1' },
		on(event, handler) {
			if (event === 'data') { for (const chunk of chunks) handler(chunk) }
			if (event === 'end') handler()
			return this
		},
		destroy() {}
	}
	const captured = { status: 0, body: '' }
	const res = { writeHead(status) { captured.status = status }, end(text) { captured.body = String(text === undefined ? '' : text) } }
	await route.handler(req, res)
	assert.equal(captured.status, 200, path + ' 应返回 200，实际 ' + captured.status + ' body=' + captured.body)
	return JSON.parse(captured.body)
}

const harness = makeHarness()
const registryFile = join(home, '.dsh', 'dsh-agent-panel', 'groups.json')
let groupId = ''
let memberId = ''

console.log('e2e: 建群（空会话变成群聊）')
await check('POST /group-create：把当前会话变成群聊 + 原生 select 换成固定的群主 preset + 👥 标题 + 注册表', async () => {
	// 即使调用方传了 preset_id，群主 preset 也固定为 group-host。
	const created = await call(harness.routes, '/api/dsh-agent-panel/group-create', 'POST', { session_id: 'session-me', preset_id: 'minimal' })
	assert.equal(created.ok, true, created.error)
	assert.equal(created.id, 'session-me', '群 = 这个空会话本身')
	assert.equal(created.name, '群聊 · 1')
	assert.equal(created.title, '👥 群聊 · 1', '侧边栏标题带 👥 前缀')
	assert.equal(created.preset_id, 'group-host')
	assert.equal(created.preset_error, undefined, '空白会话能正常换成固定的群主 preset')
	groupId = created.id
	assert.deepEqual(harness.state.ensureCalls, [{ id: 'session-me', cwd: 'D:\\work', check: true, preset: 'minimal' }], '先按会话自己的 preset 启动')
	assert.deepEqual(harness.state.selects, [{ agent: 'session-me', preset: 'group-host' }], '再用空白特权换成固定的群主 preset')
	assert.deepEqual(harness.state.titles, [{ id: 'session-me', title: '👥 群聊 · 1' }])
	assert.equal(existsSync(registryFile), true, '注册表应落在临时 HOME 下')
	const registry = JSON.parse(readFileSync(registryFile, 'utf8'))
	assert.equal(registry.groups['session-me'].presetId, 'group-host')
	assert.equal(registry.groups['session-me'].members.length, 0)
})

console.log('e2e: 拉人')
await check('POST /pull：成员挂到群主会话下，persona/黑名单/maxDepth 正确，注册表记下 preset', async () => {
	const pulled = await call(harness.routes, '/api/dsh-agent-panel/pull', 'POST', { group_id: groupId, preset_id: 'se' })
	assert.equal(pulled.ok, true, pulled.error)
	memberId = pulled.member_id
	assert.equal(pulled.name, 'SE 需求分析')
	const spec = harness.state.specs[0]
	assert.equal(spec.request.parent.id, groupId, '父代理必须是群主会话')
	assert.equal(spec.label, 'SE 需求分析')
	assert.equal(spec.request.maxDepth, 1)
	assert.match(spec.request.persona, /只做需求分析/)
	assert.ok(spec.request.toolFilter.deny.indexOf('group_pull') >= 0)
	assert.match(pulled.capability, /群主 preset（group-host）/)
	const registry = JSON.parse(readFileSync(registryFile, 'utf8'))
	assert.equal(registry.groups[groupId].members[0].presetId, 'se')
	assert.equal(registry.groups[groupId].members[0].childId, memberId)
})
await check('POST /pull：未指定名称时自动去重', async () => {
	const again = await call(harness.routes, '/api/dsh-agent-panel/pull', 'POST', { group_id: groupId, preset_id: 'se' })
	assert.equal(again.name, 'SE 需求分析-2')
})

console.log('e2e: 状态与 @ 菜单')
await check('GET /state：群、成员状态、preset 列表、默认群主 preset 都在', async () => {
	const snapshot = await call(harness.routes, '/api/dsh-agent-panel/state', 'GET')
	assert.equal(snapshot.default_group_preset, 'group-host')
	assert.equal(snapshot.groups.length, 1)
	const row = snapshot.groups[0]
	assert.equal(row.id, groupId)
	assert.equal(row.owner_live, true)
	assert.equal(row.members.length, 2)
	assert.equal(row.members[0].status, 'running', '原生子代理行被判为 running')
	assert.equal(row.members[0].registered, true)
	assert.equal(row.preset_id, 'group-host')
	assert.equal(snapshot.presets.length, 4)
})
await check('GET /members?sessionId=：@ 菜单源拿到本会话成员', async () => {
	const payload = await call(harness.routes, '/api/dsh-agent-panel/members', 'GET', undefined, 'sessionId=' + groupId)
	assert.equal(payload.ok, true)
	assert.equal(payload.members.length, 2)
	assert.equal(payload.members[0].name, 'SE 需求分析')
})

console.log('e2e: 归属与移除')
await check('POST /group-attach 路由已在 v2.2 移除（不需要单独归属）', async () => {
	assert.equal(harness.routes.some((item) => item.path.endsWith('/group-attach')), false, 'group-attach 路由不应存在')
})
await check('POST /release：释放原生子代理 + 名册软删除', async () => {
	const released = await call(harness.routes, '/api/dsh-agent-panel/release', 'POST', { group_id: groupId, member_id: memberId })
	assert.equal(released.ok, true, released.error)
	assert.equal(released.released, true)
	assert.deepEqual(harness.state.drained[0], { parent: groupId, ids: [memberId] })
	const snapshot = await call(harness.routes, '/api/dsh-agent-panel/state', 'GET')
	const row = snapshot.groups[0]
	assert.deepEqual(row.members.map((member) => member.id), ['child-2'])
	assert.deepEqual(row.removed.map((member) => member.id), [memberId])
})
await check('POST /restore：回到 active 名册（状态为 inactive，因为原生子代理已释放）', async () => {
	const restored = await call(harness.routes, '/api/dsh-agent-panel/restore', 'POST', { group_id: groupId, member_id: memberId })
	assert.equal(restored.ok, true)
	const snapshot = await call(harness.routes, '/api/dsh-agent-panel/state', 'GET')
	const row = snapshot.groups[0]
	assert.deepEqual(row.removed, [])
	const back = row.members.find((member) => member.id === memberId)
	assert.equal(back.status, 'inactive')
})
await check('POST /group-rename：注册表 + 会话标题一起改', async () => {
	const renamed = await call(harness.routes, '/api/dsh-agent-panel/group-rename', 'POST', { group_id: groupId, name: '前端小组' })
	assert.equal(renamed.ok, true)
	assert.equal(harness.state.titles[harness.state.titles.length - 1].title, '👥 前端小组')
	assert.equal(JSON.parse(readFileSync(registryFile, 'utf8')).groups[groupId].name, '前端小组')
})

console.log('e2e: 模型工具')
await check('group_pull：不带 preset_id 时返回状态；带则真的拉人', async () => {
	const tool = harness.tools.find((item) => item.name === 'group_pull')
	assert.ok(tool !== undefined, '缺少 group_pull')
	const snapshot = JSON.parse(await tool.execute({}))
	assert.equal(snapshot.groups.length, 1)
	assert.equal(snapshot.groups.length, 1)
	const raw = await tool.execute({ preset_id: 'minimal', group_id: groupId }, { agent: { session: { header: { id: groupId } } } })
	console.log('DEBUG raw:', String(raw).slice(0, 300))
	const pulled = JSON.parse(raw)
	assert.equal(pulled.ok, true, pulled.error)
	assert.equal(pulled.name, '极简模式')
})
await check('group_create：session_id 缺省时用执行上下文的 agent id', async () => {
	const tool = harness.tools.find((item) => item.name === 'group_create')
	assert.ok(tool !== undefined, '缺少 group_create')
	harness.state.sessions.set('session-agent-call', { id: 'session-agent-call', header: { cwd: 'D:\\work', agentPreset: 'minimal' } })
	const created = JSON.parse(await tool.execute({ name: '第二个群' }, { agent: { id: 'session-agent-call' } }))
	assert.equal(created.ok, true, created.error)
	assert.equal(created.id, 'session-agent-call')
	const missing = await tool.execute({}, undefined)
	assert.match(String(missing), /无法确定当前会话/)
})

console.log('e2e: 解散与收尾')
await check('POST /group-dissolve：释放成员 + 归档会话 + 清注册表', async () => {
	const dissolved = await call(harness.routes, '/api/dsh-agent-panel/group-dissolve', 'POST', { group_id: groupId })
	assert.equal(dissolved.ok, true, dissolved.error)
	assert.equal(dissolved.drained, 3, '三次拉人：面板两次 + 模型工具一次')
	assert.equal(dissolved.archived, true)
	assert.ok(harness.state.archived.indexOf(groupId) >= 0)
	const registry = JSON.parse(readFileSync(registryFile, 'utf8'))
	assert.equal(registry.groups[groupId], undefined)
	const snapshot = await call(harness.routes, '/api/dsh-agent-panel/state', 'GET')
	assert.deepEqual(snapshot.groups.map((row) => row.name), ['第二个群'])
})
await check('注册表落在临时 HOME（没有污染真实 ~/.dsh）', () => {
	assert.equal(registryFile.indexOf(home), 0)
	assert.equal(existsSync(registryFile), true)
})

if (previousProfile === undefined) delete process.env.USERPROFILE
else process.env.USERPROFILE = previousProfile
rmSync(home, { recursive: true, force: true })

const failed = results.filter((row) => !row.ok)
console.log('')
console.log(failed.length === 0 ? 'ALL PASS (' + results.length + ')' : failed.length + ' FAILED of ' + results.length)
process.exit(failed.length === 0 ? 0 : 1)
