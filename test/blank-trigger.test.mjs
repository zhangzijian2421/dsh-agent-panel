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
function loadBundle() {
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
		fetch: () => Promise.reject(new Error("no network in this test")),
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
	check("renders a button", node !== null, String(node));
	check("right-aligned dock row wrapper", node !== null && node.props.className === "agrp-dockrow");
	const button = node === null ? undefined : node.children[0].type();
	check("inner component yields a real <button>", button !== undefined && button.type === "button");
	check(
		"button label is 群聊拉人",
		button !== undefined && String(button.children[0]).includes("群聊拉人"),
		button === undefined ? "no button" : JSON.stringify(button.children)
	);
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

if (failures > 0) {
	console.log("\n" + failures + " check(s) failed");
	process.exit(1);
}
console.log("\nall checks passed");
