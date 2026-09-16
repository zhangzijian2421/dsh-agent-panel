/**
 * Regression: a blank session must still offer the「群聊拉人」trigger.
 *
 * The shipped `ConversationSessionHeader` returns `!hideChrome && (...)` where
 * `hideChrome = session.blank && phase === "blank"`, so nothing seated in
 * `conversation.session.header.utilities` renders before the first turn. The composer
 * stack always renders `conversation.input.dock`, so the client half seats a second,
 * blank-only trigger there and must hide it again once the session starts.
 *
 * This test loads the real client bundle in a VM with a stubbed module loader / React,
 * captures the slot registrations `apply` performs, and calls the two trigger
 * components with both session shapes.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "lib", "client.js"), "utf8");

let failures = 0;
function check(name, condition, detail) {
	if (condition) {
		console.log("  ok   " + name);
		return;
	}
	failures += 1;
	console.log("  FAIL " + name + (detail === undefined ? "" : " → " + detail));
}

/** Minimal React stand-in: enough to call the components and inspect the tree. */
function makeReact() {
	return {
		createElement(type, props, ...children) {
			return { type, props: props === null || props === undefined ? {} : props, children };
		},
		useState(initial) {
			return [typeof initial === "function" ? initial() : initial, () => {}];
		},
		useEffect() {},
		useMemo(factory) {
			return factory();
		}
	};
}

/** Run the bundle, then run `exports.apply` against a capturing slot registry. */
function loadBundle(fetchImpl) {
	const calls = [];
	const seats = new Map();
	let last = null;
	const ctx = {
		get: () => undefined,
		effect() {},
		slots: {
			inject(name, callback) {
				callback();
				seats.set(name, last);
				return () => {};
			},
			register(_registration, component) {
				last = component;
				return () => {};
			}
		}
	};
	const sandbox = {
		console,
		TextEncoder,
		btoa: (value) => Buffer.from(value, "binary").toString("base64"),
		fetch: fetchImpl || (() => Promise.reject(new Error("no network in this test"))),
		document: { createElement: () => ({ remove() {} }), head: { appendChild() {} } },
		window: { __ModuleLoader__: { load: (definition) => { sandbox.__definition = definition; } } }
	};
	vm.createContext(sandbox);
	new vm.Script(source, { filename: "client.js" }).runInContext(sandbox);
	const definition = sandbox.__definition;
	if (definition === undefined) throw new Error("bundle did not call __ModuleLoader__.load");
	const moduleExports = definition.factory((id) => {
		if (id === "react") return makeReact();
		throw new Error("unexpected require: " + id);
	});
	moduleExports.apply(ctx);
	return seats;
}

const seats = loadBundle();

console.log("blank-session trigger seats");
check("registers conversation.session.header.utilities", seats.has("conversation.session.header.utilities"));
check("registers conversation.input.dock", seats.has("conversation.input.dock"));

const headerTrigger = seats.get("conversation.session.header.utilities");
const dockTrigger = seats.get("conversation.input.dock");

const blankProps = {
	sessionId: "session-blank",
	session: { blank: true },
	useSession: (selector) => selector({ blank: true })
};
const startedProps = {
	sessionId: "session-started",
	session: { blank: false },
	useSession: (selector) => selector({ blank: false })
};

console.log("header seat");
{
	const node = headerTrigger(blankProps);
	check(
		"still renders in a blank session (harmless: the shipped header hides it)",
		node !== null && typeof node.type === "function",
		String(node && node.type)
	);
}

console.log("dock seat — blank session (the reported bug)");
{
	const node = dockTrigger(blankProps);
	check("renders a dock row", node !== null && node.props.className === "agrp-dockrow", String(node));
	// 展平后找按钮（dock 行现在是 [pill, preset 选择, 创建按钮]）
	const flat = [];
	(function w(x) {
		if (x === null || x === undefined || typeof x !== "object") return;
		if (Array.isArray(x)) { x.forEach(w); return; }
		flat.push(x);
		(x.children || []).forEach(w);
	})(node);
	const pill = flat.find((el) => el.type === "button" && String(el.children[0]).indexOf("群聊") >= 0);
	check("still renders the 群聊 pill", pill !== undefined);
	const create = flat.find((el) => el.type === "button" && String(el.children[0]).indexOf("创建群聊") >= 0);
	check("blank 会话出现「＋ 创建群聊」按钮", create !== undefined);
	// 群主 preset 固定为「群聊 Agent」：不再有选择器（换成固定值由宿主决定）。
	check("没有群主 preset 选择器", !flat.some((el) => el.type === "select"));
}

console.log("dock seat — started session");
check("renders nothing (header trigger owns it)", dockTrigger(startedProps) === null);

console.log("dock seat — hook-sourced blank flag (owner props absent)");
{
	const node = dockTrigger({ sessionId: "s", useSession: (selector) => selector({ blank: true }) });
	check("blank via useSession renders a button", node !== null && node.props.className === "agrp-dockrow");
	const node2 = dockTrigger({ sessionId: "s", useSession: (selector) => selector({ blank: false }) });
	check("non-blank via useSession renders nothing", node2 === null);
	const node3 = dockTrigger({ sessionId: "s", useSession: (selector) => selector(undefined) });
	check("session-less seat renders nothing", node3 === null);
}

console.log("dock seat — no hook, no owner props");
check("degrades to hidden rather than double-rendering", dockTrigger({ sessionId: "s" }) === null);

console.log("dock seat — 创建群聊流程（空会话点按钮 → POST /group-create → 面板打开）");
{
	const calls = [];
	const fetchImpl = (path, options) => {
		const method = options && options.method ? options.method : "GET";
		let body;
		try { body = options && options.body ? JSON.parse(options.body) : undefined; } catch (error) { body = undefined; }
		calls.push({ path, method, body });
		const payload = path.indexOf("/group-create") >= 0
			? { ok: true, id: "session-blank-1", name: "群聊 · 1", preset_id: "group-host", title: "👥 群聊 · 1" }
			: { default_group_preset: "group-host", presets: [{ id: "group-host", name: "群聊 Agent" }, { id: "se", name: "SE 需求分析" }], groups: [] };
		return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
	};
	const seats2 = loadBundle(fetchImpl);
	const dock = seats2.get("conversation.input.dock")(blankProps);
	const flat = [];
	(function w(x) {
		if (x === null || x === undefined || typeof x !== "object") return;
		if (Array.isArray(x)) { x.forEach(w); return; }
		flat.push(x);
		(x.children || []).forEach(w);
	})(dock);
	const create = flat.find((el) => el.type === "button" && String(el.children[0]).indexOf("创建群聊") >= 0);
	check("创建群聊按钮存在（空白会话 dock 行）", create !== undefined);
	// 群主 preset 固定：不再有选择器，只在旁边写明固定值。
	check("不再提供群主 preset 选择器", !flat.some((el) => el.type === "select"));
	const overlaySeat = seats2.get("shell.overlay");
	create.props.onClick();
	await new Promise((resolve) => setImmediate(resolve));
	const call = calls.find((c) => c.path.indexOf("/group-create") >= 0);
	check("POST /group-create 只带 session_id（preset 由宿主固定）", call !== undefined && call.method === "POST" && call.body.session_id === "session-blank" && call.body.preset_id === undefined);
	// 状态落地后重渲染：dock 行会写明固定群主是谁。
	const rerendered = seats2.get("conversation.input.dock")(blankProps);
	const flat2 = [];
	(function w2(x) {
		if (x === null || x === undefined || typeof x !== "object") return;
		if (Array.isArray(x)) { x.forEach(w2); return; }
		flat2.push(x);
		(x.children || []).forEach(w2);
	})(rerendered);
	check("写明固定群主（群聊 Agent）", flat2.some((el) => typeof el.children[0] === "string" && el.children[0].indexOf("群聊 Agent") >= 0));
	const overlay = overlaySeat(overlaySeatBlankProps());
	check("建群后面板自动打开（可继续拉人）", overlay !== null);
}

function overlaySeatBlankProps() {
	return { sessionId: "session-blank-1", useSessions: (selector) => selector({ byId: { "session-blank-1": { blank: false } } }) };
}

if (failures > 0) {
	console.log("\n" + failures + " check(s) failed");
	process.exit(1);
}
console.log("\nall checks passed");
