/**
 * dsh-agent-panel — 宿主半边（v2：群聊在 session 之上）。
 *
 * 模型：**群聊 = 一个由本插件创建的独立群主会话**，成员 = 它的具名常驻子代理，
 * 频道 = 群主会话自己的记录，名册/状态 = 原生子代理目录，唤醒 = 群主 agent 自带的
 * `send_message`。插件只保留"哪些会话是群"这一份注册表（见 ./store.js）。
 *
 * 提供的面：
 *  - GET  /api/dsh-agent-panel/state          群聊列表 + 成员 + 已安装 preset
 *  - POST /api/dsh-agent-panel/group-create   建群（root 群主会话，可指定 preset）
 *  - POST /api/dsh-agent-panel/group-rename   改群名（同时写会话标题）
 *  - POST /api/dsh-agent-panel/group-dissolve 解散（释放成员 + 归档会话 + 清注册表）
 *  - POST /api/dsh-agent-panel/pull           把已安装 preset 拉成群成员
 *  - POST /api/dsh-agent-panel/release        移除成员（原生 release + 名册软删除）
 *  - POST /api/dsh-agent-panel/restore        恢复显示
 *  - GET  /api/dsh-agent-panel/members        某会话自己的常驻成员（`@` 菜单用）
 *  - 模型工具 group_pull / group_create（成员被黑名单挡住，只有群主/宿主能用）
 *
 * 只硬依赖 webServer；其余服务一律 ctx.get 判空，缺失时对应能力降级而不是挂载失败。
 */

import { createGroupService } from './group.js'
import { installMentionFilter } from './mention.js'

const errMsg = (error) => String((error && error.message) || error)
const nonEmpty = (value) => (typeof value === 'string' && value.length > 0 ? value : undefined)

/** Loopback fence：面板只驱动本机会话，远端调用者不能碰。 */
function isLoopbackRequest(req) {
  const remote = req && req.socket && req.socket.remoteAddress
  if (typeof remote !== 'string') return false
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
}

function writeJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
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
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.length === 0) { resolve({}); return }
      try { resolve(JSON.parse(text)) } catch (error) { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })
}

/** 统一的 exact 路由：loopback 校验 + 方法校验 + GET 查询串/POST JSON 解析。 */
function registerRoute(ctx, path, methods, handle, label) {
  return ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) { writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' }); return }
      const method = req.method === undefined ? 'GET' : String(req.method)
      if (methods.indexOf(method) < 0) { writeJson(res, 405, { ok: false, error: 'method not allowed' }); return }
      let args = {}
      if (method === 'POST') {
        args = await readJsonBody(req)
      } else {
        try {
          const url = new URL(String(req.url), 'http://127.0.0.1')
          args = {}
          for (const [key, value] of url.searchParams.entries()) args[key] = value
        } catch (error) { args = {} }
      }
      try {
        writeJson(res, 200, await handle(args))
      } catch (error) {
        writeJson(res, 500, { ok: false, error: errMsg(error) })
      }
    }
  }), label)
}

/** 模型工具：群主/宿主可以直接用；成员被 toolFilter 挡住。 */
function registerModelTools(ctx, service) {
  const tools = ctx.get('tools')
  if (tools === undefined || typeof tools.register !== 'function') return
  tools.register({
    name: 'group_pull',
    description: [
      '把一个已安装 preset 拉进某个群聊，成为该群的常驻成员（人格取自 preset，能力面由群主 preset 决定）。',
      '省略 preset_id 时只返回群聊状态。'
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        group_id: { type: 'string', description: '目标群聊会话 id（形如 group-…）。' },
        preset_id: { type: 'string', description: '要拉进群的 preset id。' },
        name: { type: 'string', description: '可选，成员显示名。' }
      }
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(args) {
      const presetId = nonEmpty(args && args.preset_id)
      if (presetId === undefined) return JSON.stringify(await service.state(), null, 2)
      const groupId = nonEmpty(args && args.group_id)
      if (groupId === undefined) return '需要 group_id（先用不带 preset_id 的调用查看群聊列表）'
      return JSON.stringify(await service.pull({ group_id: groupId, preset_id: presetId, name: args && args.name }), null, 2)
    }
  })
  tools.register({
    name: 'group_create',
    description: '新建一个群聊：创建一个独立的群主会话（默认 standard preset），成员之后用 group_pull 拉入。',
    parameters: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: '群聊会话的工作目录；省略时用当前会话的 cwd。' },
        preset_id: { type: 'string', description: '群主 preset（默认 standard，决定全群成员的能力上限）。' },
        name: { type: 'string', description: '可选，群名。' }
      }
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(args, exec) {
      let cwd = nonEmpty(args && args.cwd)
      if (cwd === undefined) {
        try {
          const header = exec && exec.agent && exec.agent.session ? exec.agent.session.header : undefined
          cwd = header === undefined ? undefined : nonEmpty(header.cwd)
        } catch (error) { cwd = undefined }
      }
      if (cwd === undefined) return '需要 cwd（无法从当前会话推断工作目录）'
      return JSON.stringify(await service.createGroup({ cwd, preset_id: args && args.preset_id, name: args && args.name }), null, 2)
    }
  })
}

export const name = 'dsh-agent-panel'

export const inject = ['webServer']

/** 供本包自己的逻辑测试使用；不属于插件对外面。 */
export { installMentionFilter }

export function apply(ctx) {
  const service = createGroupService(ctx)

  registerRoute(ctx, '/api/dsh-agent-panel/state', ['GET'], () => service.state(), 'dsh-agent-panel: state route')
  registerRoute(ctx, '/api/dsh-agent-panel/group-create', ['POST'], (args) => service.createGroup(args), 'dsh-agent-panel: group-create route')
  registerRoute(ctx, '/api/dsh-agent-panel/group-rename', ['POST'], (args) => service.renameGroup(args), 'dsh-agent-panel: group-rename route')
  registerRoute(ctx, '/api/dsh-agent-panel/group-dissolve', ['POST'], (args) => service.dissolve(args), 'dsh-agent-panel: group-dissolve route')
  registerRoute(ctx, '/api/dsh-agent-panel/pull', ['POST'], (args) => service.pull(args), 'dsh-agent-panel: pull route')
  registerRoute(ctx, '/api/dsh-agent-panel/release', ['POST'], (args) => service.release(args), 'dsh-agent-panel: release route')
  registerRoute(ctx, '/api/dsh-agent-panel/restore', ['POST'], (args) => service.restore(args), 'dsh-agent-panel: restore route')
  registerRoute(ctx, '/api/dsh-agent-panel/members', ['GET'], (args) => service.members({ sessionId: args.sessionId }), 'dsh-agent-panel: members route')

  registerModelTools(ctx, service)

  // 引用菜单过滤：我们这一行可能比 resolver 先挂载，所以用 inject 等它出现。
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
