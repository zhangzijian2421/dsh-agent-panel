/**
 * 会话血缘一览：把 ~/.dsh/sessions 下每个会话存储的头信息读出来，列出所有
 * `origin=subagent` 的子代理会话（含 parent 与 preset）以及对应的父会话。
 *
 * 用途：排查"这个群拉过谁""删群之后哪些子会话还在磁盘上"——归档/删除是按
 * `parentSession` 整族级联的，且 live 的会话受保护，这条命令能把现状摊平。
 *
 * Usage: node tools/dump-lineage.mjs
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { decodeSessionLog } from './read-session.mjs'

const root = join(homedir(), '.dsh', 'sessions')
const rows = []
for (const bucket of readdirSync(root)) {
  const dir = join(root, bucket)
  if (!statSync(dir).isDirectory()) continue
  for (const id of readdirSync(dir)) {
    const store = join(dir, id)
    if (!statSync(store).isDirectory()) continue
    let header = {}
    try {
      for (const event of decodeSessionLog(store)) {
        if (event.type === 'session') { header = event.data ?? event; break }
      }
    } catch (error) { header = { error: String(error && error.message || error) } }
    let title
    try {
      for (const event of decodeSessionLog(store)) {
        if (event.type === 'session/title') title = event.data.title
      }
    } catch (error) { /* ignore */ }
    rows.push({
      id,
      parent: header.parentSession ?? '',
      origin: header.origin ?? '',
      preset: header.agentPreset ?? '',
      title: title ?? '',
      bucket: bucket.replace(/^--|--$/g, '').replace(/-dsh-agent-panel$/, '')
    })
  }
}
const children = rows.filter((row) => row.origin === 'subagent')
console.log('=== 子代理会话（origin=subagent）===')
for (const row of children) console.log(`${row.id}  parent=${row.parent}  preset=${row.preset}  title=${row.title}`)
console.log('')
console.log('=== 有子代理的父会话 ===')
const parents = new Set(children.map((row) => row.parent))
for (const parent of parents) {
  const known = rows.find((row) => row.id === parent)
  console.log(`${parent}  ${known === undefined ? '(会话已不存在于磁盘)' : 'title=' + known.title}`)
}
console.log('')
console.log('disk sessions: ' + rows.length + ' / subagent: ' + children.length)
