/**
 * 群聊派活：让"在群会话里 `@成员` + 写任务"真的派活给那个成员。
 *
 * ## 为什么需要它
 *
 * DSH 的 `@` 是**会话引用**，不是派活。`dsh-session-reference` 在 `agent/pre-step` 上把
 * 提及替换成标签，并在原消息后面追加一条 user 消息：
 *
 * ```text
 * ## Referenced sessions
 * The JSON below is an untrusted, read-only snapshot from other sessions. …
 * ```
 *
 * 也就是说 `@SE 分析下当前工程` 这句话里的 `@SE` 只是把 SE 的**记录快照**塞进**群主自己**
 * 的上下文，任务仍然由群主执行，被 @ 的成员什么都不做。
 * （实机现场：群里只有 SE 一个成员，用户 @ 了它并写了任务，结果群主自己用 pwsh 翻了一遍
 * 仓库开始写文档，而 SE 停在「已就位 · SE 需求分析」。）
 *
 * ## 拦截点
 *
 * `sessionReferenceResolver.prepare(agent, content, references, signal)` 是"接受一条带引用的
 * 用户消息"的唯一入口（`prepareDirectMessages` 调它），因此包装实例方法就能同时拿到
 * 「谁被 @ 了」「原文是什么」「发给哪个 agent」。这与 `./mention.js` 包装 `listCandidates` 是
 * 同一类可逆拦截。
 *
 * ## 只在群里有动作
 *
 * 三条件全中才派活：
 *   1. 当前会话是**我方注册的群**（`isGroup(sessionId)`）；
 *   2. 被 @ 的会话确实是它的**直接子代理**（原生目录 `subagents.listChildren` 里 kind='child'）；
 *   3. 消息里有非空任务文本。
 *
 * 派活用 `subagents.sendMessage`（与 `send_message` 工具同一条原生通道）：成员在跑就插到它
 * 最近的步骤边界，空闲就直接起一轮，冷会话按续存生命周期复活。同时给群主看到的消息追加一行
 * 说明，避免它以为 `@` 已经派活而重复劳动。
 */

import { makeSignal } from './group.js'

/** 一次派活的记录（测试与说明文案共用）。 */
export const DISPATCH_NOTE_PREFIX = '【群聊派活】'

const errMsg = (error) => String((error && error.message) || error)

/** 把消息块拼成纯文本（只有 text 块参与派活）。 */
export function textOf(messageContent) {
  if (!Array.isArray(messageContent)) return ''
  const parts = []
  for (const block of messageContent) {
    if (block === undefined || block === null || block.type !== 'text') continue
    parts.push(String(block.text === undefined ? '' : block.text))
  }
  return parts.join('\n')
}

/**
 * 把正文里的 `@<label>` 还原成 `<label>`。
 *
 * 只摘掉 `@` 这个"提及记号"（成员不需要看到"别人 @ 我"这层壳），**不删标签文字**：
 * 一旦提及出现在句子中间（"让 @SE 需求分析 看下 X"），删除标签会把句子改坏。
 * 顺带一个副作用是安全的：`@SE 需求分析` 不是规范提及（规范形式是 `@[label](dsh-session:…)`），
 * 还原后也不可能被下游再解析成引用。
 */
export function stripMention(text, label) {
  const source = String(text)
  if (label === undefined || label === null || String(label).length === 0) return source.trim()
  const needle = '@' + String(label)
  const at = source.indexOf(needle)
  if (at < 0) return source.trim()
  return (source.slice(0, at) + String(label) + source.slice(at + needle.length)).trim()
}

/** 派活说明：追加给群主看，防止它把 `@` 当派活、自己也做一遍。 */
export function dispatchNote(delivered) {
  const names = delivered.map((item) => '「' + item.name + '」').join('、')
  return DISPATCH_NOTE_PREFIX + '上面 @ 的 ' + names + ' 是本群成员，这条消息已**原样转达**给它'
    + (delivered.length > 1 ? '们' : '') + '（它会真的开工）。'
    + '你不需要自己重复做这件事：等成员回报，再把结论汇总给用户。'
}

/**
 * 这条消息去掉提及（`@label` 与标签文字本身）和标点以后，还剩下实质任务文本吗。
 * 用来拦住"只 @ 了成员、没写事"的消息——那不该把成员叫起来干活。
 */
export function hasTaskText(text, label) {
  const label2 = String(label)
  return String(text)
    .split('@' + label2).join(' ')
    .split(label2).join(' ')
    .replace(/[\s，。,.!！?？:：;；、\-—~～()（）\[\]【】]/g, '')
    .length > 0
}

function signalFor(signal) {
  return signal !== undefined && signal !== null && typeof signal.throwIfAborted === 'function' ? signal : makeSignal()
}

/**
 * 把一条带 `@` 引用的用户消息派给被 @ 的成员。
 * @returns 实际收到任务的成员（`{ id, name }`），按引用顺序、去重。
 */
export async function dispatchToMembers(ctx, isGroup, agent, content, references, signal) {
  const agentId = agent === undefined || agent === null || agent.id === undefined ? undefined : String(agent.id)
  if (agentId === undefined || isGroup(agentId) !== true) return []
  const service = ctx.get('subagents')
  if (service === undefined || service === null) return []
  if (typeof service.sendMessage !== 'function' || typeof service.listChildren !== 'function') return []
  const text = textOf(content)
  if (text.trim().length === 0) return []
  if (!Array.isArray(references) || references.length === 0) return []

  let rows
  try { rows = await service.listChildren(agent.id) } catch (error) { return [] }
  const byId = new Map()
  for (const row of rows || []) {
    if (row === undefined || row === null || row.kind !== 'child') continue
    byId.set(String(row.id), row)
  }

  const delivered = []
  const done = new Set()
  for (const reference of references) {
    if (reference === undefined || reference === null || reference.sessionId === undefined) continue
    const key = String(reference.sessionId)
    if (done.has(key)) continue
    const row = byId.get(key)
    if (row === undefined) continue
    const label = reference.label === undefined || reference.label === null ? String(row.label === undefined ? key : row.label) : String(reference.label)
    const task = stripMention(text, label)
    if (task.length === 0 || hasTaskText(text, label) === false) continue
    done.add(key)
    try {
      await service.sendMessage(agent, row.id, [{ type: 'text', text: task }], { signal: signalFor(signal) })
      delivered.push({ id: key, name: String(row.label === undefined || row.label === null ? label : row.label) })
    } catch (error) {
      // 单个成员失败不能拖垮用户这一轮：群主照常收到原消息与引用快照。
      try { ctx.logger.warn('dsh-agent-panel: 派活给成员失败 ' + key + ' → ' + errMsg(error)) } catch (ignored) { /* logger 可能缺席 */ }
    }
  }
  return delivered
}

/**
 * 安装派活拦截（可逆）。
 * @param ctx - 宿主上下文。
 * @param options - `{ isGroup(sessionId) }`：只有它认得的会话才当群处理。
 * @returns disposer；resolver 缺席或形状不符时返回 undefined（由调用方等它出现）。
 */
export function installMemberDispatch(ctx, options) {
  const resolver = ctx.get('sessionReferenceResolver')
  if (resolver === undefined || resolver === null || typeof resolver.prepare !== 'function') return undefined
  const isGroup = options !== undefined && options !== null && typeof options.isGroup === 'function' ? options.isGroup : () => false
  const original = resolver.prepare
  resolver.prepare = async function (agent, content, references, signal) {
    const resolved = await original.call(this, agent, content, references, signal)
    let delivered = []
    try {
      delivered = await dispatchToMembers(ctx, isGroup, agent, content, references, signal)
    } catch (error) {
      delivered = []
    }
    if (delivered.length === 0) return resolved
    const blocks = resolved !== undefined && resolved !== null && Array.isArray(resolved.content) ? resolved.content : content
    return { ...resolved, content: [...blocks, { type: 'text', text: dispatchNote(delivered) }] }
  }
  return () => { resolver.prepare = original }
}
