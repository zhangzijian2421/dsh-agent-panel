/**
 * 宿主链路端到端测试：`apply()` 挂载真实插件 → 用**假 req/res 打真实路由** → 桩宿主提供
 * agents / subagents / agentPresets / sessions / sessionController / sessionTitle / workspaceRegistry。
 *
 * 这一层覆盖前面几套测试各自的缝：
 *   - client-panel 只证明"客户端发的字段名"是对的；
 *   - group-service 只证明"服务收到正确参数时行为对"；
 *   - 本套证明 **路由 ↔ 服务** 之间真的接上了（字段名、cwd 从 session_id 解析、模型工具路径）。
 *
 * 注册表落在临时 HOME 下（改 USERPROFILE，`os.homedir()` 每次调用都重读），不会碰用户真实状态。
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
function check(label, fn) {
	return Promise.resolve()
		.then(fn)
		.then(() => { results.push({ label, ok: true }); console.log('  ok   ' + label) })
		.catch((error) => { results.push({ label, ok: false }); console.log('  FAIL ' + label + ' → ' + String((error && error.message) || error)) })
}

const PRESETS = [
	{ id: 'standard', name: '标准模式', description: '完整编码 agent', trust: 'system' },
	{ id: 'minimal', name: '极简模式', description: '只有 shell', trust: 'system' },
	{ id: 'se', name: 'SE 需求分析', description: '只做需求分析', trust: 'user' }
]
const SE_DOC = ['- id: persona', '  prefix: |', '    你是 SE，只做需求分析与方案设计。', '- id: tools', '  mode: standard'].join('\n')

function makeHarness() {
	const state = {
		agents: new Map(),
		children: new Map(),
		sessions: new Map([['session-me', { id: 'session-me', header: { cwd: 'D:\\work' } }]]),
		titles: [],
		archived: [],
		specs: [],
		ensureCalls: [],
		drained: []
	}
	const routes = []
	const tools = []
	let child = 0
	const ctx = {
		webServer: { register(route) { routes.push(route); return () => {} } },
		effect(callback) { const disposer = callback(); return () => { if (typeof disposer === 'function') disposer() } },
		inject() {},
		get(service) {
			if (service === 'tools') {
				return { register(definition) { tools.push(definition); return () => {} } }
			}
			if (service === 'agents') {
				return {
					get: (id) => state.agents.get(id),
					async create(options) {
						if (typeof options.setup === 'function') await options.setup({})
						const agent = { id: options.sessionId, cwd: options.meta.cwd, preset: options.meta.agentPreset }
						state.agents.set(agent.id, agent)
						state.sessions.set(agent.id, { id: agent.id, header: { cwd: options.meta.cwd } })
						return { agent }
					},
					async resume(options) {
						if (typeof options.setup === 'function') await options.setup({})
						const agent = { id: options.resumeSessionId, cwd: 'D:\\work', preset: 'standard' }
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
					async mount() { return {} }
				}
			}
			if (service === 'sessions') {
				return { get: (id) => state.sessions.get(id) }
			}
			if (service === 'sessionController') {
				return {
					async ensureSession(id, cwd, check, preset) {
						state.ensureCalls.push({ id, cwd, preset })
						const agent = { id, cwd, preset }
						state.agents.set(id, agent)
						state.sessions.set(id, { id, header: { cwd } })
						return agent
					}
				}
			}
			if (service === 'sessionTitle') {
				return { rename: (session, title) => { state.titles.push({ id: session.id, title }) } }
			}
			if (service === 'workspaceRegistry') {
				return { async archiveSession(id) { state.archived.push(id) } }
			}
			return undefined
		}
	}
	apply(ctx)
	return { state, routes, tools, ctx }
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

console.log('e2e: 建群（session_id → cwd 解析）')
await check('POST /group-create：用当前会话的 cwd 建出群主会话 + 写注册表 + 改标题', async () => {
	const created = await call(harness.routes, '/api/dsh-agent-panel/group-create', 'POST', { session_id: 'session-me' })
	assert.equal(created.ok, true, created.error)
	assert.match(created.id, /^group-/)
	assert.equal(created.name, '群聊 · 1')
	assert.equal(created.preset_id, 'standard')
	assert.equal(created.cwd, 'D:\\work', 'cwd 应从 session_id 的会话头解析出来')
	groupId = created.id
	assert.deepEqual(harness.state.ensureCalls, [{ id: created.id, cwd: 'D:\\work', preset: 'standard' }])
	assert.equal(harness.state.titles[0].title, '群聊 · 1')
	assert.equal(existsSync(registryFile), true, '注册表应落在临时 HOME 下')
	const registry = JSON.parse(readFileSync(registryFile, 'utf8'))
	assert.equal(registry.groups[created.id].presetId, 'standard')
	assert.equal(registry.groups[created.id].members.length, 0)
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
	assert.match(pulled.capability, /群主 preset（standard）/)
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
	assert.equal(snapshot.default_group_preset, 'standard')
	assert.equal(snapshot.groups.length, 1)
	const row = snapshot.groups[0]
	assert.equal(row.id, groupId)
	assert.equal(row.owner_live, true)
	assert.equal(row.members.length, 2)
	assert.equal(row.members[0].status, 'running', '原生子代理行被判为 running')
	assert.equal(row.members[0].registered, true)
	assert.equal(row.preset_id, 'standard')
	assert.equal(snapshot.presets.length, 3)
})
await check('GET /members?sessionId=：@ 菜单源拿到本会话成员', async () => {
	const payload = await call(harness.routes, '/api/dsh-agent-panel/members', 'GET', undefined, 'sessionId=' + groupId)
	assert.equal(payload.ok, true)
	assert.equal(payload.members.length, 2)
	assert.equal(payload.members[0].name, 'SE 需求分析')
})

console.log('e2e: 移除 / 恢复 / 改名 / 解散')
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
	assert.equal(harness.state.titles[harness.state.titles.length - 1].title, '前端小组')
	assert.equal(JSON.parse(readFileSync(registryFile, 'utf8')).groups[groupId].name, '前端小组')
})

console.log('e2e: 模型工具')
await check('group_pull：不带 preset_id 时返回状态；带则真的拉人', async () => {
	const tool = harness.tools.find((item) => item.name === 'group_pull')
	assert.ok(tool !== undefined, '缺少 group_pull')
	const snapshot = JSON.parse(await tool.execute({}))
	assert.equal(snapshot.groups.length, 1)
	const pulled = JSON.parse(await tool.execute({ group_id: groupId, preset_id: 'minimal' }))
	assert.equal(pulled.ok, true)
	assert.equal(pulled.name, '极简模式')
})
await check('group_create：cwd 缺省时从执行上下文（当前会话）取', async () => {
	const tool = harness.tools.find((item) => item.name === 'group_create')
	assert.ok(tool !== undefined, '缺少 group_create')
	const created = JSON.parse(await tool.execute({ name: '第二个群' }, { agent: { session: { header: { cwd: 'D:\\other' } } } }))
	assert.equal(created.ok, true)
	assert.equal(created.cwd, 'D:\\other')
	assert.equal(created.name, '第二个群')
	const noCwd = await tool.execute({}, undefined)
	assert.match(String(noCwd), /需要 cwd/)
})

console.log('e2e: 解散与收尾')
await check('POST /group-dissolve：释放成员 + 归档会话 + 清注册表', async () => {
	const dissolved = await call(harness.routes, '/api/dsh-agent-panel/group-dissolve', 'POST', { group_id: groupId })
	assert.equal(dissolved.ok, true, dissolved.error)
	assert.equal(dissolved.drained, 3, '三个成员：两次面板拉人 + 一次模型工具拉人')
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
