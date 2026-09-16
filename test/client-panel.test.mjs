/**
 * 客户端面板逻辑测试：用桩 React + 桩 fetch 在 VM 里跑**真实的客户端包**，
 * 断言面板与宿主之间的接线（RPC 路径、请求字段名、两步确认、错误渲染）。
 *
 * 为什么值得单独测：这些字段名（group_id / preset_id / session_id / member_id）一旦写错，
 * 面板只会静默失败，而实机验证要重启 DSH 才能做一次——这里能在毫秒级跑完每一次交互。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "lib", "client.js"), "utf8");

const results = [];
function check(label, fn) {
	return Promise.resolve()
		.then(fn)
		.then(() => { results.push({ label, ok: true }); console.log("  ok   " + label); })
		.catch((error) => { results.push({ label, ok: false }); console.log("  FAIL " + label + " → " + String((error && error.message) || error)); });
}
function assertThat(condition, message) {
	if (!condition) throw new Error(message === undefined ? "assertion failed" : message);
}

/** 极简 React：useState/useEffect 按组件函数持续保存槽位，重复 render 即可看到状态推进。 */
function makeReact() {
	const stateSlots = new Map();
	const effectSlots = new Map();
	let current = null;
	let index = 0;
	const React = {
		createElement(type, props, ...children) {
			return { type, props: props === null || props === undefined ? {} : props, children };
		},
		useState(initial) {
			const key = current;
			const at = index++;
			const slots = stateSlots.get(key) || [];
			if (!(at in slots)) slots[at] = typeof initial === "function" ? initial() : initial;
			stateSlots.set(key, slots);
			return [slots[at], (next) => { slots[at] = typeof next === "function" ? next(slots[at]) : next; }];
		},
		useEffect(callback, deps) {
			const key = current;
			const at = index++;
			const slots = effectSlots.get(key) || [];
			const previous = slots[at];
			const changed = previous === undefined || deps === undefined || previous.deps === undefined
				|| deps.some((value, position) => value !== previous.deps[position]);
			if (!changed) return;
			if (previous !== undefined && typeof previous.cleanup === "function") previous.cleanup();
			slots[at] = { deps, cleanup: callback() };
			effectSlots.set(key, slots);
		},
		useMemo(factory) { return factory(); },
		useRef(value) { return { current: value }; }
	};
	return {
		React,
		render(component, props) {
			current = component;
			index = 0;
			return component(props);
		}
	};
}

const CANNED = {
	"/api/dsh-agent-panel/state": {
		default_group_preset: "standard",
		presets: [
			{ id: "standard", name: "标准模式", description: "完整编码 agent", trust: "system" },
			{ id: "se", name: "SE 需求分析", description: "只做需求分析", trust: "user" }
		],
		groups: [{
			id: "group-1",
			name: "群聊 · 1",
			cwd: "D:\\work",
			preset_id: "minimal",
			owner_live: true,
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

/** 载入真实客户端包，返回座位表 + fetch 记录 + 渲染器 + 模块级 open 开关。 */
function load() {
	const calls = [];
	const fetch = (path, options) => {
		const method = options === undefined || options.method === undefined ? "GET" : options.method;
		let body;
		try { body = options && options.body === undefined ? undefined : JSON.parse(options.body); } catch (error) { body = options && options.body; }
		calls.push({ path, method, body });
		const payload = CANNED[path.split("?")[0]];
		return Promise.resolve({
			ok: true,
			status: 200,
			json: () => Promise.resolve(payload === undefined ? { ok: false, error: "no canned response for " + path } : payload)
		});
	};
	const seats = new Map();
	let last = null;
	const ctx = {
		get: (name) => (name === "sessions" ? { open: () => {} } : undefined),
		effect(callback) { callback(); },
		slots: {
			inject(name, callback) { callback(); seats.set(name, last); return () => {}; },
			register(_registration, component) { last = component; return () => {}; }
		}
	};
	const sandbox = {
		console,
		TextEncoder,
		btoa: (value) => Buffer.from(value, "binary").toString("base64"),
		fetch,
		document: { createElement: () => ({ remove() {} }), head: { appendChild() {} } },
		window: { __ModuleLoader__: { load: (definition) => { sandbox.__definition = definition; } } }
	};
	vm.createContext(sandbox);
	new vm.Script(source, { filename: "client.js" }).runInContext(sandbox);
	const react = makeReact();
	const moduleExports = sandbox.__definition.factory((id) => {
		if (id === "react") return react.React;
		throw new Error("unexpected require: " + id);
	});
	moduleExports.apply(ctx);
	return { seats, calls, render: react.render };
}

/** 深度遍历元素树；数组子节点必须展平（真实 React 渲染时也会展平）。 */
function walk(node, visit) {
	if (node === null || node === undefined) return;
	if (Array.isArray(node)) {
		for (const item of node) walk(item, visit);
		return;
	}
	if (typeof node !== "object") return;
	visit(node);
	for (const child of node.children || []) walk(child, visit);
}
function texts(node) {
	const out = [];
	walk(node, (element) => {
		for (const child of element.children || []) if (typeof child === "string") out.push(child);
	});
	return out.join(" | ");
}
function findButton(node, label) {
	let hit;
	walk(node, (element) => {
		if (hit !== undefined) return;
		if (element.type !== "button") return;
		const text = (element.children || []).map((child) => (typeof child === "string" ? child : "")).join("");
		if (text.indexOf(label) >= 0) hit = element;
	});
	return hit;
}
function findButtons(node, label) {
	const out = [];
	walk(node, (element) => {
		if (element.type !== "button") return;
		const text = (element.children || []).map((child) => (typeof child === "string" ? child : "")).join("");
		if (text.indexOf(label) >= 0) out.push(element);
	});
	return out;
}
/** 面板打开：点一次触发器即可（模块级 open 开关）。 */
function openPanel(seats, render) {
	const trigger = render(seats.get("conversation.session.header.utilities"), { sessionId: "session-me" });
	// 触发器返回的是 <TriggerButton/>，按钮本身要调用组件函数才拿得到。
	const button = trigger.type();
	button.props.onClick();
}

/**
 * 打开面板并等到状态就绪。顺序很重要：面板必须**先渲染一次**，`refresh` 的 effect 才会跑起来，
 * 之后等一个 microtask 让 fetch 落地，再渲染才看得到数据。
 */
async function openWithData(instance) {
	openPanel(instance.seats, instance.render);
	instance.render(instance.seats.get("shell.overlay"), {});
	await new Promise((resolve) => setImmediate(resolve));
	return instance.render(instance.seats.get("shell.overlay"), {});
}

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
});

console.log("client panel: 交互")
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
await check("没有群聊时提示先建群，并给出创建入口 + preset 选择", async () => {
	CANNED["/api/dsh-agent-panel/state"] = { default_group_preset: "standard", presets: CANNED["/api/dsh-agent-panel/state"].presets, groups: [] };
	const third = load();
	const node = await openWithData(third);
	const text = texts(node);
	assertThat(text.includes("还没有群聊"), "应提示没有群聊：" + text);
	assertThat(findButton(node, "创建群聊") !== undefined, "缺创建群聊按钮");
	let select;
	walk(node, (element) => { if (element.type === "select") select = element; });
	assertThat(select !== undefined, "缺群主 preset 选择器");
	assert.equal(select.props.value, "standard", "默认应选中 default_group_preset");
	third.calls.length = 0;
	findButton(node, "创建群聊").props.onClick();
	await new Promise((resolve) => setImmediate(resolve));
	const call = third.calls.find((row) => row.path.endsWith("/group-create"));
	assertThat(call !== undefined, "没有发出 group-create 请求");
	assert.deepEqual(call.body, { session_id: "session-me", preset_id: "standard" });
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

const failed = results.filter((row) => !row.ok);
console.log("");
console.log(failed.length === 0 ? "ALL PASS (" + results.length + ")" : failed.length + " FAILED of " + results.length);
process.exit(failed.length === 0 ? 0 : 1);
