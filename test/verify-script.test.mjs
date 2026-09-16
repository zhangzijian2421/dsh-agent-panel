/**
 * 验证脚本自身的判定逻辑：`tools/verify-group.mjs` 是实机验证的唯一入口，
 * 它靠 `/state` 是否带 `default_group_preset` 判断宿主是 v1 还是 v2。
 * 这个判定写反的后果很实际——要么把"还没重启"报成就绪，要么把已就绪报成没重启，
 * 所以它必须被单测钉住。
 */
import assert from 'node:assert/strict'
import { isV2State } from '../tools/verify-group.mjs'

const results = []
function check(label, fn) {
	try {
		fn()
		results.push({ label, ok: true })
		console.log('  ok   ' + label)
	} catch (error) {
		results.push({ label, ok: false })
		console.log('  FAIL ' + label + ' → ' + String((error && error.message) || error))
	}
}

console.log('verify script: 版本判定')
check('v2 载荷（带 default_group_preset）判定为 v2', () => {
	assert.equal(isV2State({ default_group_preset: 'standard', groups: [], presets: [], caps: {} }), true)
	assert.equal(isV2State({ default_group_preset: undefined }), false, 'undefined 等于没有这个字段')
})
check('v1 载荷判定为 v1', () => {
	assert.equal(isV2State({ caps: {}, groups: [{ session_id: 'session-x' }], presets: [] }), false)
})
check('坏载荷不会误判成 v2', () => {
	assert.equal(isV2State(null), false)
	assert.equal(isV2State(undefined), false)
	assert.equal(isV2State('default_group_preset'), false)
	assert.equal(isV2State(42), false)
	assert.equal(isV2State([{ default_group_preset: 'standard' }]), false, '数组不是状态载荷')
	assert.equal(isV2State({ error: 'boom' }), false, '错误响应不是 v2 状态')
})

const failed = results.filter((row) => !row.ok)
console.log('')
console.log(failed.length === 0 ? 'ALL PASS (' + results.length + ')' : failed.length + ' FAILED of ' + results.length)
process.exit(failed.length === 0 ? 0 : 1)
