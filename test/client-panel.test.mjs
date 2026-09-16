/**
 * 会话头触发器 + 下拉面板的逻辑测试：用共享测试台在 VM 里跑**真实的客户端包**，
 * 断言面板与宿主之间的接线（RPC 路径、请求字段名、两步确认、错误渲染）。
 *
 * 为什么值得单独测：这些字段名（group_id / preset_id / session_id / member_id）一旦写错，
 * 面板只会静默失败，而实机验证要重启 DSH 才能做一次——这里能在毫秒级跑完每一次交互。
 */
import assert from "node:assert/strict";
import { createSuite, findButton, findButtons, loadClient, openPanel, openWithData, texts, walk } from "./helpers/client-harness.mjs";

const assertThat = (value, message) => assert.ok(value, message);
const suite = createSuite();
const check = suite.check;

const CANNED = {
	"/api/dsh-agent-panel/state": {
		default_group_preset: "group-host",
		presets: [
			{ id: "group-host", name: "群聊 Agent", description: "群聊主控：盘点成员能力边界并派活", trust: "user" },
			{ id: "standard", name: "标准模式", description: "完整编码 agent", trust: "system" },
			{ id: "se", name: "SE 需求分析", description: "只做需求分析", trust: "user" }
		],
		groups: [{
			id: "group-1",
			name: "群聊 · 1",
			cwd: "D:\\work",
			preset_id: "minimal",
			owner_live: true,
			owner_model: "deepseek-official/deepseek-flash",
			created_at: 1,
			capability_warning: "群主 preset 是 minimal（只有持久 shell）",
			members: [
				{ id: "child-1", name: "SE 需求分析", preset_id: "se", status: "running", registered: true },
				{ id: "child-9", name: "野生成员", preset_id: "", status: "idle", registered: false }
			],
			removed: [{ id: "child-0", name: "老成员", preset_id: "se" }]
		}]
	}
};

const load = () => loadClient({ canned: CANNED });

console.log("client panel: 座位与开关")
const first = load();
await check("三个座位都注册了（头部触发器 / 空会话 dock / overlay 面板）", () => {
	assertThat(first.seats.has("conversation.session.header.utilities"), "缺少头部座位");
	assertThat(first.seats.has("conversation.input.dock"), "缺少 dock 座位");
	assertThat(first.seats.has("shell.overlay"), "缺少 overlay 座位");
});
await check("面板关闭时不渲染", () => {
	const node = first.render(first.seats.get("shell.overlay"), {});
	assertThat(node === null, "关闭态应返回 null");
});

console.log("client panel: 首屏")
openPanel(first.seats, first.render);
const loading = first.render(first.seats.get("shell.overlay"), {});
await check("打开后先显示加载中", () => {
	assertThat(texts(loading).includes("加载中"), "应显示加载中：" + texts(loading));
	assert.equal(first.calls.length, 1, "打开时应请求一次 state");
	assert.equal(first.calls[0].path, "/api/dsh-agent-panel/state");
	assert.equal(first.calls[0].method, "GET");
});
await new Promise((resolve) => setImmediate(resolve));
const panel = first.render(first.seats.get("shell.overlay"), {});
await check("拿到状态后渲染群聊、成员、已移除、preset 与能力告警", () => {
	const text = texts(panel);
	assertThat(text.includes("群聊 · 1"), "缺群名：" + text);
	assertThat(text.includes("SE 需求分析"), "缺注册成员");
	assertThat(text.includes("野生成员"), "缺原生外来成员");
	assertThat(text.includes("群主拉的"), "外来成员应标出「群主拉的」");
	assertThat(text.includes("已移除"), "缺已移除分区");
	assertThat(text.includes("老成员"), "缺已移除成员名");
	assertThat(text.includes("标准模式") && text.includes("SE 需求分析"), "缺可拉 preset 列表");
	assertThat(text.includes("群主 preset 是 minimal"), "缺能力面告警");
	assertThat(findButton(panel, "打开群聊会话") !== undefined, "缺打开会话按钮");
	assert(text.includes("deepseek-official/deepseek-flash"), "应显示群主模型：" + text);
});

console.log("client panel: 交互")
await check("拉人列表排除群主 preset（它是群主，不能当成员）", () => {
	const panel0 = first.render(first.seats.get("shell.overlay"), {});
	const text = texts(panel0);
	assert.equal(findButtons(panel0, "拉入本群").length, 2, "只该列出 standard 与 se 两个成员 preset");
	const at = text.indexOf("拉进本群");
	assertThat(text.slice(at).includes("群聊 Agent") === false, "群主 preset 不该出现在拉人列表：" + text.slice(at));
});
await check("拉人：POST /pull 带 group_id + preset_id", async () => {
	first.calls.length = 0;
	const button = findButton(panel, "拉入本群");
	assertThat(button !== undefined, "缺拉入按钮");
	button.props.onClick();
	await new Promise((resolve) => setImmediate(resolve));
	const call = first.calls.find((row) => row.path.endsWith("/pull"));
	assertThat(call !== undefined, "没有发出 pull 请求");
	assert.equal(call.method, "POST");
	assert.deepEqual(call.body, { group_id: "group-1", preset_id: "standard" });
});
await check("移出：第一次点击只进入确认态，第二次才真发请求", async () => {
	first.calls.length = 0;
	const render = first.render;
	let node = render(first.seats.get("shell.overlay"), {});
	const remove = findButtons(node, "移出")[0];
	assertThat(remove !== undefined, "缺移出按钮");
	remove.props.onClick();
	node = render(first.seats.get("shell.overlay"), {});
	assertThat(first.calls.length === 0, "第一次点击不应发请求");
	assertThat(findButton(node, "确认移出") !== undefined, "应变成确认态");
	findButton(node, "确认移出").props.onClick();
	await new Promise((resolve) => setImmediate(resolve));
	const call = first.calls.find((row) => row.path.endsWith("/release"));
	assertThat(call !== undefined, "没有发出 release 请求");
	assert.deepEqual(call.body, { group_id: "group-1", member_id: "child-1" });
});
await check("恢复：POST /restore 带 member_id", async () => {
	first.calls.length = 0;
	const node = first.render(first.seats.get("shell.overlay"), {});
	const restore = findButton(node, "恢复");
	assertThat(restore !== undefined, "缺恢复按钮");
	restore.props.onClick();
	await new Promise((resolve) => setImmediate(resolve));
	const call = first.calls.find((row) => row.path.endsWith("/restore"));
	assertThat(call !== undefined, "没有发出 restore 请求");
	assert.deepEqual(call.body, { group_id: "group-1", member_id: "child-0" });
});
await check("解散：两步确认后 POST /group-dissolve", async () => {
	first.calls.length = 0;
	let node = first.render(first.seats.get("shell.overlay"), {});
	findButton(node, "解散群聊").props.onClick();
	node = first.render(first.seats.get("shell.overlay"), {});
	assertThat(first.calls.length === 0, "第一次点击不应发请求");
	const confirm = findButton(node, "确认解散");
	assertThat(confirm !== undefined, "缺确认解散按钮");
	confirm.props.onClick();
	await new Promise((resolve) => setImmediate(resolve));
	const call = first.calls.find((row) => row.path.endsWith("/group-dissolve"));
	assertThat(call !== undefined, "没有发出 dissolve 请求");
	assert.deepEqual(call.body, { group_id: "group-1" });
});

console.log("client panel: 错误与第二个群")
const second = load();
const secondNode = await openWithData(second);
await check("宿主返回 ok:false 时把 error 渲染成错误行", async () => {
	CANNED["/api/dsh-agent-panel/pull"] = { ok: false, error: "成员名「SE 需求分析」已被占用" };
	findButton(secondNode, "拉入本群").props.onClick();
	await new Promise((resolve) => setImmediate(resolve));
	const after = second.render(second.seats.get("shell.overlay"), {});
	assertThat(texts(after).includes("已被占用"), "应显示宿主错误：" + texts(after));
	delete CANNED["/api/dsh-agent-panel/pull"];
});
await check("没有群聊时提示先建群，并给出创建入口（群主 preset 固定，不可选）", async () => {
	CANNED["/api/dsh-agent-panel/state"] = { default_group_preset: "group-host", presets: CANNED["/api/dsh-agent-panel/state"].presets, groups: [] };
	const third = load();
	const node = await openWithData(third);
	const text = texts(node);
	assertThat(text.includes("还没有群聊"), "应提示没有群聊：" + text);
	assertThat(findButton(node, "创建群聊") !== undefined, "缺创建群聊按钮");
	let select;
	walk(node, (element) => { if (element.type === "select") select = element; });
	assertThat(select === undefined, "不该再有群主 preset 选择器");
	assertThat(text.includes("群聊 Agent"), "应写明固定的群主 preset：" + text);
	third.calls.length = 0;
	findButton(node, "创建群聊").props.onClick();
	await new Promise((resolve) => setImmediate(resolve));
	const call = third.calls.find((row) => row.path.endsWith("/group-create"));
	assertThat(call !== undefined, "没有发出 group-create 请求");
	assert.deepEqual(call.body, { session_id: "session-me" });
});
await check("已移除成员不再出现在成员区（分区互斥）", () => {
	const node = first.render(first.seats.get("shell.overlay"), {});
	const text = texts(node);
	const membersAt = text.indexOf("成员（");
	const removedAt = text.indexOf("已移除（");
	assertThat(membersAt >= 0 && removedAt > membersAt, "两个分区都应在");
	const memberSection = text.slice(membersAt, removedAt);
	assertThat(memberSection.includes("SE 需求分析"), "active 区应有注册成员");
	assertThat(!memberSection.includes("老成员"), "active 区不应包含已移除成员");
});

console.log("client panel: @ 菜单源")
const at = load();
const source0 = at.sources[0];
await check("注册了 @ 源（trigger/name/order/无 header）", () => {
	assertThat(at.sources.length === 1, "应只注册一个 @ 源，实际 " + at.sources.length);
	assert.equal(source0.trigger, "@");
	assert.equal(source0.name, "session-agents");
	assert.equal(source0.order, -10);
	assert.equal(source0.showGroupTitle, false);
	assertThat(source0.header === undefined, "不能提供 header（那是面包屑钩子）");
});
await check("没有 sessionId 时返回空数组", async () => {
	// 注意：这些数组来自 VM realm，原型与宿主不同，所以只比长度/内容，不用 deepEqual。
	assert.equal((await source0.candidates(undefined, { query: "" })).length, 0);
	assert.equal((await source0.candidates({}, { query: "" })).length, 0);
});
await check("候选：名字用 agent 名，value 里是规范会话引用", async () => {
	CANNED["/api/dsh-agent-panel/members"] = {
		ok: true,
		sessionId: "session-me",
		members: [
			{ id: "child-1", name: "SE 需求分析", status: "running", mode: "continuable" },
			{ id: "child-2", name: "开发", status: "idle", mode: "one-shot" }
		]
	};
	const rows = await source0.candidates({ sessionId: "session-me" }, { query: "" });
	assert.equal(at.calls[at.calls.length - 1].path, "/api/dsh-agent-panel/members?sessionId=session-me");
	assert.equal(rows.length, 2);
	assert.equal(rows[0].name, "SE 需求分析");
	assert.equal(rows[0].section, "本会话子 agent");
	assert.match(rows[0].description, /常驻成员 · 运行中/);
	assert.match(rows[1].description, /一次性 · 待命/);
	const value = JSON.parse(rows[0].value);
	assert.equal(value.kind, "session");
	assert.equal(value.label, "SE 需求分析");
	// 与宿主 codec 逐字节一致：@[label](dsh-session:<base64url(JSON.stringify(id))>)
	const expected = "@[SE 需求分析](dsh-session:" + Buffer.from(JSON.stringify("child-1"), "utf8").toString("base64")
		.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") + ")";
	assert.equal(value.mention, expected);
});
await check("候选：按名字/id 过滤查询串", async () => {
	const hit = await source0.candidates({ sessionId: "session-me" }, { query: "开发" });
	assert.equal([...hit].map((row) => row.name).join(","), "开发");
	const byId = await source0.candidates({ sessionId: "session-me" }, { query: "child-1" });
	assert.equal([...byId].map((row) => row.name).join(","), "SE 需求分析");
	assert.equal((await source0.candidates({ sessionId: "session-me" }, { query: "zzz" })).length, 0);
});
await check("candidates 永不 reject：fetch 抛错时降级成空数组", async () => {
	CANNED["/api/dsh-agent-panel/members"] = { __throw: "network down" };
	const rows = await source0.candidates({ sessionId: "session-me" }, { query: "" });
	assert.equal(rows.length, 0);
	delete CANNED["/api/dsh-agent-panel/members"];
});
await check("onPick 产出 reference 插入（含剪贴板文本）", async () => {
	CANNED["/api/dsh-agent-panel/members"] = {
		ok: true,
		sessionId: "session-me",
		members: [{ id: "child-1", name: "SE 需求分析", status: "running", mode: "continuable" }]
	};
	const rows = await source0.candidates({ sessionId: "session-me" }, { query: "" });
	const picked = source0.onPick({ candidate: rows[0] });
	assert.equal(picked.insert.source, "reference");
	assert.equal(picked.insert.label, "SE 需求分析");
	assert.equal(picked.insert.appearance, "session");
	assert.equal(picked.insert.ref, picked.insert.clipboardText);
	assert.match(picked.insert.ref, /^@\[SE 需求分析\]\(dsh-session:/);
});
await check("onPick 对坏 value / 非 session 值返回 undefined", () => {
	assert.equal(source0.onPick({ candidate: { value: "{ not json" } }), undefined);
	assert.equal(source0.onPick({ candidate: { value: JSON.stringify({ kind: "file" }) } }), undefined);
});

suite.finish();
