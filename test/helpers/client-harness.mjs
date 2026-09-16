/**
 * 客户端测试台：在 VM 里加载**真实的客户端包**（`lib/client.js`），配桩 React、桩 fetch
 * 与可注入的客户端服务，用来断言面板/页面的接线（RPC 路径、字段名、两步确认、错误渲染）。
 *
 * 两个客户端测试共用它：`client-panel.test.mjs`（会话头触发器 + 下拉面板）
 * 与 `client-groups-page.test.mjs`（侧边栏入口 + 群聊主面板）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(here, "..", "..", "lib", "client.js"), "utf8");

/** 极简 React：useState/useEffect 按组件函数持续保存槽位，重复 render 即可看到状态推进。 */
export function makeReact() {
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

/**
 * 载入真实客户端包。
 * @param options.canned 桩响应表：`{ [path]: payload }`；`{__throw: "..."}` 表示该请求抛错。
 * @param options.services 额外的客户端服务（如 `workspaces` / `uiWorkspace`），按 `ctx.get` 的名字给。
 * @returns `{ seats, injections, calls, sources, render, services }`
 */
export function loadClient(options = {}) {
	const canned = options.canned || {};
	const extra = options.services || {};
	const calls = [];
	const fetch = (path, fetchOptions) => {
		const method = fetchOptions === undefined || fetchOptions.method === undefined ? "GET" : fetchOptions.method;
		let body;
		try { body = fetchOptions && fetchOptions.body === undefined ? undefined : JSON.parse(fetchOptions.body); } catch (error) { body = fetchOptions && fetchOptions.body; }
		calls.push({ path, method, body });
		const payload = canned[path.split("?")[0]];
		if (payload !== undefined && payload.__throw !== undefined) return Promise.reject(new Error(payload.__throw));
		return Promise.resolve({
			ok: true,
			status: 200,
			json: () => Promise.resolve(payload === undefined ? { ok: false, error: "no canned response for " + path } : payload)
		});
	};
	const seats = new Map();
	const registrations = new Map();
	const injections = [];
	const sources = [];
	let last = null;
	let lastRegistration = null;
	const services = Object.assign({ sessions: { open: () => {} } }, extra);
	const ctx = {
		get: (name) => {
			if (name === "inputTriggers") return { registerSource: (source) => { sources.push(source); return () => {}; } };
			return services[name];
		},
		effect(callback) { callback(); },
		slots: {
			inject(name, callback) { injections.push({ name }); callback(); seats.set(name, last); registrations.set(name, lastRegistration); return () => {}; },
			register(registration, component) { last = component; lastRegistration = registration; return () => {}; }
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
	new vm.Script(SOURCE, { filename: "client.js" }).runInContext(sandbox);
	const react = makeReact();
	const moduleExports = sandbox.__definition.factory((id) => {
		if (id === "react") return react.React;
		throw new Error("unexpected require: " + id);
	});
	moduleExports.apply(ctx);
	return { seats, registrations, injections, calls, sources, render: react.render, services, canned };
}

/** 深度遍历元素树；数组子节点必须展平（真实 React 渲染时也会展平）。 */
export function walk(node, visit) {
	if (node === null || node === undefined) return;
	if (Array.isArray(node)) {
		for (const item of node) walk(item, visit);
		return;
	}
	if (typeof node !== "object") return;
	visit(node);
	for (const child of node.children || []) walk(child, visit);
}

/** 整棵树的文本（`"a | b | c"`）。 */
export function texts(node) {
	const out = [];
	walk(node, (element) => {
		for (const child of element.children || []) if (typeof child === "string") out.push(child);
	});
	return out.join(" | ");
}

export function findButtons(node, label) {
	const out = [];
	walk(node, (element) => {
		if (element.type !== "button") return;
		const text = (element.children || []).map((child) => (typeof child === "string" ? child : "")).join("");
		if (text.indexOf(label) >= 0) out.push(element);
	});
	return out;
}

export function findButton(node, label) {
	return findButtons(node, label)[0];
}

export function findSelects(node) {
	const out = [];
	walk(node, (element) => { if (element.type === "select") out.push(element); });
	return out;
}

export function findInputs(node) {
	const out = [];
	walk(node, (element) => { if (element.type === "input") out.push(element); });
	return out;
}

/** 打开会话头部那个下拉面板：点一次触发器即可（模块级 open 开关）。 */
export function openPanel(seats, render, sessionId) {
	const trigger = render(seats.get("conversation.session.header.utilities"), { sessionId: sessionId || "session-me" });
	// 触发器返回的是 <TriggerButton/>，按钮本身要调用组件函数才拿得到。
	trigger.type().props.onClick();
}

/**
 * 打开面板并等到状态就绪。顺序很重要：面板必须**先渲染一次**，`refresh` 的 effect 才会跑起来，
 * 之后等一个 microtask 让 fetch 落地，再渲染才看得到数据。
 */
export async function openWithData(instance, sessionId) {
	openPanel(instance.seats, instance.render, sessionId);
	instance.render(instance.seats.get("shell.overlay"), {});
	await new Promise((resolve) => setImmediate(resolve));
	return instance.render(instance.seats.get("shell.overlay"), {});
}

/** 渲染群聊主面板（`main` 槽位，key = agent-groups）。 */
export async function renderGroupsPage(instance, props) {
	const page = instance.seats.get("main");
	instance.render(page, Object.assign({}, props));
	await new Promise((resolve) => setImmediate(resolve));
	return instance.render(page, Object.assign({}, props));
}

/** 一个测试文件里的小断言记录器。 */
export function createSuite() {
	const results = [];
	return {
		async check(label, fn) {
			try {
				await fn();
				results.push({ label, ok: true });
				console.log("  ok   " + label);
			} catch (error) {
				results.push({ label, ok: false });
				console.log("  FAIL " + label + " → " + String((error && error.message) || error));
			}
		},
		finish() {
			const failed = results.filter((row) => !row.ok);
			console.log("");
			console.log(failed.length === 0 ? "ALL PASS (" + results.length + ")" : failed.length + " FAILED of " + results.length);
			process.exit(failed.length === 0 ? 0 : 1);
		}
	};
}
