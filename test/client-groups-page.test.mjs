/**
 * 「群聊」主面板（`sidebar.panellist` 入口 + `main` 页面）的逻辑测试。
 *
 * 这一层最值钱的是**工作区挂载**：群会话只有被 `workspaces.insertSessionBefore` 挂进某个工作区，
 * 才会出现在左侧"工作区下面"（工作区持有自己的 sessionIds）。这个链路上任何一个字段写错，
 * 表现都只是"群不见了"，所以必须钉住。
 */
import assert from "node:assert/strict";
import { createSuite, findButton, findButtons, findInputs, findSelects, loadClient, renderGroupsPage, texts, walk } from "./helpers/client-harness.mjs";

const suite = createSuite();

const PRESETS = [
	{ id: "standard", name: "标准模式", description: "完整编码 agent", trust: "system" },
	{ id: "se", name: "SE 需求分析", description: "只做需求分析", trust: "user" },
	{ id: "minimal", name: "极简模式", description: "只有 shell", trust: "system" }
];

const STATE = {
	default_group_preset: "standard",
	presets: PRESETS,
	groups: [
		{
			id: "group-attached",
			name: "群聊 · 已挂",
			cwd: "D:\\work",
			preset_id: "standard",
			owner_live: true,
			owner_model: "deepseek-official/deepseek-flash",
			workspace_id: "ws-1",
			workspace_title: "项目A",
			created_at: 2,
			members: [{ id: "m1", name: "SE 需求分析", preset_id: "se", status: "running", registered: true }],
			removed: [{ id: "m0", name: "老成员", preset_id: "se" }]
		},
		{
			id: "group-free",
			name: "群聊 · 未挂",
			cwd: "D:\\other",
			preset_id: "minimal",
			owner_live: false,
			owner_model: null,
			created_at: 1,
			capability_warning: "群主 preset 是 minimal（只有持久 shell）",
			members: [],
			removed: []
		}
	]
};

const WORKSPACES = [
	{ workspaceId: "ws-1", path: "D:\\work", title: "项目A", sessionIds: ["group-attached"] },
	{ workspaceId: "ws-2", path: "D:\\other", title: "项目B", sessionIds: [] }
];

function makeInstance(overrides) {
	const canned = {
		"/api/dsh-agent-panel/state": JSON.parse(JSON.stringify(STATE)),
		"/api/dsh-agent-panel/group-create": { ok: true, id: "group-new", name: "群聊 · 1", cwd: "D:\\work", preset_id: "standard", owner_model: "deepseek-official/deepseek-flash", workspace_title: "项目A" },
		"/api/dsh-agent-panel/group-attach": { ok: true, workspace_id: "ws-1", workspace_title: "项目A", already: false },
		...(overrides || {})
	};
	const effects = [];
	const services = {
		workspaces: {
			insertSessionBefore: (workspaceId, sessionId, beforeSessionId) => {
				effects.push({ kind: "insert", workspaceId, sessionId, beforeSessionId });
				return Promise.resolve({});
			},
			create: (input) => {
				effects.push({ kind: "create", path: input.path });
				return Promise.resolve({ workspaceId: "ws-new", path: input.path, title: "新工作区", sessionIds: [] });
			}
		},
		uiWorkspace: {
			openSession: (id) => { effects.push({ kind: "open", id }); },
			pickDirectory: () => { effects.push({ kind: "pick" }); return Promise.resolve("D:\\picked"); }
		}
	};
	const instance = loadClient({ canned, services });
	const props = {
		useWorkspaces: (selector) => selector({ items: WORKSPACES })
	};
	return { instance, canned, effects, props };
}

/** 面板页面渲染后取节点（helper 里已经等过一次 microtask）。 */
async function page(instance, props) {
	return renderGroupsPage(instance, props);
}

console.log("groups page: 注册")
await suite.check("侧边栏入口注册在 sidebar.panellist 且 label 是「群聊」", () => {
	const { instance } = makeInstance();
	const registration = instance.registrations.get("sidebar.panellist");
	assert.ok(registration !== undefined, "没有注册 sidebar.panellist");
	assert.equal(registration.id, "agent-groups");
	assert.equal(registration.name, "sidebar.panellist");
	assert.equal(typeof registration.label, "function");
	assert.equal(registration.label(), "群聊");
	assert.equal(typeof instance.seats.get("sidebar.panellist"), "function", "图标组件要一起给");
});
await suite.check("主面板注册在 main 且 key 与入口 id 一致", () => {
	const { instance } = makeInstance();
	const registration = instance.registrations.get("main");
	assert.ok(registration !== undefined, "没有注册 main");
	assert.equal(registration.key, "agent-groups");
	assert.equal(typeof instance.seats.get("main"), "function");
});
await suite.check("原有座位没被挤掉（头部触发器 / 空会话 dock / overlay）", () => {
	const { instance } = makeInstance();
	for (const name of ["conversation.session.header.utilities", "conversation.input.dock", "shell.overlay"]) {
		assert.ok(instance.seats.has(name), "缺少座位 " + name);
	}
});

console.log("groups page: 渲染")
await suite.check("列出每个群：目录 / preset / 模型 / 成员 / 已移除 / 侧边栏状态", async () => {
	const { instance, props } = makeInstance();
	const node = await page(instance, props);
	const text = texts(node);
	assert.ok(findInputs(node).some((input) => input.props.value === "群聊 · 已挂"), "群名渲染在输入框里：" + text);
	assert.ok(text.indexOf("D:\\work") >= 0, "应显示完整工作目录：" + text);
	assert.ok(text.indexOf("模型 deepseek-official/deepseek-flash") >= 0, text);
	assert.ok(text.indexOf("侧边栏：已在「项目A」下") >= 0, "已挂的群要显示挂在哪个工作区：" + text);
	assert.ok(text.indexOf("SE 需求分析") >= 0, text);
	assert.ok(text.indexOf("[running]") >= 0, text);
	assert.ok(text.indexOf("老成员") >= 0 && text.indexOf("[已移除]") >= 0, "已移除分区：" + text);
	assert.ok(text.indexOf("群主 preset 是 minimal") >= 0, "能力面告警应显示：" + text);
	assert.ok(findButton(node, "打开群聊会话") !== undefined, "缺打开会话按钮");
	assert.ok(findButton(node, "解散群聊") !== undefined, "缺解散按钮");
	assert.equal(findButtons(node, "挂到侧边栏").length, 1, "只有未挂的那个群需要「挂到侧边栏」");
});

console.log("groups page: 创建工作区挂载")
await suite.check("创建群聊：POST /group-create（cwd + preset）后调宿主 group-attach 归属", async () => {
	const { instance, props } = makeInstance();
	const node = await page(instance, props);
	instance.calls.length = 0;
	findButton(node, "创建群聊").props.onClick();
	await new Promise((resolve) => setImmediate(resolve));
	const call = instance.calls.find((row) => row.path.endsWith("/group-create"));
	assert.ok(call !== undefined, "没有发出 group-create 请求");
	assert.deepEqual(call.body, { cwd: "D:\\work", preset_id: "standard" });
	const attachCall = instance.calls.find((row) => row.path.endsWith("/group-attach"));
	assert.ok(attachCall !== undefined, "创建后必须调宿主把它归属到工作区（客户端 insertSessionBefore 对未归属会话会报 not accounted）");
	assert.deepEqual(attachCall.body, { group_id: "group-new" });
});
await suite.check("宿主说目录不是工作区时：客户端先 workspaces.create 再重试归属", async () => {
	const { instance, effects, props, canned } = makeInstance();
	canned["/api/dsh-agent-panel/group-create"] = { ok: true, id: "group-new", name: "群聊 · 1", cwd: "D:\\brand-new", preset_id: "standard" };
	canned["/api/dsh-agent-panel/group-attach"] = { ok: false, error: "该目录还不是工作区（先在 GUI 里把它加为工作区）" };
	const node = await page(instance, props);
	const selects = findSelects(node);
	selects[0].props.onChange({ target: { value: "D:\\brand-new" } });
	const rerendered = instance.render(instance.seats.get("main"), props);
	findButton(rerendered, "创建群聊").props.onClick();
	await new Promise((resolve) => setImmediate(resolve));
	const created = effects.find((row) => row.kind === "create");
	assert.ok(created !== undefined, "目录不在工作区列表里时应新建工作区");
	assert.deepEqual(created, { kind: "create", path: "D:\\brand-new" });
	const attaches = instance.calls.filter((row) => row.path.endsWith("/group-attach"));
	assert.equal(attaches.length, 2, "归属失败且原因是不是工作区时应重试一次");
});
await suite.check("「选择目录」用 uiWorkspace.pickDirectory，选中后按它建群", async () => {
	const { instance, effects, props } = makeInstance();
	let node = await page(instance, props);
	findButton(node, "选择目录").props.onClick();
	await new Promise((resolve) => setImmediate(resolve));
	assert.ok(effects.some((row) => row.kind === "pick"), "没有调用 pickDirectory");
	node = instance.render(instance.seats.get("main"), props);
	instance.calls.length = 0;
	findButton(node, "创建群聊").props.onClick();
	await new Promise((resolve) => setImmediate(resolve));
	const call = instance.calls.find((row) => row.path.endsWith("/group-create"));
	assert.equal(call.body.cwd, "D:\\picked", "应该用选择器返回的目录");
});

console.log("groups page: 挂载与群操作")
await suite.check("「挂到侧边栏」POST /group-attach（宿主侧 attachSession）", async () => {
	const { instance, props } = makeInstance();
	const node = await page(instance, props);
	instance.calls.length = 0;
	findButton(node, "挂到侧边栏").props.onClick();
	await new Promise((resolve) => setImmediate(resolve));
	const attachCall = instance.calls.find((row) => row.path.endsWith("/group-attach"));
	assert.ok(attachCall !== undefined, "没有发出 group-attach 请求");
	assert.deepEqual(attachCall.body, { group_id: "group-free" });
	const after = instance.render(instance.seats.get("main"), props);
	assert.ok(texts(after).indexOf("项目A") >= 0, "归属成功后应给出提示：" + texts(after));
});
await suite.check("「打开群聊会话」走 uiWorkspace.openSession", async () => {
	const { instance, effects, props } = makeInstance();
	const node = await page(instance, props);
	findButtons(node, "打开群聊会话")[0].props.onClick();
	assert.ok(effects.some((row) => row.kind === "open" && row.id === "group-attached"), JSON.stringify(effects));
});
await suite.check("拉人：POST /pull 带 group_id + 选中的 preset", async () => {
	const { instance, props } = makeInstance();
	const node = await page(instance, props);
	instance.calls.length = 0;
	findButtons(node, "拉入本群")[0].props.onClick();
	await new Promise((resolve) => setImmediate(resolve));
	const call = instance.calls.find((row) => row.path.endsWith("/pull"));
	assert.ok(call !== undefined, "没有发出 pull");
	assert.deepEqual(call.body, { group_id: "group-attached", preset_id: "standard" });
});
await suite.check("移除两步确认：第一次只进确认态，第二次才 POST /release", async () => {
	const { instance, props } = makeInstance();
	let node = await page(instance, props);
	instance.calls.length = 0;
	findButtons(node, "移出")[0].props.onClick();
	node = instance.render(instance.seats.get("main"), props);
	assert.equal(instance.calls.length, 0, "第一次点击不该发请求");
	findButton(node, "确认移出").props.onClick();
	await new Promise((resolve) => setImmediate(resolve));
	const call = instance.calls.find((row) => row.path.endsWith("/release"));
	assert.deepEqual(call.body, { group_id: "group-attached", member_id: "m1" });
});
await suite.check("恢复：POST /restore", async () => {
	const { instance, props } = makeInstance();
	const node = await page(instance, props);
	instance.calls.length = 0;
	findButton(node, "恢复").props.onClick();
	await new Promise((resolve) => setImmediate(resolve));
	const call = instance.calls.find((row) => row.path.endsWith("/restore"));
	assert.deepEqual(call.body, { group_id: "group-attached", member_id: "m0" });
});
await suite.check("改名：输入框改完 POST /group-rename", async () => {
	const { instance, props } = makeInstance();
	let node = await page(instance, props);
	const input = findInputs(node)[0];
	assert.equal(input.props.value, "群聊 · 已挂", "输入框初值是群名");
	input.props.onChange({ target: { value: "前端小组" } });
	node = instance.render(instance.seats.get("main"), props);
	instance.calls.length = 0;
	findButtons(node, "改名")[0].props.onClick();
	await new Promise((resolve) => setImmediate(resolve));
	const call = instance.calls.find((row) => row.path.endsWith("/group-rename"));
	assert.deepEqual(call.body, { group_id: "group-attached", name: "前端小组" });
});
await suite.check("解散两步确认后 POST /group-dissolve", async () => {
	const { instance, props } = makeInstance();
	let node = await page(instance, props);
	instance.calls.length = 0;
	findButtons(node, "解散群聊")[0].props.onClick();
	node = instance.render(instance.seats.get("main"), props);
	assert.equal(instance.calls.length, 0, "第一次点击不该发请求");
	findButton(node, "确认解散").props.onClick();
	await new Promise((resolve) => setImmediate(resolve));
	const call = instance.calls.find((row) => row.path.endsWith("/group-dissolve"));
	assert.deepEqual(call.body, { group_id: "group-attached" });
});

console.log("groups page: 错误与空态")
await suite.check("宿主返回 ok:false 时渲染错误行（不被刷新清掉）", async () => {
	const { instance, props, canned } = makeInstance();
	canned["/api/dsh-agent-panel/pull"] = { ok: false, error: "群主 agent 没有 provider/model" };
	const node = await page(instance, props);
	findButtons(node, "拉入本群")[0].props.onClick();
	await new Promise((resolve) => setImmediate(resolve));
	const after = instance.render(instance.seats.get("main"), props);
	assert.ok(texts(after).indexOf("没有 provider/model") >= 0, "应显示宿主错误：" + texts(after));
});
await suite.check("没有群聊时给出空态提示", async () => {
	const { instance, props, canned } = makeInstance();
	canned["/api/dsh-agent-panel/state"] = { default_group_preset: "standard", presets: PRESETS, groups: [] };
	const node = await page(instance, props);
	assert.ok(texts(node).indexOf("还没有群聊") >= 0, texts(node));
});
await suite.check("客户端没有 workspaces 服务时，宿主归属仍可用（不需要它）", async () => {
	const canned = {
		"/api/dsh-agent-panel/state": JSON.parse(JSON.stringify(STATE)),
		"/api/dsh-agent-panel/group-attach": { ok: true, workspace_id: "ws-1", workspace_title: "项目A", already: false }
	};
	const instance = loadClient({ canned, services: {} });
	const props = { useWorkspaces: (selector) => selector({ items: WORKSPACES }) };
	const node = await page(instance, props);
	findButton(node, "挂到侧边栏").props.onClick();
	await new Promise((resolve) => setImmediate(resolve));
	const after = instance.render(instance.seats.get("main"), props);
	assert.ok(texts(after).indexOf("项目A") >= 0, "归属走宿主路由，客户端没有 workspaces 服务也应成功：" + texts(after));
});
await suite.check("客户端没有 workspaces 服务、宿主又说不是工作区时：如实提示", async () => {
	const canned = {
		"/api/dsh-agent-panel/state": JSON.parse(JSON.stringify(STATE)),
		"/api/dsh-agent-panel/group-attach": { ok: false, error: "该目录还不是工作区（先在 GUI 里把它加为工作区）" }
	};
	const instance = loadClient({ canned, services: {} });
	const props = { useWorkspaces: (selector) => selector({ items: WORKSPACES }) };
	const node = await page(instance, props);
	findButton(node, "挂到侧边栏").props.onClick();
	await new Promise((resolve) => setImmediate(resolve));
	const after = instance.render(instance.seats.get("main"), props);
	assert.ok(texts(after).indexOf("workspaces 服务不可用") >= 0, texts(after));
});
await suite.check("拿不到 useWorkspaces 时也能渲染（降级成空工作区列表）", async () => {
	const { instance } = makeInstance();
	const node = await page(instance, {});
	assert.ok(findInputs(node).some((input) => input.props.value === "群聊 · 已挂"));
	const selects = findSelects(node);
	assert.ok(selects.length > 0, "仍要有选择器");
});

suite.finish();
