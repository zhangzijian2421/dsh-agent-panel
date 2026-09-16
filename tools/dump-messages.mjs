/**
 * 会话消息速览：只打印"模型真正看到/产出的对话内容"（user / system / assistant 文本与工具调用），
 * 用来看清一轮里到底发生了什么。
 *
 * 用途示例：群里 @ 了成员却没见成员干活时，用它看群主那一轮的消息——
 * `@SE 需求分析 …` 会被 `dsh-session-reference` 展开成一条
 * 「## Referenced sessions … untrusted, read-only snapshot」消息，任务由此落回群主自己身上。
 *
 * Usage: node tools/dump-messages.mjs <会话存储目录或 .zstd 文件> [打印条数=12]
 */
import { decodeSessionLog } from './read-session.mjs'

const target = process.argv[2]
const limit = Number(process.argv[3] ?? 12)
const events = decodeSessionLog(target)
const out = []
for (const event of events) {
  const data = event.data === undefined ? event : event.data
  const type = event.type
  if (type === 'user/message' || type === 'system/message') {
    const role = data.role ?? (type === 'system/message' ? 'system' : 'user')
    const parts = []
    for (const block of data.content ?? []) {
      if (block.type === 'text') parts.push(block.text)
      else parts.push('<' + String(block.type) + '>')
    }
    out.push({ type, role, text: parts.join('\n') })
  }
  if (type === 'assistant/message') {
    const parts = []
    for (const block of data.message?.content ?? []) {
      if (block.type === 'text') parts.push(block.text)
      else if (block.type === 'tool-call') parts.push('<tool:' + block.name + ' ' + String(block.arguments).slice(0, 200) + '>')
    }
    out.push({ type, role: 'assistant', text: parts.join('\n') })
  }
  if (type === 'session/title') out.push({ type, role: 'title', text: String(data.title) })
}
for (const row of out.slice(-limit)) {
  const text = row.text.length > 1200 ? row.text.slice(0, 1200) + ' …(+' + (row.text.length - 1200) + ')' : row.text
  console.log('\n=== [' + row.role + '] ' + text)
}
console.log('\n(events: ' + events.length + ', printed last ' + Math.min(limit, out.length) + ' of ' + out.length + ')')
