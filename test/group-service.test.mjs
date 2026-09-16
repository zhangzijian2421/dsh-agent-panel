/**
 * 群聊服务单测：用桩 ctx 驱动一整套 建群 / 拉人 / 状态 / 移除 / 恢复 / 解散 流程。
 *
 * 重点是钉住 v2 的语义（这些正是旧实现里最容易回归的地方）：
 *   - 群 = 一个 root 群主会话（id 带 `group-` 前缀），preset 建群时确定
 *   - 成员 = 具名常驻子代理：label 去重、persona 来自被拉 preset、黑名单来自 MEMBER_TOOL_DENY、maxDepth=1
 *   - 名册 = 原生子代理目录（含"不是本面板拉的"成员，也要看得见）
 *   - 移除 = 原生 release + 注册表软删除；恢复 = 撤销软删除
 *   - 能力面 = 群主 preset；minimal 群主必须给出显式告警
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import {
  FALLBACK_DENY,
  MEMBER_TOOL_DENY,
  capabilityWarning,
  createGroupService,
  extractPersona,
  knownToolNamesFrom,
  makeSignal,
  mapChildRows,
  memberNotice,
  parsePersonaPrefix
} from '../lib/group.js'
import { readRegistryFile } from '../lib/store.js'

const results = []
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { results.push({ name, ok: true }); console.log('  ok   ' + name) })
    .catch((error) => { results.push({ name, ok: false }); console.log('  FAIL ' + name + ' → ' + String((error && error.message) || error)) })
}

const PRESETS = [
  { id: 'standard', name: '标准模式', description: '完整编码 agent', trust: 'system' },
  { id: 'minimal', name: '极简模式', description: '只有 shell', trust: 'system' },
  { id: 'se', name: 'SE 需求分析', description: '需求分析', trust: 'user' }
]
const DOCS = {
  se: [
    '- id: persona',
    '  prefix: |',
    '    你是 SE，只做需求分析与方案设计。',
    '    绝对不要写实现代码。',
    '',
    '- id: tools',
    '  mode: standard'
  ].join('\n')
}

/** 搭一个只实现本服务真正用到的那几个方法的假宿主。 */
function makeHost(options) {
  const state = {
    agents: new Map(),
    children: new Map(),
    sessions: new Map(),
    titles: new Map(),
    archived: [],
    specs: [],
    ensureCalls: [],
    creates: [],
    resumes: [],
    mounts: [],
    drained: [],
    startFails: (options && options.startFails) || null
  }
  let started = 0
  const ctx = {
    get(name) {
      if (name === 'agents') {
        return {
          get: (id) => state.agents.get(id),
          async create(options) {
            state.creates.push({ sessionId: options.sessionId, cwd: options.meta.cwd, preset: options.meta.agentPreset })
            if (typeof options.setup === 'function') await options.setup({ label: 'agentCtx' })
            const agent = { id: options.sessionId, cwd: options.meta.cwd, preset: options.meta.agentPreset }
            state.agents.set(agent.id, agent)
            state.sessions.set(agent.id, { id: agent.id })
            return { agent }
          },
          async resume(options) {
            state.resumes.push(options.resumeSessionId)
            if (typeof options.setup === 'function') await options.setup({ label: 'agentCtx' })
            const agent = { id: options.resumeSessionId, cwd: state.resumeCwd || 'D:\\work', preset: state.resumePreset || 'standard' }
            state.agents.set(agent.id, agent)
            state.sessions.set(agent.id, { id: agent.id })
            return { agent }
          }
        }
      }
      if (name === 'subagents') {
        return {
          async listChildren(id) { return state.children.get(id) || [] },
          async startContinuable(spec) {
            if (state.startFails !== null) {
              const failure = state.startFails
              state.startFails = null
              throw new Error(failure)
            }
            state.specs.push(spec)
            started += 1
            const childId = 'child-' + started
            return { childId, messageId: 'msg-' + started }
          },
          async drainContinuableChildren(parent, ids) { state.drained.push({ parent: parent.id, ids: [...ids] }) }
        }
      }
      if (name === 'agentPresets') {
        return {
          async list() { return PRESETS },
          async read(id) { return DOCS[id] || '' },
          async mount(agentCtx, id) { state.mounts.push(id); return { id } }
        }
      }
      if (name === 'sessions') {
        return { get: (id) => state.sessions.get(id) }
      }
      if (name === 'sessionController' && !(options && options.noController)) {
        return {
          async ensureSession(id, cwd, check, preset) {
            state.ensureCalls.push({ id, cwd, check, preset })
            const agent = { id, cwd, preset }
            state.agents.set(id, agent)
            state.sessions.set(id, { id })
            return agent
          }
        }
      }
      if (name === 'sessionTitle') {
        return { rename: (session, title) => { state.titles.set(session.id, title) } }
      }
      if (name === 'workspaceRegistry') {
        return { async archiveSession(id) { state.archived.push(id) } }
      }
      return undefined
    }
  }
  return { ctx, state }
}

console.log('group: pure helpers')
await check('mapChildRows 只保留 child，边角字段有兜底', () => {
  const rows = mapChildRows([
    { kind: 'child', id: 'c1', label: 'SE', activity: 'running', mode: 'continuable' },
    { kind: 'child', id: 'c2', activity: 'inactive', mode: 'one-shot' },
    { kind: 'parent', id: 'p1' },
    null
  ])
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0], { id: 'c1', name: 'SE', status: 'running', mode: 'continuable' })
  assert.deepEqual(rows[1], { id: 'c2', name: 'c2', status: 'idle', mode: 'one-shot' })
})
await check('memberNotice 交代群名、群主 id 与汇报方式', () => {
  const text = memberNotice({ groupName: '群聊 · 1', memberName: 'SE', groupId: 'group-abc' })
  assert.match(text, /群聊 · 1/)
  assert.match(text, /SE/)
  assert.match(text, /send_message\(agent_id="group-abc"\)/)
  assert.match(text, /兄弟会话/)
})
await check('capabilityWarning 只对 minimal 群主报警', () => {
  assert.equal(capabilityWarning('standard'), undefined)
  assert.equal(capabilityWarning('cordis'), undefined)
  assert.match(capabilityWarning('minimal'), /read\/write\/edit/)
})
await check('knownToolNamesFrom 从 restrict 报错里解析工具域', () => {
  const names = knownToolNamesFrom('tools.restrict() names unknown global tools: read, write, list_agents')
  assert.deepEqual([...names].sort(), ['list_agents', 'read', 'write'])
  assert.equal(knownToolNamesFrom('完全不相干的报错'), undefined)
})
await check('parsePersonaPrefix 支持 | 与 > 块标量，并按下一个顶层条目收尾', () => {
  assert.equal(parsePersonaPrefix(DOCS.se), '你是 SE，只做需求分析与方案设计。\n绝对不要写实现代码。')
  const folded = ['- id: persona', '  prefix: >-', '    第一行', '    第二行', '- id: tools'].join('\n')
  assert.equal(parsePersonaPrefix(folded), '第一行 第二行')
  assert.equal(parsePersonaPrefix('- id: tools\n  mode: standard'), null)
})
await check('extractPersona：有 persona 用 persona，读不到就退化成元数据身份', async () => {
  const source = { read: async (id) => DOCS[id] || '', list: async () => PRESETS }
  assert.match(await extractPersona(source, 'se'), /只做需求分析/)
  const fallback = await extractPersona({ read: async () => { throw new Error('nope') }, list: async () => PRESETS }, 'se')
  assert.match(fallback, /SE 需求分析/)
  assert.match(fallback, /preset "se"/)
})
await check('makeSignal 满足 startContinuable 的鸭子类型要求', () => {
  const signal = makeSignal()
  assert.equal(signal.aborted, false)
  assert.doesNotThrow(() => signal.throwIfAborted())
  let fired = 0
  const listener = () => { fired += 1 }
  signal.addEventListener('abort', listener)
  signal.removeEventListener('abort', listener)
  assert.equal(fired, 0)
})

console.log('group: createGroup')
await check('建群：root 会话 + 指定 preset + 标题 + 注册表', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agrp-group-'))
  try {
    const file = join(dir, 'groups.json')
    const host = makeHost()
    const service = createGroupService(host.ctx, { registryFile: file })
    const created = await service.createGroup({ cwd: 'D:\\work', preset_id: 'standard' })
    assert.equal(created.ok, true)
    assert.match(created.id, /^group-/)
    assert.equal(created.name, '群聊 · 1')
    assert.equal(host.state.ensureCalls.length, 1)
    assert.deepEqual(host.state.ensureCalls[0], { id: created.id, cwd: 'D:\\work', check: true, preset: 'standard' })
    assert.equal(host.state.titles.get(created.id), '群聊 · 1')
    const registry = readRegistryFile(file)
    assert.equal(registry.groups[created.id].presetId, 'standard')
    const second = await service.createGroup({ cwd: 'D:\\work' })
    assert.equal(second.name, '群聊 · 2', '第二个群自动换名')
    assert.equal(second.preset_id, 'standard', '默认群主 preset')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
await check('建群失败路径：缺 cwd / preset 不存在', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agrp-group-'))
  try {
    const host = makeHost()
    const service = createGroupService(host.ctx, { registryFile: join(dir, 'groups.json') })
    assert.equal((await service.createGroup({})).ok, false)
    const bad = await service.createGroup({ cwd: 'D:\\work', preset_id: 'nope' })
    assert.equal(bad.ok, false)
    assert.match(bad.error, /preset 不存在/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

console.log('group: pull')
await check('拉人：label/persona/黑名单/maxDepth 与注册表都正确', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agrp-group-'))
  try {
    const file = join(dir, 'groups.json')
    const host = makeHost()
    const service = createGroupService(host.ctx, { registryFile: file })
    const group = await service.createGroup({ cwd: 'D:\\work', preset_id: 'standard' })
    const pulled = await service.pull({ group_id: group.id, preset_id: 'se' })
    assert.equal(pulled.ok, true)
    assert.equal(pulled.member_id, 'child-1')
    assert.equal(host.state.specs.length, 1)
    const spec = host.state.specs[0]
    assert.equal(spec.provider, 'spawn')
    assert.equal(spec.label, 'SE 需求分析')
    assert.equal(spec.request.maxDepth, 1)
    assert.equal(spec.request.parent.id, group.id, '成员挂在群主会话下')
    assert.deepEqual(spec.request.toolFilter.deny, MEMBER_TOOL_DENY)
    assert.match(spec.request.persona, /只做需求分析/, 'persona 来自被拉 preset')
    assert.ok(spec.request.persona.includes('send_message(agent_id="' + group.id + '")'), 'persona 附带群规')
    assert.match(spec.request.prompt[0].text, /欢迎「SE 需求分析」/)
    assert.ok(spec.signal && typeof spec.signal.throwIfAborted === 'function')
    const registry = readRegistryFile(file)
    assert.equal(registry.groups[group.id].members[0].presetId, 'se')
    assert.match(pulled.capability, /群主 preset（standard）/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
await check('同名成员自动退避 -2；显式重名直接拒绝', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agrp-group-'))
  try {
    const host = makeHost()
    const service = createGroupService(host.ctx, { registryFile: join(dir, 'groups.json') })
    const group = await service.createGroup({ cwd: 'D:\\work', preset_id: 'standard' })
    const first = await service.pull({ group_id: group.id, preset_id: 'se' })
    const second = await service.pull({ group_id: group.id, preset_id: 'se' })
    assert.equal(first.name, 'SE 需求分析')
    assert.equal(second.name, 'SE 需求分析-2')
    const clash = await service.pull({ group_id: group.id, preset_id: 'se', name: 'SE 需求分析' })
    assert.equal(clash.ok, false)
    assert.match(clash.error, /已被占用/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
await check('降级：工具域不认全部黑名单时按解析结果裁剪并出告警', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agrp-group-'))
  try {
    const host = makeHost({ startFails: 'tools.restrict() names unknown global tools: pwsh, list_agents, interrupt_agent, ask_user_question' })
    const service = createGroupService(host.ctx, { registryFile: join(dir, 'groups.json') })
    const group = await service.createGroup({ cwd: 'D:\\work', preset_id: 'standard' })
    const pulled = await service.pull({ group_id: group.id, preset_id: 'se' })
    assert.equal(pulled.ok, true)
    assert.deepEqual(host.state.specs[0].request.toolFilter.deny, ['list_agents', 'interrupt_agent', 'ask_user_question'])
    assert.match(pulled.warning, /黑名单已裁剪/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
await check('拉人失败路径：群不存在 / preset 不存在 / 群主起不来', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agrp-group-'))
  try {
    const host = makeHost()
    const service = createGroupService(host.ctx, { registryFile: join(dir, 'groups.json') })
    assert.equal((await service.pull({ group_id: 'group-nope', preset_id: 'se' })).ok, false)
    const group = await service.createGroup({ cwd: 'D:\\work', preset_id: 'standard' })
    assert.equal((await service.pull({ group_id: group.id, preset_id: 'ghost' })).ok, false)
    // 群主冷掉且 controller 不可用
    host.state.agents.clear()
    const noController = { get: (name) => (name === 'agents' ? { get: () => undefined } : host.ctx.get(name)) }
    const offline = createGroupService(noController, { registryFile: join(dir, 'groups.json') })
    const failed = await offline.pull({ group_id: group.id, preset_id: 'se' })
    assert.equal(failed.ok, false)
    assert.match(failed.error, /无法启动/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

console.log('group: state')
await check('状态：注册成员 + 原生外来成员 + minimal 告警', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agrp-group-'))
  try {
    const host = makeHost()
    const service = createGroupService(host.ctx, { registryFile: join(dir, 'groups.json') })
    const group = await service.createGroup({ cwd: 'D:\\work', preset_id: 'standard' })
    await service.pull({ group_id: group.id, preset_id: 'se' })
    // 群主自己用 subagent 工具拉的人：不在注册表里，但面板必须看得见
    host.state.children.set(group.id, [
      { kind: 'child', id: 'child-1', label: 'SE 需求分析', activity: 'running', mode: 'continuable' },
      { kind: 'child', id: 'child-9', label: '野生成员', activity: 'inactive', mode: 'continuable' }
    ])
    const snapshot = await service.state()
    assert.equal(snapshot.default_group_preset, 'standard')
    assert.equal(snapshot.presets.length, 3)
    const row = snapshot.groups.find((item) => item.id === group.id)
    assert.equal(row.owner_live, true)
    assert.deepEqual(row.members.map((member) => member.id), ['child-1', 'child-9'])
    assert.equal(row.members[0].status, 'running')
    assert.equal(row.members[0].registered, true)
    assert.equal(row.members[1].registered, false)
    assert.equal(row.capability_warning, undefined)
    const weak = await service.createGroup({ cwd: 'D:\\work', preset_id: 'minimal' })
    const weakRow = (await service.state()).groups.find((item) => item.id === weak.id)
    assert.match(weakRow.capability_warning, /minimal/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

console.log('group: fallback（sessionController 缺席时只靠 catalog 内原语）')
await check('建群兜底：agents.create({meta:{cwd,agentPreset}}) + presets.mount', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agrp-group-'))
  try {
    const host = makeHost({ noController: true })
    const service = createGroupService(host.ctx, { registryFile: join(dir, 'groups.json') })
    const created = await service.createGroup({ cwd: 'D:\\work', preset_id: 'standard' })
    assert.equal(created.ok, true, created.error)
    assert.equal(host.state.ensureCalls.length, 0, '没有走 sessionController')
    assert.deepEqual(host.state.creates, [{ sessionId: created.id, cwd: 'D:\\work', preset: 'standard' }])
    assert.deepEqual(host.state.mounts, ['standard'], '必须把 preset 真的 mount 上')
    assert.equal((await service.state()).groups[0].owner_live, true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
await check('拉人兜底：群主冷掉时用 agents.resume + presets.mount 唤醒', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agrp-group-'))
  try {
    const host = makeHost({ noController: true })
    const service = createGroupService(host.ctx, { registryFile: join(dir, 'groups.json') })
    const group = await service.createGroup({ cwd: 'D:\\work', preset_id: 'standard' })
    host.state.agents.clear()
    host.state.resumePreset = 'standard'
    const pulled = await service.pull({ group_id: group.id, preset_id: 'se' })
    assert.equal(pulled.ok, true, pulled.error)
    assert.deepEqual(host.state.resumes, [group.id])
    assert.deepEqual(host.state.mounts, ['standard', 'standard'], 'create 与 resume 各 mount 一次')
    assert.equal((await service.state()).groups[0].owner_live, true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

console.log('group: release / restore / dissolve')
await check('移除：释放子代理 + 软删除；恢复：撤销软删除', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agrp-group-'))
  try {
    const host = makeHost()
    const service = createGroupService(host.ctx, { registryFile: join(dir, 'groups.json') })
    const group = await service.createGroup({ cwd: 'D:\\work', preset_id: 'standard' })
    const pulled = await service.pull({ group_id: group.id, preset_id: 'se' })
    const released = await service.release({ group_id: group.id, member_id: pulled.member_id })
    assert.equal(released.ok, true)
    assert.equal(released.released, true)
    assert.deepEqual(host.state.drained, [{ parent: group.id, ids: [pulled.member_id] }])
    let snapshot = await service.state()
    let row = snapshot.groups.find((item) => item.id === group.id)
    assert.deepEqual(row.members, [], '已移除的成员不再出现在 active 名册')
    assert.deepEqual(row.removed.map((member) => member.id), [pulled.member_id])
    await service.restore({ group_id: group.id, member_id: pulled.member_id })
    snapshot = await service.state()
    row = snapshot.groups.find((item) => item.id === group.id)
    assert.deepEqual(row.removed, [])
    assert.equal(row.members.length, 1, '恢复的是名册显示，成员回到 active 名册')
    assert.equal(row.members[0].status, 'inactive', '但原生子代理已被释放，所以是 inactive（这是原生语义，不是 bug）')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
await check('群主离线时移除：只标记名册并给出说明', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agrp-group-'))
  try {
    const host = makeHost()
    const service = createGroupService(host.ctx, { registryFile: join(dir, 'groups.json') })
    const group = await service.createGroup({ cwd: 'D:\\work', preset_id: 'standard' })
    const pulled = await service.pull({ group_id: group.id, preset_id: 'se' })
    host.state.agents.clear()
    const released = await service.release({ group_id: group.id, member_id: pulled.member_id })
    assert.equal(released.ok, true)
    assert.equal(released.released, false)
    assert.match(released.note, /未驻留/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
await check('解散：释放全部成员 + 归档会话 + 清注册表', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agrp-group-'))
  try {
    const host = makeHost()
    const service = createGroupService(host.ctx, { registryFile: join(dir, 'groups.json') })
    const group = await service.createGroup({ cwd: 'D:\\work', preset_id: 'standard' })
    const a = await service.pull({ group_id: group.id, preset_id: 'se' })
    const dissolved = await service.dissolve({ group_id: group.id })
    assert.equal(dissolved.ok, true)
    assert.equal(dissolved.drained, 1)
    assert.equal(dissolved.archived, true)
    assert.deepEqual(host.state.drained[0].ids, [a.member_id])
    assert.deepEqual(host.state.archived, [group.id])
    assert.deepEqual((await service.state()).groups, [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
await check('改名：注册表与会话标题一起改', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agrp-group-'))
  try {
    const host = makeHost()
    const service = createGroupService(host.ctx, { registryFile: join(dir, 'groups.json') })
    const group = await service.createGroup({ cwd: 'D:\\work', preset_id: 'standard' })
    const renamed = await service.renameGroup({ group_id: group.id, name: '前端小组' })
    assert.equal(renamed.ok, true)
    assert.equal(host.state.titles.get(group.id), '前端小组')
    const snapshot = await service.state()
    assert.equal(snapshot.groups[0].name, '前端小组')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
await check('members()：@ 菜单拿某个会话自己的常驻成员', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agrp-group-'))
  try {
    const host = makeHost()
    const service = createGroupService(host.ctx, { registryFile: join(dir, 'groups.json') })
    host.state.children.set('session-x', [{ kind: 'child', id: 'c1', label: 'SE', activity: 'running', mode: 'continuable' }])
    const payload = await service.members({ sessionId: 'session-x' })
    assert.equal(payload.ok, true)
    assert.deepEqual(payload.members, [{ id: 'c1', name: 'SE', status: 'running', mode: 'continuable' }])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

const failed = results.filter((row) => !row.ok)
console.log('')
console.log(failed.length === 0 ? 'ALL PASS (' + results.length + ')' : failed.length + ' FAILED of ' + results.length)
process.exit(failed.length === 0 ? 0 : 1)
