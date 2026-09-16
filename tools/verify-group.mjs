/**
 * 群聊端到端实机验证：对着本机 GUI 的 HTTP 面跑一遍
 *   建群 → 拉一个 preset 当成员 → 读状态 → 移出 → 解散
 *
 * 用法：
 *   node tools/verify-group.mjs            完整走一遍（结束时会解散并归档验证群）
 *   node tools/verify-group.mjs --keep     保留验证群，方便在 GUI 里手看
 *   node tools/verify-group.mjs --cwd <dir>  指定验证群的工作目录（默认当前目录）
 *
 * 需要宿主已经重启到 v2：脚本先探测 `/state` 是否带 `default_group_preset`，
 * 否则直接告诉你"仍需重启 DSH"，不会去动任何东西。
 */

import { pathToFileURL } from 'node:url';

const BASE = 'http://127.0.0.1:3080/api/dsh-agent-panel';
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const cwdFlag = args.indexOf('--cwd');
const cwd = cwdFlag >= 0 && args[cwdFlag + 1] !== undefined ? args[cwdFlag + 1] : process.cwd();
const presetFlag = args.indexOf('--preset');
const presetId = presetFlag >= 0 && args[presetFlag + 1] !== undefined ? args[presetFlag + 1] : 'se';

/**
 * 宿主是否是 v2：v2 的 `/state` 一定带 `default_group_preset`，v1 没有。
 * 单独导出是为了能单测——这个判定一旦写反，脚本会把"没重启"说成"已就绪"（或反之），
 * 而它是实机验证的唯一入口。
 */
export function isV2State(payload) {
	return payload !== null && typeof payload === 'object' && !Array.isArray(payload)
		&& payload.default_group_preset !== undefined;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(path, method, body) {
	const response = await fetch(BASE + path, {
		method: method || 'GET',
		...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
	});
	const text = await response.text();
	let payload;
	try { payload = JSON.parse(text); } catch (error) { payload = { raw: text.slice(0, 400) }; }
	return { status: response.status, payload };
}

function line(label, value) {
	console.log('  ' + label.padEnd(22) + String(value));
}

async function main() {
	console.log('目标: ' + BASE);
	const probe = await call('/state');
	if (probe.status !== 200) {
		console.log('× /state 返回 ' + probe.status + '：' + JSON.stringify(probe.payload));
		process.exit(2);
	}
	if (!isV2State(probe.payload)) {
		console.log('× 宿主看起来仍是 v1（/state 没有 default_group_preset）→ 先重启 DSH 再跑本脚本。');
		line('现有 groups', (probe.payload.groups || []).length);
		process.exit(3);
	}
	console.log('✓ 宿主是 v2');
	line('默认群主 preset', probe.payload.default_group_preset);
	line('已安装 preset', (probe.payload.presets || []).map((preset) => preset.id).join(', '));
	line('现有群聊', (probe.payload.groups || []).length);

	console.log('\n[1/5] 建群');
	const created = await call('/group-create', 'POST', { cwd, preset_id: 'standard', name: '端到端验证群' });
	if (created.payload.ok !== true) {
		console.log('× 建群失败: ' + JSON.stringify(created.payload));
		process.exit(4);
	}
	line('群 id', created.payload.id);
	line('群名', created.payload.name);
	line('群主 preset', created.payload.preset_id);
	line('启动路径', created.payload.started_via);
	line('群主模型', created.payload.owner_model);

	console.log('\n[2/5] 拉人（preset=' + presetId + '）');
	const pulled = await call('/pull', 'POST', { group_id: created.payload.id, preset_id: presetId });
	if (pulled.payload.ok !== true) {
		console.log('× 拉人失败: ' + JSON.stringify(pulled.payload));
		if (!keep) await call('/group-dissolve', 'POST', { group_id: created.payload.id });
		process.exit(5);
	}
	line('成员 id', pulled.payload.member_id);
	line('成员名', pulled.payload.name);
	line('成员黑名单', pulled.payload.denied);
	line('能力面', pulled.payload.capability);
	if (pulled.payload.warning) line('告警', pulled.payload.warning);

	console.log('\n[3/5] 读状态（等 2 秒让成员开始跑）');
	await sleep(2000);
	const mid = await call('/state');
	const row = (mid.payload.groups || []).find((item) => item.id === created.payload.id);
	if (row === undefined) {
		console.log('× 状态里找不到刚建的群');
		process.exit(6);
	}
	line('群主在线', row.owner_live);
	line('群主模型', row.owner_model);
	line('成员数', row.members.length);
	for (const member of row.members) line('  · ' + member.name, member.status + (member.registered ? '' : '（群主拉的）'));
	if (row.capability_warning) line('能力告警', row.capability_warning);
	// 到这里状态已经尘埃落定：群主 agent 没有模型就说明这个群跑不起来，验证不能算通过。
	if (row.owner_model === null || row.owner_model === undefined) {
		console.log('× 群主 agent 没有 provider/model：群主会报 {{model}} 无值、成员会报 no provider/model。');
		if (!keep) await call('/group-dissolve', 'POST', { group_id: created.payload.id });
		process.exit(7);
	}

	console.log('\n[4/5] 移出成员');
	const released = await call('/release', 'POST', { group_id: created.payload.id, member_id: pulled.payload.member_id });
	line('已释放子代理', released.payload.released);
	line('备注', released.payload.note === undefined ? '-' : released.payload.note);
	const afterRelease = await call('/state');
	const row2 = (afterRelease.payload.groups || []).find((item) => item.id === created.payload.id);
	line('成员区', (row2.members || []).map((member) => member.name).join(', ') || '(空)');
	line('已移除区', (row2.removed || []).map((member) => member.name).join(', ') || '(空)');

	if (keep) {
		console.log('\n[5/5] --keep：保留验证群，请在 GUI 里打开会话「' + created.payload.name + '」查看。');
		line('群 id', created.payload.id);
		console.log('\n全部断言通过（保留模式）。');
		return;
	}

	console.log('\n[5/5] 解散');
	const dissolved = await call('/group-dissolve', 'POST', { group_id: created.payload.id });
	line('释放成员数', dissolved.payload.drained);
	line('会话已归档', dissolved.payload.archived);
	const final = await call('/state');
	line('剩余群聊', (final.payload.groups || []).length);
	console.log('\n全部断言通过（已清理）。');
}

const executedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (executedDirectly) {
	main().catch((error) => {
		console.log('× 异常: ' + String((error && error.message) || error));
		process.exit(1);
	});
}
