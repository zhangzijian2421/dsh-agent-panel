/**
 * 群聊注册表 —— v2 架构里**唯一**自建的状态。
 *
 * 方案 A：群聊 = 一个由插件创建的**独立群主会话**（root 会话），成员 = 它的具名常驻子代理，
 * 频道 = 该会话自己的记录，名册与状态由原生子代理原语提供。于是本插件只剩一件事需要自己记：
 * 「哪些会话是群、群叫什么、群主 preset 是什么、某个成员当初是用哪个 preset 拉进来的」。
 *
 * 这一点状态存成一个 JSON 文件即可，**不再往用户工作区里撒 `.agent-group/` 目录**，
 * 也不再需要 roster.json / chat.log / 墓碑文件三套各带生命周期的存储。
 *
 * 本模块刻意分成两层：纯函数（不碰 Cordis、不碰 fs，可直接单测）+ 一个薄文件读写层。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** 注册表格式版本；读到别的版本会被归一化成当前形状，而不是崩掉。 */
export const REGISTRY_VERSION = 2

/**
 * 群主 preset —— **固定值，不可选**。
 *
 * 群聊的模型就是「群聊 Agent」：盘点成员能力边界 → 派活 → 汇总。它同时决定整群成员的
 * 能力上限（成员工具面 = 群主 preset 的工具面 ∩ 成员黑名单），所以它必须是一个工作面完整的
 * preset，而不是 `minimal` 那种只有 shell 的。建群时调用方传进来的 preset 一律被忽略。
 *
 * 它由本仓库外的 preset 目录提供：`${DSH_HOME:-~/.dsh}/.agent-presets/group-host/`。
 */
export const DEFAULT_GROUP_PRESET = 'group-host'

/** 注册表落盘位置。 */
export function registryPath(home) {
  const base = typeof home === 'string' && home.length > 0 ? home : homedir()
  return join(base, '.dsh', 'dsh-agent-panel', 'groups.json')
}

/** 空注册表。 */
export function emptyRegistry() {
  return { version: REGISTRY_VERSION, groups: {} }
}

function text(value, fallback) {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function stamp(value) {
  return Number.isFinite(value) ? Number(value) : 0
}

function parseMember(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  if (typeof raw.childId !== 'string' || raw.childId.length === 0) return undefined
  const member = {
    childId: raw.childId,
    name: text(raw.name, raw.childId),
    presetId: typeof raw.presetId === 'string' ? raw.presetId : '',
    addedAt: stamp(raw.addedAt)
  }
  if (Number.isFinite(raw.removedAt)) member.removedAt = Number(raw.removedAt)
  return member
}

/**
 * 解析注册表文本。任何损坏（空、非 JSON、形状不对）都降级成空注册表并返回，
 * 因为"读不出来"绝不能让面板整个挂掉。
 */
export function parseRegistry(sourceText) {
  if (typeof sourceText !== 'string' || sourceText.trim().length === 0) return emptyRegistry()
  let raw
  try {
    raw = JSON.parse(sourceText)
  } catch (error) {
    return emptyRegistry()
  }
  if (raw === null || typeof raw !== 'object') return emptyRegistry()
  const source = raw.groups !== null && typeof raw.groups === 'object' && !Array.isArray(raw.groups) ? raw.groups : {}
  const groups = {}
  for (const id of Object.keys(source)) {
    const value = source[id]
    if (value === null || typeof value !== 'object') continue
    groups[id] = {
      id,
      name: text(value.name, id),
      cwd: typeof value.cwd === 'string' ? value.cwd : '',
      presetId: text(value.presetId, DEFAULT_GROUP_PRESET),
      createdAt: stamp(value.createdAt),
      members: Array.isArray(value.members) ? value.members.map(parseMember).filter(Boolean) : []
    }
  }
  return { version: REGISTRY_VERSION, groups }
}

/** 序列化：字段顺序稳定，便于 diff 与手改。 */
export function serializeRegistry(data) {
  const source = data !== null && typeof data === 'object' && data.groups !== null && typeof data.groups === 'object' ? data.groups : {}
  const groups = {}
  for (const id of Object.keys(source)) {
    const group = source[id]
    if (group === null || typeof group !== 'object') continue
    groups[id] = {
      id: text(group.id, id),
      name: text(group.name, id),
      cwd: typeof group.cwd === 'string' ? group.cwd : '',
      presetId: text(group.presetId, DEFAULT_GROUP_PRESET),
      createdAt: stamp(group.createdAt),
      members: (Array.isArray(group.members) ? group.members : []).map((member) => {
        const row = {
          childId: String(member.childId),
          name: text(member.name, String(member.childId)),
          presetId: typeof member.presetId === 'string' ? member.presetId : '',
          addedAt: stamp(member.addedAt)
        }
        if (Number.isFinite(member.removedAt)) row.removedAt = Number(member.removedAt)
        return row
      })
    }
  }
  return JSON.stringify({ version: REGISTRY_VERSION, groups }, null, 2) + '\n'
}

/** 新增/覆盖一个群。 */
export function putGroup(data, group) {
  return { version: REGISTRY_VERSION, groups: { ...data.groups, [group.id]: group } }
}

/** 就地改一个群；群不存在时原样返回。 */
export function updateGroup(data, id, mutate) {
  const current = data.groups[id]
  if (current === undefined) return data
  return putGroup(data, mutate(current))
}

/** 删掉一个群（解散）。 */
export function removeGroup(data, id) {
  const groups = { ...data.groups }
  delete groups[id]
  return { version: REGISTRY_VERSION, groups }
}

/** 记录一名成员；同一 childId 只保留一条（重拉同一个子代理时覆盖）。 */
export function putMember(data, groupId, member) {
  return updateGroup(data, groupId, (group) => ({
    ...group,
    members: group.members.filter((row) => row.childId !== member.childId).concat([member])
  }))
}

/** 软删除：保留记录以便面板区分"曾经拉过""，而不是删掉历史。 */
export function markMemberRemoved(data, groupId, childId, at) {
  return updateGroup(data, groupId, (group) => ({
    ...group,
    members: group.members.map((row) => (row.childId === childId ? { ...row, removedAt: Number.isFinite(at) ? at : Date.now() } : row))
  }))
}

/** 撤销软删除（恢复显示）。 */
export function markMemberRestored(data, groupId, childId) {
  return updateGroup(data, groupId, (group) => ({
    ...group,
    members: group.members.map((row) => {
      if (row.childId !== childId) return row
      const next = { ...row }
      delete next.removedAt
      return next
    })
  }))
}

export function activeMembers(group) {
  return (group.members || []).filter((row) => row.removedAt === undefined)
}

export function removedMembers(group) {
  return (group.members || []).filter((row) => row.removedAt !== undefined)
}

/** 已被占用的成员名（含曾经拉过、现已移除的，避免重名带来的歧义）。 */
export function takenMemberNames(group) {
  return (group.members || []).map((row) => String(row.name))
}

/** 下一组"群聊 · N"名字。 */
export function nextGroupName(groups) {
  const taken = new Set(Object.values(groups || {}).map((group) => String(group.name)))
  let index = 1
  while (taken.has('群聊 · ' + index)) index += 1
  return '群聊 · ' + index
}

/** 重名去重：`名字` / `名字-2` / `名字-3` … */
export function dedupeName(base, taken) {
  const wanted = String(base === undefined || base === null || String(base).length === 0 ? '成员' : base)
  const used = new Set((taken || []).map((value) => String(value)))
  if (!used.has(wanted)) return wanted
  let index = 2
  while (used.has(wanted + '-' + index)) index += 1
  return wanted + '-' + index
}

/** 读注册表文件；文件不存在或损坏都当空注册表（不抛）。 */
export function readRegistryFile(path) {
  if (typeof path !== 'string' || path.length === 0) return emptyRegistry()
  try {
    return parseRegistry(readFileSync(path, 'utf8'))
  } catch (error) {
    return emptyRegistry()
  }
}

/** 原子写注册表文件（临时文件 + rename），并自动创建父目录。 */
export function writeRegistryFile(path, data) {
  if (typeof path !== 'string' || path.length === 0) throw new Error('registry path is required')
  mkdirSync(dirname(path), { recursive: true })
  const payload = serializeRegistry(data)
  const temporary = path + '.tmp'
  writeFileSync(temporary, payload, 'utf8')
  renameSync(temporary, path)
  return payload
}
