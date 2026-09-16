window.__ModuleLoader__.load({
	id: "@local/dsh-agent-panel",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const React = require("react");
		//#region src/client/api.js
		/** Loopback RPC to this package's own host routes. */
		async function rpc(path, method, body) {
			const response = await fetch(path, {
				method: method || "GET",
				...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {})
			});
			let payload = null;
			try { payload = await response.json(); } catch (error) { payload = null; }
			if (!response.ok) {
				throw new Error((payload && payload.error) || path + " failed: " + response.status);
			}
			return payload;
		}
		const api = {
			state: () => rpc("/api/dsh-agent-panel/state", "GET"),
			pull: (args) => rpc("/api/dsh-agent-panel/pull", "POST", args),
			retire: (args) => rpc("/api/dsh-agent-panel/retire", "POST", args),
			restore: (args) => rpc("/api/dsh-agent-panel/restore", "POST", args),
			subagents: (sessionId) => rpc("/api/dsh-agent-panel/subagents?sessionId=" + encodeURIComponent(sessionId), "GET")
		};
		/**
		 * Canonical session-reference mention, byte-for-byte compatible with the host codec
		 * (`dsh-session:` + base64url of the JSON-encoded id, label escaping `\` and `]`).
		 * Emitting this is what makes a picked agent resolve through the shipped
		 * session-reference plumbing instead of being plain text.
		 */
		function encodeSessionMention(sessionId, label) {
			const bytes = new TextEncoder().encode(JSON.stringify(String(sessionId)));
			let binary = "";
			for (const byte of bytes) binary += String.fromCharCode(byte);
			const payload = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
			const escaped = String(label).replace(/[\\\]]/g, (match) => "\\" + match);
			return "@[" + escaped + "](dsh-session:" + payload + ")";
		}
		//#endregion
		//#region src/client/styles.js
		const CSS = [
			'.agrp-trigger{display:inline-flex;align-items:center;gap:5px;flex:0 0 auto;cursor:pointer;',
			'border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-1);',
			'color:var(--dsw-alias-label-primary);padding:3px 10px;font-size:12px;font-weight:600;font-family:inherit;white-space:nowrap;}',
			'.agrp-trigger:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}',
			'.agrp-trigger-on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2);}',
			'.agrp-pop{position:fixed;top:58px;right:16px;width:460px;max-width:calc(100vw - 32px);max-height:72vh;overflow:auto;pointer-events:auto;z-index:60;',
			'background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);',
			'border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:0 14px 40px rgba(0,0,0,.30);',
			'font-size:13px;line-height:1.45;padding:10px 12px;display:flex;flex-direction:column;gap:12px;}',
			'.agrp-head{display:flex;align-items:center;justify-content:space-between;gap:8px;}',
			'.agrp-title{font-weight:600;}',
			'.agrp-sect{display:flex;flex-direction:column;gap:6px;}',
			'.agrp-sect>h4{margin:0;font-size:11px;font-weight:600;letter-spacing:.06em;color:var(--dsw-alias-label-secondary);}',
			'.agrp-btn{cursor:pointer;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);',
			'background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);padding:4px 10px;font-size:12px;font-family:inherit;}',
			'.agrp-btn:hover:enabled{border-color:var(--dsw-alias-brand-primary);}',
			'.agrp-btn:disabled{opacity:.5;cursor:default;}',
			'.agrp-btn-primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);font-weight:600;}',
			'.agrp-btn-primary:hover:enabled{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);}',
			'.agrp-agent{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:8px;',
			'border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);}',
			'.agrp-agent-name{font-weight:600;}',
			'.agrp-agent-desc{color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:2px;}',
			'.agrp-chip{display:inline-flex;align-items:center;gap:6px;padding:2px 4px 2px 8px;border-radius:999px;',
			'border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);font-size:12px;}',
			'.agrp-chip-off{opacity:.55;border-style:dashed;}',
			'.agrp-x{cursor:pointer;border:1px solid var(--dsw-alias-border-l1);background:transparent;',
			'color:var(--dsw-alias-label-secondary);border-radius:999px;font-size:11px;padding:1px 7px;font-family:inherit;}',
			'.agrp-x:hover:enabled{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);}',
			'.agrp-x-confirm{color:var(--dsw-alias-bg-overlay);background:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);}',
			'.agrp-msg{display:flex;flex-direction:column;gap:2px;padding:6px 8px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);}',
			'.agrp-msg-head{font-size:11px;color:var(--dsw-alias-label-secondary);}',
			'.agrp-err{color:var(--dsw-alias-state-error-primary);font-size:12px;white-space:pre-wrap;}',
			'.agrp-note{color:var(--dsw-alias-state-success-primary);font-size:12px;white-space:pre-wrap;}',
			'.agrp-muted{color:var(--dsw-alias-label-secondary);font-size:12px;}'
		].join("");
		//#endregion
		//#region src/client/panel.js
		let open = false;
		let currentSessionId = "";
		let sessionsService = null;
		const watchers = new Set();
		const setOpen = (value) => {
			open = value;
			for (const watcher of watchers) { try { watcher(); } catch (error) { console.error(error); } }
		};
		function useOpen() {
			const [value, setValue] = React.useState(open);
			React.useEffect(() => {
				const watcher = () => setValue(open);
				watchers.add(watcher);
				return () => { watchers.delete(watcher); };
			}, []);
			return value;
		}
		function baseName(path) {
			const text = String(path);
			const at = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
			return at >= 0 ? text.slice(at + 1) : text;
		}
		function shortId(id) {
			const text = String(id);
			return text.length > 14 ? text.slice(0, 10) + "..." : text;
		}
		function HeaderTrigger(props) {
			const isOpen = useOpen();
			React.useEffect(() => {
				const id = props && props.sessionId;
				if (typeof id === "string" && id.length > 0) currentSessionId = id;
			});
			if (props && typeof props.sessionId === "string" && props.sessionId.length > 0) currentSessionId = props.sessionId;
			return React.createElement("button", {
				className: "agrp-trigger" + (isOpen ? " agrp-trigger-on" : ""),
				title: "多 Agent 聊天群 · 把 agent 拉进当前会话",
				onClick: () => setOpen(!isOpen)
			}, "\u{1F465} 群聊拉人");
		}
		function PopPanel() {
			const isOpen = useOpen();
			const [snap, setSnap] = React.useState(null);
			const [sel, setSel] = React.useState(0);
			const [picked, setPicked] = React.useState(false);
			const [busy, setBusy] = React.useState("");
			const [err, setErr] = React.useState("");
			const [note, setNote] = React.useState("");
			const [confirmId, setConfirmId] = React.useState("");
			const refresh = () => {
				api.state().then(
					(value) => { setSnap(value); setErr(""); },
					(error) => { setErr(String((error && error.message) || error)); }
				);
			};
			React.useEffect(() => {
				if (isOpen) { setNote(""); setErr(""); setConfirmId(""); refresh(); }
			}, [isOpen]);
			if (!isOpen) return null;
			const all = (snap && snap.groups) || [];
			const groups = all.slice().sort((a, b) => {
				const aCur = a.session_id === currentSessionId ? 0 : 1;
				const bCur = b.session_id === currentSessionId ? 0 : 1;
				if (aCur !== bCur) return aCur - bCur;
				if (aCur === 1) return String(a.cwd).localeCompare(String(b.cwd));
				return 0;
			});
			const presets = (snap && snap.presets) || [];
			const currentIdx = groups.findIndex((item) => item.session_id === currentSessionId);
			const index = groups.length === 0 ? 0 : (picked ? Math.min(sel, groups.length - 1) : (currentIdx >= 0 ? currentIdx : 0));
			const group = groups[index];
			const onPull = (presetId) => {
				if (group === undefined) return;
				setBusy(presetId); setErr(""); setNote(""); setConfirmId("");
				api.pull({ sessionId: group.session_id, cwd: group.cwd, ownerId: group.owner_id, presetId }).then(
					(result) => {
						if (result && result.ok === false) setErr(String(result.error || "拉取失败"));
						else if (result && result.warning) setErr(String(result.warning));
						else setNote("已拉入：" + String((result && result.name) || presetId));
						setBusy("");
						refresh();
					},
					(error) => { setErr(String((error && error.message) || error)); setBusy(""); }
				);
			};
			const onRetire = (member) => {
				if (group === undefined) return;
				setBusy("retire:" + member.id); setErr(""); setNote(""); setConfirmId("");
				api.retire({ sessionId: group.session_id, cwd: group.cwd, memberId: member.id }).then(
					(result) => {
						if (result && result.ok === false) setErr(String(result.error || "移出失败"));
						else setNote("已移出：" + String((result && result.name) || member.name));
						setBusy("");
						refresh();
					},
					(error) => { setErr(String((error && error.message) || error)); setBusy(""); }
				);
			};
			const onRestore = (member) => {
				if (group === undefined) return;
				setBusy("restore:" + member.id); setErr(""); setNote(""); setConfirmId("");
				api.restore({ sessionId: group.session_id, cwd: group.cwd, memberId: member.id }).then(
					(result) => {
						if (result && result.ok === false) setErr(String(result.error || "恢复失败"));
						else setNote("已恢复显示：" + String(member.name));
						setBusy("");
						refresh();
					},
					(error) => { setErr(String((error && error.message) || error)); setBusy(""); }
				);
			};
			const head = React.createElement("div", { className: "agrp-head", key: "head" },
				React.createElement("div", { className: "agrp-title" },
					"拉 Agent 进会话",
					React.createElement("span", { className: "agrp-muted", style: { marginLeft: "8px", fontWeight: "400" } },
						group === undefined ? "" : (group.has_roster ? "聊天群 · " + group.members.length + " 名成员" : "本会话 · " + group.members.length + " 个子代理"))),
				React.createElement("div", { style: { display: "flex", gap: "6px" } },
					React.createElement("button", { className: "agrp-btn", onClick: refresh, key: "r" }, "刷新"),
					React.createElement("button", { className: "agrp-btn", onClick: () => setOpen(false), key: "c" }, "收起")
				)
			);
			const body = [];
			if (snap === null) {
				body.push(React.createElement("div", { className: "agrp-muted", key: "loading" }, "加载中..."));
			} else if (groups.length === 0) {
				body.push(React.createElement("div", { className: "agrp-muted", key: "none" }, "当前没有在线会话。"));
			} else {
				if (groups.length > 1) {
					body.push(React.createElement("div", { className: "agrp-sect", key: "picks" },
						React.createElement("h4", null, "拉进哪个会话"),
						React.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: "6px" } },
							groups.map((item, i) => React.createElement("button", {
								key: String(item.session_id),
								className: "agrp-btn" + (i === index ? " agrp-btn-primary" : ""),
								onClick: () => { setSel(i); setPicked(true); setConfirmId(""); }
							}, (item.session_id === currentSessionId ? "当前 · " : "") + baseName(item.cwd) + (item.has_roster ? "（聊天群）" : "")))
						)
					));
				}
				body.push(React.createElement("div", { className: "agrp-sect", key: "owner" },
					React.createElement("h4", null, "目标会话"),
					React.createElement("div", { className: "agrp-muted" },
						baseName(group.cwd) + " (" + shortId(group.session_id) + ") " + (group.owner_live ? "· 在线，可拉人" : "· 离线，无法拉人"),
						sessionsService && group.session_id !== currentSessionId ? React.createElement("button", {
							className: "agrp-btn", style: { marginLeft: "8px" },
							onClick: () => sessionsService.open(group.session_id)
						}, "打开该会话") : null
					)
				));
				body.push(React.createElement("div", { className: "agrp-sect", key: "members" },
					React.createElement("h4", null, "已有成员（" + group.members.length + "）"),
					group.members.length === 0
						? React.createElement("div", { className: "agrp-muted" }, "还没有成员，从下面拉一个进来。")
						: React.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: "6px" } },
							group.members.map((member) => React.createElement("span", { className: "agrp-chip", key: String(member.id), title: String(member.id) },
								React.createElement("span", null, String(member.name)),
								React.createElement("span", { className: "agrp-muted" }, "[" + String(member.status) + "]"),
								React.createElement("button", {
									className: "agrp-x" + (confirmId === member.id ? " agrp-x-confirm" : ""),
									disabled: busy !== "",
									title: confirmId === member.id
										? "再次点击确认：释放该子代理（面板不再列出；DSH 原生子代理条保留历史，显式发消息可冷恢复）"
										: "移出并释放该子代理",
									onClick: () => {
										if (confirmId === member.id) onRetire(member);
										else setConfirmId(member.id);
									}
								}, confirmId === member.id ? "确认移出" : "移出")
							))
						)
				));
				const removedList = group.removed || [];
				if (removedList.length > 0) {
					body.push(React.createElement("div", { className: "agrp-sect", key: "removed" },
						React.createElement("h4", null, "已移除（" + removedList.length + "）"),
						React.createElement("div", { className: "agrp-muted" }, "已释放的子代理。DSH 原生子代理条会保留其持久记录（支持冷恢复），因此在此标记备查。"),
						React.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "4px" } },
							removedList.map((member) => React.createElement("span", { className: "agrp-chip agrp-chip-off", key: String(member.id), title: String(member.id) },
								React.createElement("span", null, String(member.name)),
								React.createElement("span", { className: "agrp-muted" }, "[已移除]"),
								React.createElement("button", {
									className: "agrp-x",
									disabled: busy !== "",
									title: "恢复显示：从已移除列表移除标记（代理本身仍为已释放状态）",
									onClick: () => onRestore(member)
								}, "恢复")
							))
						)
					));
				}
				body.push(React.createElement("div", { className: "agrp-sect", key: "presets" },
					React.createElement("h4", null, "可拉取的 Agent（已安装 preset）"),
					presets.length === 0
						? React.createElement("div", { className: "agrp-muted" }, "没有可用的 preset。")
						: presets.map((preset) => React.createElement("div", { className: "agrp-agent", key: String(preset.id) },
							React.createElement("div", { style: { minWidth: 0 } },
								React.createElement("div", { className: "agrp-agent-name" }, String(preset.name)),
								React.createElement("div", { className: "agrp-muted" }, String(preset.id) + (preset.trust ? " · " + String(preset.trust) : "")),
								preset.description ? React.createElement("div", { className: "agrp-agent-desc" }, String(preset.description)) : null
							),
							React.createElement("button", {
								className: "agrp-btn agrp-btn-primary",
								disabled: busy !== "" || !group.owner_live,
								onClick: () => onPull(preset.id)
							}, busy === preset.id ? "拉取中..." : "拉入本会话")
						))
				));
				if (group.has_roster) {
					body.push(React.createElement("div", { className: "agrp-sect", key: "chat" },
						React.createElement("h4", null, "频道（最近 " + group.messages.length + " 条）"),
						group.messages.length === 0
							? React.createElement("div", { className: "agrp-muted" }, "频道还没有消息。")
							: group.messages.map((message) => React.createElement("div", { className: "agrp-msg", key: String(message.seq) },
								React.createElement("div", { className: "agrp-msg-head" }, "#" + String(message.seq) + " " + (message.kind === "system" ? "[系统]" : String(message.speaker))),
								React.createElement("div", null, String(message.text))
							))
					));
				}
			}
			if (err) body.push(React.createElement("div", { className: "agrp-err", key: "err" }, err));
			if (note) body.push(React.createElement("div", { className: "agrp-note", key: "note" }, note));
			return React.createElement("div", { className: "agrp-pop" }, head, body);
		}
		//#endregion
		//#region src/client/index.js
		const inject = ["slots", "inputTriggers"];
		/** Client plugin body: own the stylesheet and seat the header trigger + dropdown panel. */
		function apply(ctx) {
			sessionsService = ctx.get("sessions");
			ctx.effect(() => {
				const el = document.createElement("style");
				el.textContent = CSS;
				document.head.appendChild(el);
				return () => { el.remove(); };
			}, "dsh-agent-panel: styles");
			ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register(
				{ name: "conversation.session.header.utilities", id: "agent-group-panel" },
				HeaderTrigger
			));
			ctx.slots.inject("shell.overlay", () => ctx.slots.register(
				{ name: "shell.overlay", id: "agent-group-panel" },
				PopPanel
			));
			// A second `@` source: this session's own agents, labeled by agent name rather
			// than by session title. Sources on one trigger concatenate in order, so -10
			// seats it above the shipped Sessions/Files source.
			const inputTriggers = ctx.get("inputTriggers");
			if (inputTriggers !== undefined && typeof inputTriggers.registerSource === "function") {
				ctx.effect(() => inputTriggers.registerSource({
					trigger: "@",
					name: "session-agents",
					order: -10,
					showGroupTitle: false,
					async candidates(session, req) {
						// Never rejects: the controller drops a source whose fetch rejects, and one
						// bad item shape must not be able to empty the whole menu.
						try {
							const sessionId = session && session.sessionId;
							if (sessionId === undefined) return [];
							let payload = null;
							try { payload = await api.subagents(sessionId); } catch (error) { return []; }
							const members = (payload && payload.members) || [];
							const needle = String((req && req.query) || "").toLocaleLowerCase();
							return members.filter((member) => {
								if (needle === "") return true;
								return String(member.name).toLocaleLowerCase().includes(needle) || String(member.id).toLocaleLowerCase().includes(needle);
							}).map((member) => ({
								name: String(member.name),
								description: (member.mode === "continuable" ? "常驻成员" : "一次性") + " · " + (member.status === "running" ? "运行中" : "待命"),
								icon: "session",
								section: "本会话子 agent",
								value: JSON.stringify({
									kind: "session",
									label: String(member.name),
									mention: encodeSessionMention(member.id, String(member.name))
								})
							}));
						} catch (error) {
							console.error("[dsh-agent-panel] @ session-agents candidates failed:", error);
							return [];
						}
					},
					// No `header`: that hook publishes breadcrumb ARRAYS for a drilled listing,
					// and the controller treats any non-empty return as crumbs. Omit it.
					onPick({ candidate }) {
						let value;
						try { value = JSON.parse(candidate.value); } catch (error) { return undefined; }
						if (value === undefined || value === null || value.kind !== "session") return undefined;
						return { insert: {
							source: "reference",
							ref: value.mention,
							label: value.label,
							appearance: "session",
							clipboardText: value.mention
						} };
					},
					codec: {
						clipboardText: (ref) => ref,
						serialize: (ref) => Promise.resolve(ref)
					}
				}), "dsh-agent-panel: @ session-agents source");
			}
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
