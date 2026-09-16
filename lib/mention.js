/**
 * `@` 引用菜单过滤（与群聊模型无关的独立增强）。
 *
 * 引用一个会话本身是功能（被选中会话的快照会注入 prompt），所以根会话必须保留在列表里。
 * 问题在于 shipped 的 resolver 会把"除自己以外的所有会话"都列出来，并不区分父子：
 * 子代理会话继承父会话的 cwd，于是 cwd 亲和度排序会把**别的会话的子代理**顶到最前面。
 *
 * 远端面调用的是 `this.listCandidates(...)`，因此替换实例方法是可逆的在线拦截点。
 * 保留：根会话 + 当前会话自己的子代理树（任意深度）。丢弃：血缘上永远到不了调用者的子代理。
 * 无法分类的候选（冷记录不在列表里）一律保留——这里降级成 shipped 行为，而不是把真会话藏起来。
 */

export function installMentionFilter(ctx) {
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
        parent: header.parentSession === undefined ? undefined : String(header.parentSession)
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
