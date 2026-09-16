/**
 * Decode one DSH session store (`session.v3.jsonl.zstd`, a concatenation of zstd
 * frames — Node's one-shot decompressor only reads the first frame, so split on the
 * zstd magic and decode each frame).
 *
 * Usage: node tools/read-session.mjs <session-store-dir-or-file> [--tools] [--persona] [--all]
 */
import { readFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import { statSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

export function decodeSessionLog(target) {
	let file = target;
	const info = statSync(target);
	if (info.isDirectory()) {
		const nested = readdirSync(target).map((name) => join(target, name)).find((p) => p.endsWith(".zstd"));
		if (nested === undefined) throw new Error("no .zstd store under " + target);
		file = nested;
	}
	const buf = readFileSync(file);
	const starts = [];
	for (let i = 0; i + 3 < buf.length; i += 1) {
		if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i);
	}
	if (starts.length === 0) throw new Error("no zstd frame found in " + file);
	let text = "";
	for (let i = 0; i < starts.length; i += 1) {
		const end = i + 1 < starts.length ? starts[i + 1] : buf.length;
		text += zstdDecompressSync(buf.subarray(starts[i], end)).toString("utf8");
	}
	return text.split("\n").filter((line) => line.length > 0).map((line) => {
		try { return JSON.parse(line); } catch (error) { return { type: "<parse-fail>", raw: line.slice(0, 200) }; }
	});
}

function toolListOf(event) {
	const tools = event?.data?.header?.tools;
	return Array.isArray(tools) ? tools.map((tool) => tool.name) : undefined;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
	const target = process.argv[2];
	const flags = new Set(process.argv.slice(3));
	const events = decodeSessionLog(target);
	console.log("events: " + events.length);
	for (const event of events) {
		if (event.type === "session") console.log("SESSION " + JSON.stringify(event.data === undefined ? event : event.data).slice(0, 400));
	}
	for (const event of events) {
		const tools = toolListOf(event);
		if (tools !== undefined) {
			console.log("\n=== TOOLS (" + tools.length + ") @" + event.seq);
			console.log(tools.join(", "));
		}
	}
	if (flags.has("--persona") || flags.has("--all")) {
		for (const event of events) {
			if (event.type === "subagent/descriptor") {
				const data = event.data || {};
				console.log("\n=== DESCRIPTOR mode=" + data.mode + " label=" + data.label + " preset=" + JSON.stringify(data.agentPreset));
				if (data.persona) console.log("--- persona:\n" + String(data.persona).slice(0, 3000));
				if (data.toolFilter) console.log("--- toolFilter: " + JSON.stringify(data.toolFilter));
			}
		}
	}
	if (flags.has("--all")) {
		const counts = {};
		for (const event of events) counts[event.type] = (counts[event.type] || 0) + 1;
		console.log("\n=== EVENT TYPES\n" + JSON.stringify(counts, null, 1));
		for (const event of events) {
			if (event.type === "system/message") {
				const text = JSON.stringify(event.data).slice(0, 4000);
				console.log("\n=== SYSTEM MESSAGE @" + event.seq + "\n" + text);
			}
		}
	}
}
