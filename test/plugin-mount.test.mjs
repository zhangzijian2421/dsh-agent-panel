/**
 * 宿主外壳冒烟测试：不依赖活体 harness，也能验证 v2 的接线。
 *
 * 覆盖：插件身份（name/inject）、8 条路由与 2 个模型工具的注册、loopback 围栏、
 * 方法校验、GET 查询串解析、以及"服务全缺席时 state 降级成空列表"这条最容易回归的路径。
 *
 * 注册表路径取自 `os.homedir()`（每次调用重读），所以这里把 USERPROFILE 指到临时目录：
 * 否则测试会读到**用户真实**的 `~/.dsh/dsh-agent-panel/groups.json`，断言随实际群聊数量漂移。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject, installMentionFilter, name } from '../lib/index.js'
import { MEMBER_TOOL_DENY } from '../lib/group.js'

const home = mkdtempSync(join(tmpdir(), 'agrp-mount-'))
const previousProfile = process.env.USERPROFILE
process.env.USERPROFILE = home

const results = []
function check(label, fn) {
	return Promise.resolve()
		.then(fn)
		.then(() => { results.push({ label, ok: true }); console.log('  ok   ' + label) })
		.catch((error) => { results.push({ label, ok: false }); console.log('  FAIL ' + label + ' → ' + String((error && error.message) || error)) })
}

function mount(options) {
	const routes = []
	const tools = []
	const ctx = {
		webServer: {
			register(route) { routes.push(route); return () => {} }
		},
		effect(callback) { const disposer = callback(); return () => { if (typeof disposer === 'function') disposer() } },
		inject() {},
		get(service) {
			if (service === 'tools') return { register(definition) { tools.push(definition); return () => {} } }
			if (service === 'sessionReferenceResolver' && options && options.resolver) return options.resolver
			return undefined
		}
	}
	apply(ctx)
	return { routes, tools }
}

/** 造一对最小的 req/res，直接跑路由 handler。 */
function invoke(route, method, url, body) {
	const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
	const req = {
		method,
		url,
		socket: { remoteAddress: (arguments.length > 4 && arguments[4]) || '127.0.0.1' },
		on(event, handler) {
			if (event === 'data') { for (const chunk of chunks) handler(chunk) }
			if (event === 'end') handler()
			return this
		},
		destroy() {}
	}
	const captured = { status: 0, body: '' }
	const res = {
		writeHead(status) { captured.status = status },
		end(text) { captured.body = String(text === undefined ? '' : text) }
	}
	return Promise.resolve(route.handler(req, res)).then(() => ({
		status: captured.status,
		json: captured.body.length === 0 ? undefined : JSON.parse(captured.body)
	}))
}

console.log('plugin shell')
await check('身份：name 与 inject', () => {
	assert.equal(name, 'dsh-agent-panel')
	assert.deepEqual(inject, ['webServer'])
})
await check('注册 8 条 exact 路由 + 2 个模型工具', () => {
	const { routes, tools } = mount()
	assert.equal(routes.length, 8)
	for (const route of routes) {
		assert.equal(route.kind, 'exact')
		assert.equal(typeof route.path, 'string')
		assert.equal(typeof route.handler, 'function')
	}
	assert.deepEqual(routes.map((route) => route.path).sort(), [
		'/api/dsh-agent-panel/group-create',
		'/api/dsh-agent-panel/group-dissolve',
		'/api/dsh-agent-panel/group-rename',
		'/api/dsh-agent-panel/members',
		'/api/dsh-agent-panel/pull',
		'/api/dsh-agent-panel/release',
		'/api/dsh-agent-panel/restore',
		'/api/dsh-agent-panel/state'
	])
	assert.deepEqual(tools.map((tool) => tool.name).sort(), ['group_create', 'group_pull'])
	for (const tool of tools) {
		assert.equal(typeof tool.execute, 'function')
		assert.equal(tool.parameters.type, 'object')
		assert.equal(typeof tool.output.render, 'function')
	}
})

console.log('plugin shell: routing')
await check('state 路由：服务全缺席也返回空群列表而不是崩', async () => {
	const { routes } = mount()
	const route = routes.find((item) => item.path.endsWith('/state'))
	const response = await invoke(route, 'GET', '/api/dsh-agent-panel/state')
	assert.equal(response.status, 200)
	assert.deepEqual(response.json.groups, [])
	assert.equal(response.json.default_group_preset, 'standard')
	assert.deepEqual(response.json.caps, {
		sessions: false, agents: false, subagents: false, agentPresets: false, sessionController: false
	})
})
await check('loopback 围栏：非本机地址 403', async () => {
	const { routes } = mount()
	const route = routes.find((item) => item.path.endsWith('/state'))
	const response = await invoke(route, 'GET', '/api/dsh-agent-panel/state', undefined, '10.0.0.7')
	assert.equal(response.status, 403)
	assert.match(response.json.error, /loopback-only/)
})
await check('方法校验：GET 路由收到 POST 是 405', async () => {
	const { routes } = mount()
	const route = routes.find((item) => item.path.endsWith('/state'))
	const response = await invoke(route, 'POST', '/api/dsh-agent-panel/state', {})
	assert.equal(response.status, 405)
})
await check('members 路由：GET 查询串解析出 sessionId', async () => {
	const { routes } = mount()
	const route = routes.find((item) => item.path.endsWith('/members'))
	const response = await invoke(route, 'GET', '/api/dsh-agent-panel/members?sessionId=session-abc')
	assert.equal(response.status, 200)
	assert.equal(response.json.ok, true)
	assert.equal(response.json.sessionId, 'session-abc')
	assert.deepEqual(response.json.members, [])
})
await check('pull 路由：POST JSON 体解析 + 参数缺失时报错进 200 业务结果', async () => {
	const { routes } = mount()
	const route = routes.find((item) => item.path.endsWith('/pull'))
	const response = await invoke(route, 'POST', '/api/dsh-agent-panel/pull', { preset_id: 'se' })
	assert.equal(response.status, 200)
	assert.equal(response.json.ok, false)
	assert.match(response.json.error, /需要 group_id/)
})
await check('坏 JSON 体不炸：当成空参数处理', async () => {
	const { routes, tools } = mount()
	const route = routes.find((item) => item.path.endsWith('/group-create'))
	const req = {
		method: 'POST',
		url: '/api/dsh-agent-panel/group-create',
		socket: { remoteAddress: '127.0.0.1' },
		on(event, handler) {
			if (event === 'data') handler(Buffer.from('{ this is not json', 'utf8'))
			if (event === 'end') handler()
			return this
		},
		destroy() {}
	}
	const captured = {}
	const res = { writeHead(status) { captured.status = status }, end(text) { captured.body = String(text) } }
	await route.handler(req, res)
	assert.equal(captured.status, 200)
	const payload = JSON.parse(captured.body)
	assert.equal(payload.ok, false)
	assert.match(payload.error, /需要 session_id|没有工作目录|工作目录/)
	assert.equal(tools.length, 2)
})

console.log('plugin shell: 成员黑名单与本包工具面一致')
await check('黑名单里属于本包的 tool 名必须真的注册过（防 v1 残留名）', () => {
	const { tools } = mount()
	const registered = new Set(tools.map((tool) => tool.name))
	// 只检查"看起来属于本包"的名字：其余（list_agents / interrupt_agent / ask_user_question）
	// 由别的插件提供，本包无法在离线测试里断言它们存在。
	const ours = MEMBER_TOOL_DENY.filter((toolName) => toolName.startsWith('group_') || toolName.startsWith('agrp_'))
	assert.ok(ours.length > 0, '黑名单应至少包含本包自己的拉人/建群工具')
	for (const toolName of ours) {
		assert.ok(registered.has(toolName), '黑名单里的 ' + toolName + ' 并不存在——tools.restrict() 会因此拒绝整个名单')
	}
	assert.equal(MEMBER_TOOL_DENY.includes('agrp_pull'), false, 'v1 的 agrp_pull 已删除，不应留在黑名单里')
	assert.equal(MEMBER_TOOL_DENY.includes('group_invite'), false, 'v1 的 group_invite 已删除，不应留在黑名单里')
})

console.log('plugin shell: mention filter hook')
await check('resolver 缺席时返回 undefined（交给 inject 等待）', () => {
	const { routes } = mount()
	assert.equal(routes.length, 8)
	assert.equal(installMentionFilter({ get: () => undefined }), undefined)
})
await check('resolver 就位时安装可回滚的过滤', async () => {
	const original = async () => [{ sessionId: 'a' }, { sessionId: 'b' }]
	const resolver = { listCandidates: original, ctx: { sessionQuery: { listSessions: async () => [] } } }
	const { routes } = mount({ resolver })
	assert.equal(routes.length, 8)
	assert.notEqual(resolver.listCandidates, original, '实例方法被替换')
	const rows = await resolver.listCandidates({ id: 'me' }, '', 10, undefined)
	assert.equal(rows.length, 2)
})

if (previousProfile === undefined) delete process.env.USERPROFILE
else process.env.USERPROFILE = previousProfile
rmSync(home, { recursive: true, force: true })

const failed = results.filter((row) => !row.ok)
console.log('')
console.log(failed.length === 0 ? 'ALL PASS (' + results.length + ')' : failed.length + ' FAILED of ' + results.length)
process.exit(failed.length === 0 ? 0 : 1)
