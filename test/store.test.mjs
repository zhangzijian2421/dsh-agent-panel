/**
 * 群聊注册表单测：纯函数 + 文件读写往返。
 *
 * 方案 A 把群状态压缩成这一个文件，因此它必须**永不因损坏而抛**（面板要能降级运行），
 * 并且成员增删的语义必须明确：软删除保留历史、重名检测包含已移除的成员。
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import {
  DEFAULT_GROUP_PRESET,
  GROUP_ID_PREFIX,
  activeMembers,
  dedupeName,
  emptyRegistry,
  isGroupId,
  markMemberRemoved,
  markMemberRestored,
  nextGroupName,
  parseRegistry,
  putGroup,
  putMember,
  readRegistryFile,
  registryPath,
  removedMembers,
  removeGroup,
  serializeRegistry,
  takenMemberNames,
  updateGroup,
  writeRegistryFile
} from '../lib/store.js'

const results = []
function check(name, fn) {
  try {
    fn()
    results.push({ name, ok: true })
    console.log('  ok   ' + name)
  } catch (error) {
    results.push({ name, ok: false })
    console.log('  FAIL ' + name + ' → ' + String((error && error.message) || error))
  }
}

function group(id, overrides) {
  return {
    id,
    name: '群聊 · 1',
    cwd: 'D:\\work',
    presetId: DEFAULT_GROUP_PRESET,
    createdAt: 1000,
    members: [],
    ...(overrides || {})
  }
}

console.log('store: identity')
check('群 id 前缀', () => {
  assert.equal(isGroupId(GROUP_ID_PREFIX + 'abc'), true)
  assert.equal(isGroupId('session-abc'), false)
  assert.equal(isGroupId(undefined), false)
})
check('注册表路径落在 ~/.dsh/dsh-agent-panel/ 下', () => {
  assert.equal(registryPath('C:\\home'), join('C:\\home', '.dsh', 'dsh-agent-panel', 'groups.json'))
})

console.log('store: parse / serialize')
check('空文本 → 空注册表', () => {
  assert.deepEqual(parseRegistry(''), emptyRegistry())
  assert.deepEqual(parseRegistry('   '), emptyRegistry())
})
check('坏 JSON / 错形状 → 空注册表而不是抛错', () => {
  assert.deepEqual(parseRegistry('{ not json'), emptyRegistry())
  assert.deepEqual(parseRegistry('null'), emptyRegistry())
  assert.deepEqual(parseRegistry('[1,2,3]'), emptyRegistry())
  assert.deepEqual(parseRegistry('{"groups": 42}'), emptyRegistry())
})
check('缺字段被归一化（有默认值，不崩）', () => {
  const data = parseRegistry(JSON.stringify({ version: 1, groups: { 'group-1': { members: [{ childId: 'c1' }, { name: '无名' }, null] } } }))
  const parsed = data.groups['group-1']
  assert.equal(parsed.name, 'group-1')
  assert.equal(parsed.presetId, DEFAULT_GROUP_PRESET)
  assert.equal(parsed.cwd, '')
  assert.equal(parsed.members.length, 1, '只有带 childId 的成员被保留')
  assert.equal(parsed.members[0].name, 'c1', '成员名缺失时退回 childId')
})
check('往返无损（含 removedAt 与中文）', () => {
  let data = emptyRegistry()
  data = putGroup(data, group('group-1', { name: '群聊 · 前端', members: [{ childId: 'c1', name: 'SE 需求分析', presetId: 'se', addedAt: 5, removedAt: 9 }] }))
  const again = parseRegistry(serializeRegistry(data))
  assert.deepEqual(again, data)
})

console.log('store: group operations')
check('putGroup / updateGroup / removeGroup', () => {
  let data = putGroup(emptyRegistry(), group('group-1'))
  data = putGroup(data, group('group-2', { name: '群聊 · 2' }))
  assert.equal(Object.keys(data.groups).length, 2)
  data = updateGroup(data, 'group-1', (current) => ({ ...current, name: '改个名' }))
  assert.equal(data.groups['group-1'].name, '改个名')
  assert.equal(updateGroup(data, 'missing', (current) => current), data, '改不存在的群是 no-op')
  data = removeGroup(data, 'group-1')
  assert.deepEqual(Object.keys(data.groups), ['group-2'])
})
check('nextGroupName 跳过已占用的名字', () => {
  assert.equal(nextGroupName({}), '群聊 · 1')
  assert.equal(nextGroupName({ a: { name: '群聊 · 1' }, b: { name: '群聊 · 2' } }), '群聊 · 3')
  assert.equal(nextGroupName({ a: { name: '群聊 · 2' } }), '群聊 · 1')
})

console.log('store: member operations')
check('putMember 覆盖同一 childId、保留其他成员', () => {
  let data = putGroup(emptyRegistry(), group('group-1'))
  data = putMember(data, 'group-1', { childId: 'c1', name: 'SE', presetId: 'se', addedAt: 1 })
  data = putMember(data, 'group-1', { childId: 'c2', name: '开发', presetId: 'devdept', addedAt: 2 })
  data = putMember(data, 'group-1', { childId: 'c1', name: 'SE', presetId: 'se', addedAt: 1 })
  assert.equal(data.groups['group-1'].members.length, 2)
})
check('软删除 / 恢复：历史保留，active 与 removed 分区正确', () => {
  let data = putGroup(emptyRegistry(), group('group-1'))
  data = putMember(data, 'group-1', { childId: 'c1', name: 'SE', presetId: 'se', addedAt: 1 })
  data = putMember(data, 'group-1', { childId: 'c2', name: '开发', presetId: 'devdept', addedAt: 2 })
  data = markMemberRemoved(data, 'group-1', 'c1', 12345)
  const parsed = data.groups['group-1']
  assert.deepEqual(activeMembers(parsed).map((row) => row.childId), ['c2'])
  assert.deepEqual(removedMembers(parsed).map((row) => row.childId), ['c1'])
  assert.equal(parsed.members.length, 2, '记录不删，只打标记')
  assert.deepEqual(takenMemberNames(parsed), ['SE', '开发'], '名字占用包含已移除成员')
  data = markMemberRestored(data, 'group-1', 'c1')
  assert.deepEqual(activeMembers(data.groups['group-1']).map((row) => row.childId), ['c1', 'c2'])
  assert.equal('removedAt' in data.groups['group-1'].members[0], false)
})
check('markMemberRemoved 对不存在的成员是 no-op', () => {
  const data = putGroup(emptyRegistry(), group('group-1'))
  assert.deepEqual(markMemberRemoved(data, 'group-1', 'nope', 1), data)
})
check('dedupeName 依次退避 -2 / -3', () => {
  assert.equal(dedupeName('SE', []), 'SE')
  assert.equal(dedupeName('SE', ['SE']), 'SE-2')
  assert.equal(dedupeName('SE', ['SE', 'SE-2']), 'SE-3')
  assert.equal(dedupeName('', []), '成员')
})

console.log('store: file layer')
check('写→读往返，并自动建目录、原子替换', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agrp-store-'))
  try {
    const path = join(dir, 'nested', 'deeper', 'groups.json')
    let data = putGroup(emptyRegistry(), group('group-1'))
    data = putMember(data, 'group-1', { childId: 'c1', name: 'SE', presetId: 'se', addedAt: 1 })
    writeRegistryFile(path, data)
    assert.deepEqual(readRegistryFile(path), data)
    assert.equal(existsSync(path + '.tmp'), false, '临时文件已被 rename 消费掉')
    assert.doesNotThrow(() => JSON.parse(readFileSync(path, 'utf8')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
check('读不存在的文件 / 损坏文件都不抛', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agrp-store-'))
  try {
    const missing = join(dir, 'nope.json')
    assert.deepEqual(readRegistryFile(missing), emptyRegistry())
    const broken = join(dir, 'broken.json')
    writeFileSync(broken, '{ "groups": ', 'utf8')
    assert.deepEqual(readRegistryFile(broken), emptyRegistry())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const failed = results.filter((row) => !row.ok)
console.log('')
console.log(failed.length === 0 ? 'ALL PASS (' + results.length + ')' : failed.length + ' FAILED of ' + results.length)
process.exit(failed.length === 0 ? 0 : 1)
