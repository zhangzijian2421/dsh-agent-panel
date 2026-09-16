/**
 * Logic test for 群内 @ = 派活 (src: lib/dispatch.js installMemberDispatch).
 * No test runner: plain node, fake resolver + fake subagents, assertions by hand.
 *
 * 背景（实机现象）：群里只有 SE 一个成员，用户 @ 了它并写了任务，结果**群主自己**动手干活，
 * SE 停在「已就位」。原因是 DSH 的 `@` 只是会话引用（把对方记录快照塞进当前 agent 的上下文），
 * 不是派活。这里钉住修复后的行为：群内 @ 成员会被真的转达给那个成员，并给群主留一行说明。
 *
 * Run: node test/member-dispatch.test.mjs
 */
import { dispatchNote, installMemberDispatch, stripMention, textOf } from '../lib/dispatch.js'
const GROUP = 'session-group'
const PLAIN = 'session-plain'
const SE = 'child-se'
const SA = 'child-sa'
const DEEP = 'grandchild-x'

let failures = 0
const check = (label, actual, expected) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected)
	if (!ok) failures += 1
	console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok ? '' : '\n      expected ' + JSON.stringify(expected) + '\n      actual   ' + JSON.stringify(actual)))
}

const makeWorld = (options) => {
	const opts = options || {}
	const sent = []
	const children = [{ kind: 'child', id: SE, label: 'SE 需求分析', mode: 'continuable', activity: 'idle' }]
	if (opts.withSa === true) children.push({ kind: 'child', id: SA, label: 'SA 架构', mode: 'continuable', activity: 'idle' })
	const subagents = {
		async listChildren() {
			if (opts.listFails === true) throw new Error('catalog down')
			return children
		},
		async sendMessage(sender, targetId, content, sendOptions) {
			if (opts.sendFails === true) throw new Error('delivery refused')
			sent.push({ sender: String(sender.id), targetId: String(targetId), text: content.map((block) => block.text).join('\n'), hasSignal: typeof sendOptions.signal.throwIfAborted === 'function' })
			return 'msg-' + sent.length
		},
	}
	const resolver = {
		async prepare(agent, content) { return { content, additionalContext: { marker: 'snapshot' } } }
	}
	const ctx = {
		get: (name) => {
			if (name === 'sessionReferenceResolver') return resolver
			if (name === 'subagents') return subagents
			return undefined
		}
	}
	return { ctx, resolver, sent, children }
}

const agentOf = (id) => ({ id, session: { header: { id } } })

const test = async () => {
	check('textOf 只取 text 块', textOf([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]), 'a\nb')
	check('stripMention 只摘 @，不删标签文字', stripMention('@SE 需求分析 分析下当前工程', 'SE 需求分析'), 'SE 需求分析 分析下当前工程')
	check('stripMention 提及在句中也不改坏句子', stripMention('让 @SE 需求分析 看下这个方案', 'SE 需求分析'), '让 SE 需求分析 看下这个方案')
	check('stripMention 没有 @label 时原样（去空白）', stripMention('  分析下当前工程  ', 'SE 需求分析'), '分析下当前工程')

	// 1) 群内 @ 成员：真的派活，并在群主看到的消息后追加说明。
	{
		const { ctx, resolver, sent } = makeWorld()
		const isGroup = (id) => id === GROUP
		const dispose = installMemberDispatch(ctx, { isGroup })
		const content = [{ type: 'text', text: '@SE 需求分析 分析下当前工程 补充一个详细设计文档' }]
		const resolved = await resolver.prepare(agentOf(GROUP), content, [{ sessionId: SE, label: 'SE 需求分析' }], undefined)
		check('群内 @ 成员 → 派活原文（@ 记号已摘）', sent, [{
			sender: GROUP, targetId: SE, text: 'SE 需求分析 分析下当前工程 补充一个详细设计文档', hasSignal: true
		}])
		check('群主消息追加派活说明', resolved.content.length, 2)
		check('说明认得出成员名', /SE 需求分析/.test(resolved.content[1].text), true)
		check('引用快照原样保留', resolved.additionalContext.marker, 'snapshot')
		dispose()
	}

	// 2) 普通会话里的 @：什么都不做（保持 shipped 的引用语义）。
	{
		const { ctx, resolver, sent } = makeWorld()
		const dispose = installMemberDispatch(ctx, { isGroup: (id) => id === GROUP })
		const content = [{ type: 'text', text: '@SE 需求分析 看看这个' }]
		const resolved = await resolver.prepare(agentOf(PLAIN), content, [{ sessionId: SE, label: 'SE 需求分析' }], undefined)
		check('非群会话不派活', sent, [])
		check('非群会话不改消息', resolved.content.length, 1)
		dispose()
	}

	// 3) 群内 @ 了一个不是直接子代理的会话：不派活（列在目录里的才是成员）。
	{
		const { ctx, resolver, sent } = makeWorld()
		const dispose = installMemberDispatch(ctx, { isGroup: () => true })
		await resolver.prepare(agentOf(GROUP), [{ type: 'text', text: '@DEEP 干活' }], [{ sessionId: DEEP, label: 'DEEP' }], undefined)
		check('非成员（如孙会话/普通会话）不派活', sent, [])
		dispose()
	}

	// 4) 消息里只有 @ 没有任务：不派活（避免骚扰成员）。
	{
		const { ctx, resolver, sent } = makeWorld()
		const dispose = installMemberDispatch(ctx, { isGroup: () => true })
		await resolver.prepare(agentOf(GROUP), [{ type: 'text', text: '@SE 需求分析' }], [{ sessionId: SE, label: 'SE 需求分析' }], undefined)
		await resolver.prepare(agentOf(GROUP), [{ type: 'text', text: '@SE 需求分析？' }], [{ sessionId: SE, label: 'SE 需求分析' }], undefined)
		check('空任务不派活', sent, [])
		dispose()
	}

	// 5) 两个成员被 @：都派活，说明里点名两位。
	{
		const { ctx, resolver, sent } = makeWorld({ withSa: true })
		const dispose = installMemberDispatch(ctx, { isGroup: () => true })
		const resolved = await resolver.prepare(agentOf(GROUP), [{ type: 'text', text: '@SE 需求分析 @SA 架构 一起看下' }], [
			{ sessionId: SE, label: 'SE 需求分析' },
			{ sessionId: SA, label: 'SA 架构' }
		], undefined)
		check('两个成员各自收到一份', sent.map((row) => row.targetId), [SE, SA])
		check('说明点名两位', /SE 需求分析/.test(resolved.content[1].text) && /SA 架构/.test(resolved.content[1].text), true)
		dispose()
	}

	// 6) 同一个成员被 @ 两次：只派一次。
	{
		const { ctx, resolver, sent } = makeWorld()
		const dispose = installMemberDispatch(ctx, { isGroup: () => true })
		await resolver.prepare(agentOf(GROUP), [{ type: 'text', text: '@SE 需求分析 干活' }], [
			{ sessionId: SE, label: 'SE 需求分析' },
			{ sessionId: SE, label: 'SE 需求分析' }
		], undefined)
		check('重复引用只派一次', sent.length, 1)
		dispose()
	}

	// 7) 派活失败 / 目录读取失败：静默降级，绝不改消息、绝不抛。
	{
		const { ctx, resolver, sent } = makeWorld({ sendFails: true })
		const dispose = installMemberDispatch(ctx, { isGroup: () => true })
		const resolved = await resolver.prepare(agentOf(GROUP), [{ type: 'text', text: '@SE 需求分析 干活' }], [{ sessionId: SE, label: 'SE 需求分析' }], undefined)
		check('投递失败不写说明', resolved.content.length, 1)
		check('投递失败仍尝试过', sent, [])
		dispose()
	}
	{
		const { ctx, resolver, sent } = makeWorld({ listFails: true })
		const dispose = installMemberDispatch(ctx, { isGroup: () => true })
		const resolved = await resolver.prepare(agentOf(GROUP), [{ type: 'text', text: '@SE 需求分析 干活' }], [{ sessionId: SE, label: 'SE 需求分析' }], undefined)
		check('目录读取失败不派活也不炸', [sent.length, resolved.content.length], [0, 1])
		dispose()
	}

	// 8) subagents 缺席（例如精简部署）：整条链路安静地不做事。
	{
		const resolver = { async prepare(agent, content) { return { content } } }
		const ctx = { get: (name) => (name === 'sessionReferenceResolver' ? resolver : undefined) }
		const dispose = installMemberDispatch(ctx, { isGroup: () => true })
		const resolved = await resolver.prepare(agentOf(GROUP), [{ type: 'text', text: '@SE 需求分析 干活' }], [{ sessionId: SE, label: 'SE 需求分析' }], undefined)
		check('subagents 缺席时只做引用', resolved.content.length, 1)
		dispose()
	}

	// 9) dispose 还原实例方法（与 listCandidates 的拦截同构）。
	{
		const { ctx, resolver } = makeWorld()
		const original = resolver.prepare
		const dispose = installMemberDispatch(ctx, { isGroup: () => true })
		check('安装后 prepare 被替换', resolver.prepare === original, false)
		dispose()
		check('dispose 还原 prepare', resolver.prepare === original, true)
	}

	// 10) resolver 形状不符：返回 undefined，交给调用方等 inject。
	{
		check('缺 resolver 时返回 undefined', installMemberDispatch({ get: () => undefined }, {}), undefined)
		check('resolver 没有 prepare 时返回 undefined', installMemberDispatch({ get: () => ({ listCandidates: () => [] }) }, {}), undefined)
	}

	check('dispatchNote 是给人看的说明', /原样转达/.test(dispatchNote([{ id: SE, name: 'SE 需求分析' }])), true)
}

await test()
console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
