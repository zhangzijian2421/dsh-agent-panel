window.__ModuleLoader__.load({
	id: "@zijians-bow-is-long/dsh-agent-panel",
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
			groupCreate: (args) => rpc("/api/dsh-agent-panel/group-create", "POST", args),
			groupRename: (args) => rpc("/api/dsh-agent-panel/group-rename", "POST", args),
			groupDissolve: (args) => rpc("/api/dsh-agent-panel/group-dissolve", "POST", args),
			pull: (args) => rpc("/api/dsh-agent-panel/pull", "POST", args),
			release: (args) => rpc("/api/dsh-agent-panel/release", "POST", args),
			restore: (args) => rpc("/api/dsh-agent-panel/restore", "POST", args),
			members: (sessionId) => rpc("/api/dsh-agent-panel/members?sessionId=" + encodeURIComponent(sessionId), "GET")
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
			'.agrp-pop{position:fixed;top:58px;right:16px;width:470px;max-width:calc(100vw - 32px);max-height:74vh;overflow:auto;pointer-events:auto;z-index:60;',
			'background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);',
			'border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:0 14px 40px rgba(0,0,0,.30);',
			'font-size:13px;line-height:1.45;padding:10px 12px;display:flex;flex-direction:column;gap:12px;}',
			'.agrp-dockrow{display:flex;justify-content:flex-end;align-items:center;padding:0 2px 2px;}',
			'.agrp-head{display:flex;align-items:center;justify-content:space-between;gap:8px;}',
			'.agrp-title{font-weight:600;}',
			'.agrp-sect{display:flex;flex-direction:column;gap:6px;}',
			'.agrp-sect>h4{margin:0;font-size:11px;font-weight:600;letter-spacing:.06em;color:var(--dsw-alias-label-secondary);}',
			'.agrp-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}',
			'.agrp-btn{cursor:pointer;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);',
			'background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);padding:4px 10px;font-size:12px;font-family:inherit;}',
			'.agrp-btn:hover:enabled{border-color:var(--dsw-alias-brand-primary);}',
			'.agrp-btn:disabled{opacity:.5;cursor:default;}',
			'.agrp-btn-primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);font-weight:600;}',
			'.agrp-btn-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);}',
			'.agrp-input,.agrp-select{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;',
			'background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:4px 8px;font-size:12px;font-family:inherit;}',
			'.agrp-input{flex:1 1 120px;min-width:0;}',
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
			'.agrp-err{color:var(--dsw-alias-state-error-primary);font-size:12px;white-space:pre-wrap;}',
			'.agrp-warn{color:var(--dsw-alias-state-warning-primary);font-size:12px;white-space:pre-wrap;}',
			'.agrp-note{color:var(--dsw-alias-state-success-primary);font-size:12px;white-space:pre-wrap;}',
			'.agrp-page{display:flex;flex-direction:column;gap:12px;padding:16px 18px;box-sizing:border-box;height:100%;overflow:auto;font-size:13px;line-height:1.5;}',
			'.agrp-card{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);}',
			'.agrp-card-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
			'.agrp-icon{display:inline-flex;align-items:center;justify-content:center;line-height:1;}',
			'.agrp-muted{color:var(--dsw-alias-label-secondary);font-size:12px;}'
		].join("");
		//#endregion
		//#region src/client/panel.js
		let open = false;
		let currentSessionId = "";
		let sessionsService = null;
		/** 客户端侧服务：把群会话挂进工作区（= 出现在左侧工作区下面）、打开会话、选目录。 */
		let workspaceService = null;
		let uiWorkspaceService = null;
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
			if (text.length === 0) return "";
			const at = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
			return at >= 0 ? text.slice(at + 1) : text;
		}
		function shortId(id) {
			const text = String(id);
			return text.length > 18 ? text.slice(0, 14) + "..." : text;
		}
		/** 路径比较：Windows 大小写与分隔符都不敏感，末尾分隔符忽略。 */
		function samePath(left, right) {
			const normalize = (value) => String(value).replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
			return normalize(left) === normalize(right);
		}
		/** 工作区列表（`useWorkspaces` 标准 props）；拿不到就返回空数组。 */
		function workspaceItemsOf(props) {
			const hook = props && props.useWorkspaces;
			if (typeof hook !== "function") return [];
			try {
				const snapshot = hook((value) => (value === undefined || value === null ? [] : value.items || []));
				return Array.isArray(snapshot) ? snapshot : [];
			} catch (error) { return []; }
		}
		/**
		 * 把群会话挂到它所在目录的工作区——**这是群聊出现在左侧"工作区下面"的唯一条件**：
		 * 工作区持有自己的 `sessionIds`，没挂进去的会话不会出现在那棵树里。
		 * 目录还不是工作区时顺手创建一个（否则那个群在侧边栏里永远看不见）。
		 */
		async function attachToWorkspace(sessionId, cwd, items) {
			if (sessionId.length === 0) return "（会话 id 缺失，未挂到侧边栏）";
			const service = workspaceService;
			if (service === undefined || service === null || typeof service.insertSessionBefore !== "function") {
				return "（workspaces 服务不可用，未挂到侧边栏）";
			}
			const hit = (items || []).find((item) => item && samePath(item.path, cwd));
			try {
				if (hit !== undefined) {
					if (Array.isArray(hit.sessionIds) && hit.sessionIds.indexOf(sessionId) >= 0) return "已在侧边栏工作区「" + String(hit.title) + "」下";
					await service.insertSessionBefore(hit.workspaceId, sessionId);
					return "已挂到侧边栏工作区「" + String(hit.title) + "」下";
				}
				if (typeof service.create !== "function") return "（该目录不是工作区，且无法自动创建）";
				const created = await service.create({ path: cwd });
				await service.insertSessionBefore(created.workspaceId, sessionId);
				return "已新建工作区并挂到侧边栏：" + (baseName(cwd) || String(cwd));
			} catch (error) {
				return "（挂到侧边栏失败：" + String((error && error.message) || error) + "）";
			}
		}
		/** 打开一个会话：优先走工作区 UI 服务（与侧边栏同一条路），退回 sessions 服务。 */
		function openSessionById(sessionId) {
			if (uiWorkspaceService !== undefined && uiWorkspaceService !== null && typeof uiWorkspaceService.openSession === "function") {
				uiWorkspaceService.openSession(sessionId);
				return;
			}
			if (sessionsService !== undefined && sessionsService !== null && typeof sessionsService.open === "function") sessionsService.open(sessionId);
		}
		/** 侧边栏全局面板图标（`sidebar.panellist` 的 owner props：size / active）。 */
		function GroupsRailIcon(props) {
			const size = props && typeof props.size === "number" ? props.size : 16;
			return React.createElement("span", {
				className: "agrp-icon",
				style: { fontSize: String(size) + "px", opacity: props && props.active ? "1" : "0.75" }
			}, "\u{1F465}");
		}
		/** The pill itself; every seat (header, blank-session dock) shares this one button. */
		function TriggerButton() {
			const isOpen = useOpen();
			return React.createElement("button", {
				className: "agrp-trigger" + (isOpen ? " agrp-trigger-on" : ""),
				title: "群聊 · 建群、拉 agent 进群",
				onClick: () => setOpen(!isOpen)
			}, "\u{1F465} 群聊");
		}
		function claimSession(props) {
			const id = props && props.sessionId;
			if (typeof id === "string" && id.length > 0) currentSessionId = id;
		}
		/** Seat for a started session: the header's utility row, top-right. */
		function HeaderTrigger(props) {
			claimSession(props);
			return React.createElement(TriggerButton, null);
		}
		/**
		 * Seat for a BLANK session. The shipped `ConversationSessionHeader` hides its whole
		 * subtree while `session.blank && phase === "blank"`, so
		 * `conversation.session.header.utilities` does not render at all in a brand-new
		 * session — nothing can seat there yet. The composer stack renders
		 * `conversation.input.dock` in both states, so a copy lives there and yields to the
		 * header trigger the moment the session stops being blank (no double button).
		 */
		function DockTrigger(props) {
			const useSession = props && props.useSession;
			const ownerBlank = props && props.session && typeof props.session.blank === "boolean" ? props.session.blank === true : undefined;
			// Called whenever the slot offers it, so hook order stays stable per seat.
			const hookBlank = typeof useSession === "function"
				? useSession((value) => (value === undefined ? undefined : value.blank === true))
				: undefined;
			const blank = hookBlank === undefined ? ownerBlank === true : hookBlank === true;
			claimSession(props);
			if (!blank) return null;
			return React.createElement("div", { className: "agrp-dockrow" }, React.createElement(TriggerButton, null));
		}
		function PopPanel(props) {
			const isOpen = useOpen();
			const workspaceItems = workspaceItemsOf(props);
			const [snap, setSnap] = React.useState(null);
			const [selId, setSelId] = React.useState("");
			const [busy, setBusy] = React.useState("");
			const [err, setErr] = React.useState("");
			const [note, setNote] = React.useState("");
			const [confirmId, setConfirmId] = React.useState("");
			const [confirmDissolve, setConfirmDissolve] = React.useState(false);
			const [renameDraft, setRenameDraft] = React.useState("");
			const [newPreset, setNewPreset] = React.useState("");
			// `clearError` 只在"用户主动刷新/首次打开"时为 true：操作后的自动刷新必须保留
			// 刚产生的业务错误，否则 ok:false 一闪就没了，用户什么都看不到。
			const refresh = (clearError) => {
				api.state().then(
					(value) => { setSnap(value); if (clearError === true) setErr(""); },
					(error) => { setErr(String((error && error.message) || error)); }
				);
			};
			React.useEffect(() => {
				if (isOpen) { setNote(""); setErr(""); setConfirmId(""); setConfirmDissolve(false); refresh(); }
			}, [isOpen]);
			const groups = (snap && snap.groups) || [];
			const presets = (snap && snap.presets) || [];
			const defaultPreset = (snap && snap.default_group_preset) || "standard";
			const index = groups.length === 0 ? -1 : Math.max(0, groups.findIndex((item) => item.id === selId));
			const group = index < 0 ? undefined : groups[index];
			const groupId = group === undefined ? "" : String(group.id);
			const groupName = group === undefined ? "" : String(group.name);
			// 钩子必须排在 `return null` 之前：面板关闭时组件仍在挂载状态，
			// 早退会让开/关两次渲染的钩子数量不同，React 会直接报错。
			React.useEffect(() => {
				if (group === undefined) return;
				setRenameDraft(String(group.name));
			}, [groupId, groupName]);
			if (!isOpen) return null;
			const presetName = (id) => {
				const hit = presets.find((item) => item.id === id);
				return hit === undefined ? String(id) : String(hit.name);
			};
			const finish = (result, fallbackName) => {
				if (result && result.ok === false) { setErr(String(result.error || "操作失败")); return; }
				if (result && result.warning) { setErr(String(result.warning)); }
				else if (result && result.capability_warning) { setErr(String(result.capability_warning)); }
				else setNote(fallbackName);
			};
			const run = (key, promise, done) => {
				setBusy(key); setErr(""); setNote(""); setConfirmId(""); setConfirmDissolve(false);
				promise.then(
					(result) => Promise.resolve()
						.then(() => done(result))
						.then(
							() => { setBusy(""); refresh(); },
							(error) => { setErr(String((error && error.message) || error)); setBusy(""); refresh(); }
						),
					(error) => { setErr(String((error && error.message) || error)); setBusy(""); }
				);
			};
			const onCreate = () => {
				run("create", api.groupCreate({ session_id: currentSessionId, preset_id: newPreset || defaultPreset }), async (result) => {
					if (result && result.ok === false) { setErr(String(result.error)); return; }
					const id = String((result && result.id) || "");
					setSelId(id);
					// 建完立刻挂到该目录的工作区，这样它会出现在左侧工作区下面。
					const attached = await attachToWorkspace(id, String((result && result.cwd) || ""), workspaceItems);
					setNote("已创建群聊：" + String((result && result.name) || "") + "。" + attached);
				});
			};
			const onRename = () => {
				if (group === undefined) return;
				run("rename", api.groupRename({ group_id: group.id, name: renameDraft }), (result) => {
					finish(result, "群名已改为：" + renameDraft);
				});
			};
			const onDissolve = () => {
				if (group === undefined) return;
				run("dissolve:" + group.id, api.groupDissolve({ group_id: group.id }), (result) => {
					setSelId("");
					finish(result, "已解散：" + String(group.name));
				});
			};
			const onPull = (presetId) => {
				if (group === undefined) return;
				run(presetId, api.pull({ group_id: group.id, preset_id: presetId }), (result) => {
					if (result && result.ok === false) { setErr(String(result.error)); return; }
					setNote("已拉入：" + String((result && result.name) || presetId)
						+ (result && result.capability ? "\n" + String(result.capability) : ""));
				});
			};
			const onRelease = (member) => {
				if (group === undefined) return;
				run("release:" + member.id, api.release({ group_id: group.id, member_id: member.id }), (result) => {
					if (result && result.ok === false) { setErr(String(result.error)); return; }
					setNote("已移出：" + String((result && result.name) || member.name) + (result && result.note ? "。" + String(result.note) : ""));
				});
			};
			const onRestore = (member) => {
				if (group === undefined) return;
				run("restore:" + member.id, api.restore({ group_id: group.id, member_id: member.id }), (result) => {
					finish(result, "已恢复显示：" + String(member.name));
				});
			};
			const head = React.createElement("div", { className: "agrp-head", key: "head" },
				React.createElement("div", { className: "agrp-title" },
					"群聊",
					React.createElement("span", { className: "agrp-muted", style: { marginLeft: "8px", fontWeight: "400" } },
						group === undefined ? "还没有群聊" : String(group.name) + " · " + group.members.length + " 名成员")),
				React.createElement("div", { className: "agrp-row" },
					React.createElement("button", { className: "agrp-btn", onClick: () => refresh(true), key: "r" }, "刷新"),
					React.createElement("button", { className: "agrp-btn", onClick: () => setOpen(false), key: "c" }, "收起"))
			);
			const body = [];
			if (snap === null) {
				body.push(React.createElement("div", { className: "agrp-muted", key: "loading" }, "加载中..."));
			} else {
				body.push(React.createElement("div", { className: "agrp-sect", key: "pick" },
					React.createElement("h4", null, "群聊（每个群是一个独立会话）"),
					groups.length === 0
						? React.createElement("div", { className: "agrp-muted" }, "还没有群聊。点下面的「创建群聊」新建一个独立群聊会话，再往里拉 agent。")
						: React.createElement("div", { className: "agrp-row" },
							groups.map((item) => React.createElement("button", {
								key: String(item.id),
								className: "agrp-btn" + (item.id === (group === undefined ? "" : group.id) ? " agrp-btn-primary" : ""),
								title: String(item.cwd) + " · " + String(item.id),
								onClick: () => { setSelId(String(item.id)); setConfirmId(""); setConfirmDissolve(false); }
							}, String(item.name) + "（" + item.members.length + "）"))
						),
					React.createElement("div", { className: "agrp-row" },
						React.createElement("select", {
							className: "agrp-select",
							value: newPreset || defaultPreset,
							onChange: (event) => setNewPreset(event.target.value)
						}, presets.map((preset) => React.createElement("option", { key: String(preset.id), value: String(preset.id) },
							String(preset.name) + "（" + String(preset.id) + "）"))),
						React.createElement("button", {
							className: "agrp-btn agrp-btn-primary",
							disabled: busy !== "",
							onClick: onCreate
						}, busy === "create" ? "创建中..." : "创建群聊"),
						React.createElement("span", { className: "agrp-muted" }, "群主 preset 决定全群成员的能力上限")
					)
				));
				if (group !== undefined) {
					body.push(React.createElement("div", { className: "agrp-sect", key: "owner" },
						React.createElement("h4", null, "当前群"),
						React.createElement("div", { className: "agrp-row" },
							React.createElement("input", {
								className: "agrp-input",
								value: renameDraft,
								onChange: (event) => setRenameDraft(event.target.value)
							}),
							React.createElement("button", { className: "agrp-btn", disabled: busy !== "" || renameDraft.trim().length === 0, onClick: onRename }, "改名")
						),
						React.createElement("div", { className: "agrp-muted" },
							"群主会话 " + shortId(group.id) + " · " + (group.cwd ? baseName(group.cwd) : "工作目录未知")
							+ " · " + (group.owner_live ? "在线" : "未启动（拉人会自动启动）")
							+ " · preset " + String(group.preset_id) + "（" + presetName(group.preset_id) + "）"
							+ (group.owner_model ? " · 模型 " + String(group.owner_model) : "")),
						group.capability_warning
							? React.createElement("div", { className: "agrp-warn" }, String(group.capability_warning))
							: null,
						React.createElement("div", { className: "agrp-row" },
							sessionsService ? React.createElement("button", {
								className: "agrp-btn",
								onClick: () => sessionsService.open(group.id)
							}, "打开群聊会话") : null,
							React.createElement("button", {
								className: "agrp-btn" + (confirmDissolve ? " agrp-btn-danger" : ""),
								disabled: busy !== "",
								onClick: () => { if (confirmDissolve) onDissolve(); else setConfirmDissolve(true); }
							}, busy === "dissolve:" + group.id ? "解散中..." : (confirmDissolve ? "确认解散" : "解散群聊"))
						)
					));
					body.push(React.createElement("div", { className: "agrp-sect", key: "members" },
						React.createElement("h4", null, "成员（" + group.members.length + "）"),
						group.members.length === 0
							? React.createElement("div", { className: "agrp-muted" }, "还没有成员，从下面拉一个进来。")
							: React.createElement("div", { className: "agrp-row" },
								group.members.map((member) => React.createElement("span", { className: "agrp-chip", key: String(member.id), title: String(member.id) },
									React.createElement("span", null, String(member.name)),
									React.createElement("span", { className: "agrp-muted" },
										"[" + String(member.status) + (member.registered ? "" : " · 群主拉的") + "]"),
									React.createElement("button", {
										className: "agrp-x" + (confirmId === member.id ? " agrp-x-confirm" : ""),
										disabled: busy !== "",
										title: confirmId === member.id
											? "再次点击确认：释放该子代理（DSH 原生没有删除原语，记录会保留，可冷恢复）"
											: "移出并释放该子代理",
										onClick: () => { if (confirmId === member.id) onRelease(member); else setConfirmId(String(member.id)); }
									}, confirmId === member.id ? "确认移出" : "移出")
								))
							)
					));
					const removed = group.removed || [];
					if (removed.length > 0) {
						body.push(React.createElement("div", { className: "agrp-sect", key: "removed" },
							React.createElement("h4", null, "已移除（" + removed.length + "）"),
							React.createElement("div", { className: "agrp-row" },
								removed.map((member) => React.createElement("span", { className: "agrp-chip agrp-chip-off", key: String(member.id), title: String(member.id) },
									React.createElement("span", null, String(member.name)),
									React.createElement("span", { className: "agrp-muted" }, "[已移除]"),
									React.createElement("button", {
										className: "agrp-x",
										disabled: busy !== "",
										title: "恢复显示（不会让已释放的子代理重新驻留）",
										onClick: () => onRestore(member)
									}, "恢复")
								))
							)
						));
					}
					body.push(React.createElement("div", { className: "agrp-sect", key: "presets" },
						React.createElement("h4", null, "拉进本群（已安装 preset）"),
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
									disabled: busy !== "",
									onClick: () => onPull(preset.id)
								}, busy === preset.id ? "拉取中..." : "拉入本群")
							))
					));
				}
			}
			if (err) body.push(React.createElement("div", { className: "agrp-err", key: "err" }, err));
			if (note) body.push(React.createElement("div", { className: "agrp-note", key: "note" }, note));
			return React.createElement("div", { className: "agrp-pop" }, head, body);
		}
		//#endregion
		/**
		 * 「群聊」主面板（`sidebar.panellist` 的入口点开后进这里）。
		 *
		 * 它承担三件事：**建群（选工作区目录）**、**把群挂到工作区**（这是群聊出现在左侧
		 * "工作区下面"的唯一条件——工作区持有自己的 sessionIds），以及群的全部管理
		 * （拉人 / 移出 / 恢复 / 改名 / 打开 / 解散）。
		 */
		//#region src/client/groups-page.js
		function GroupsPage(props) {
			const [snap, setSnap] = React.useState(null);
			const [busy, setBusy] = React.useState("");
			const [err, setErr] = React.useState("");
			const [note, setNote] = React.useState("");
			const [confirmMember, setConfirmMember] = React.useState("");
			const [confirmDissolve, setConfirmDissolve] = React.useState("");
			const [newCwd, setNewCwd] = React.useState("");
			const [newPreset, setNewPreset] = React.useState("");
			const [renameDraft, setRenameDraft] = React.useState({});
			const [picker, setPicker] = React.useState({});
			const workspaceItems = workspaceItemsOf(props);
			const refresh = (clearError) => {
				api.state().then(
					(value) => { setSnap(value); if (clearError === true) setErr(""); },
					(error) => { setErr(String((error && error.message) || error)); }
				);
			};
			React.useEffect(() => { refresh(); }, []);
			const groups = (snap && snap.groups) || [];
			const presets = (snap && snap.presets) || [];
			const defaultPreset = (snap && snap.default_group_preset) || "standard";
			const presetName = (id) => {
				const hit = presets.find((item) => item.id === id);
				return hit === undefined ? String(id) : String(hit.name);
			};
			const attachedTo = (id) => workspaceItems.find((item) => item && Array.isArray(item.sessionIds) && item.sessionIds.indexOf(id) >= 0);
			const run = (key, promise, done) => {
				setBusy(key); setErr(""); setNote(""); setConfirmMember(""); setConfirmDissolve("");
				promise.then(
					(result) => Promise.resolve()
						.then(() => done(result))
						.then(
							() => { setBusy(""); refresh(); },
							(error) => { setErr(String((error && error.message) || error)); setBusy(""); refresh(); }
						),
					(error) => { setErr(String((error && error.message) || error)); setBusy(""); }
				);
			};
			const onCreate = () => {
				const cwd = newCwd.length > 0 ? newCwd : (workspaceItems.length > 0 ? String(workspaceItems[0].path) : "");
				if (cwd.length === 0) { setErr("请先选择工作区目录（或点「选择目录」）"); return; }
				run("create", api.groupCreate({ cwd, preset_id: newPreset || defaultPreset }), async (result) => {
					if (result && result.ok === false) { setErr(String(result.error)); return; }
					const info = await attachToWorkspace(String((result && result.id) || ""), String((result && result.cwd) || cwd), workspaceItems);
					setNote("已创建群聊：" + String((result && result.name) || "") + "。" + info);
				});
			};
			const onPickDirectory = () => {
				if (uiWorkspaceService === undefined || uiWorkspaceService === null || typeof uiWorkspaceService.pickDirectory !== "function") {
					setErr("当前环境没有目录选择器");
					return;
				}
				uiWorkspaceService.pickDirectory().then(
					(picked) => { if (typeof picked === "string" && picked.length > 0) setNewCwd(picked); },
					(error) => setErr(String((error && error.message) || error))
				);
			};
			const onAttach = (group) => {
				setBusy("attach:" + group.id); setErr(""); setNote("");
				attachToWorkspace(String(group.id), String(group.cwd || ""), workspaceItems).then(
					(info) => { setBusy(""); setNote(String(group.name) + "：" + info); },
					(error) => { setBusy(""); setErr(String((error && error.message) || error)); }
				);
			};
			const onPull = (group, presetId) => {
				run("pull:" + group.id + ":" + presetId, api.pull({ group_id: group.id, preset_id: presetId }), (result) => {
					if (result && result.ok === false) { setErr(String(result.error)); return; }
					setNote("已拉入：" + String((result && result.name) || presetId)
						+ (result && result.capability ? "\n" + String(result.capability) : ""));
				});
			};
			const onRelease = (group, member) => {
				run("release:" + member.id, api.release({ group_id: group.id, member_id: member.id }), (result) => {
					if (result && result.ok === false) { setErr(String(result.error)); return; }
					setNote("已移出：" + String((result && result.name) || member.name) + (result && result.note ? "。" + String(result.note) : ""));
				});
			};
			const onRestore = (group, member) => {
				run("restore:" + member.id, api.restore({ group_id: group.id, member_id: member.id }), (result) => {
					if (result && result.ok === false) { setErr(String(result.error)); return; }
					setNote("已恢复显示：" + String(member.name));
				});
			};
			const onRename = (group) => {
				const name = renameDraft[group.id];
				if (typeof name !== "string" || name.trim().length === 0) return;
				run("rename:" + group.id, api.groupRename({ group_id: group.id, name }), (result) => {
					if (result && result.ok === false) { setErr(String(result.error)); return; }
					setNote("群名已改为：" + name);
				});
			};
			const onDissolve = (group) => {
				run("dissolve:" + group.id, api.groupDissolve({ group_id: group.id }), (result) => {
					if (result && result.ok === false) { setErr(String(result.error)); return; }
					setNote("已解散：" + String(group.name));
				});
			};

			const rows = [];
			rows.push(React.createElement("div", { className: "agrp-row", key: "head" },
				React.createElement("h2", null, "\u{1F465} 群聊"),
				React.createElement("span", { className: "agrp-muted" }, groups.length + " 个群"),
				React.createElement("span", { style: { flex: "1" } }),
				React.createElement("button", { className: "agrp-btn", onClick: () => refresh(true) }, "刷新")
			));
			rows.push(React.createElement("div", { className: "agrp-card", key: "create" },
				React.createElement("div", { className: "agrp-card-head" },
					React.createElement("strong", null, "创建群聊"),
					React.createElement("span", { className: "agrp-muted" }, "群主 preset 决定全群成员的能力上限；工作目录决定大家在哪个项目里干活")
				),
				React.createElement("div", { className: "agrp-row" },
					React.createElement("select", {
						className: "agrp-select",
						value: newCwd.length > 0 ? newCwd : (workspaceItems.length > 0 ? String(workspaceItems[0].path) : ""),
						onChange: (event) => setNewCwd(event.target.value)
					}, workspaceItems.length === 0
						? React.createElement("option", { value: "" }, "（没有工作区，点「选择目录」）")
						: workspaceItems.map((item) => React.createElement("option", { key: String(item.workspaceId), value: String(item.path) },
							String(item.title) + " — " + String(item.path)))),
					React.createElement("button", { className: "agrp-btn", onClick: onPickDirectory }, "选择目录"),
					React.createElement("select", {
						className: "agrp-select",
						value: newPreset || defaultPreset,
						onChange: (event) => setNewPreset(event.target.value)
					}, presets.map((preset) => React.createElement("option", { key: String(preset.id), value: String(preset.id) },
						String(preset.name) + "（" + String(preset.id) + "）"))),
					React.createElement("button", {
						className: "agrp-btn agrp-btn-primary",
						disabled: busy !== "",
						onClick: onCreate
					}, busy === "create" ? "创建中..." : "创建群聊")
				)
			));
			if (snap === null) {
				rows.push(React.createElement("div", { className: "agrp-muted", key: "loading" }, "加载中..."));
			} else if (groups.length === 0) {
				rows.push(React.createElement("div", { className: "agrp-muted", key: "empty" }, "还没有群聊。选一个工作区目录与群主 preset，点「创建群聊」。"));
			} else {
				for (const group of groups) {
					const attached = attachedTo(String(group.id));
					const picked = picker[group.id] || defaultPreset;
					const memberChips = [];
					for (const member of group.members) {
						memberChips.push(React.createElement("span", { className: "agrp-chip", key: String(member.id), title: String(member.id) },
							React.createElement("span", null, String(member.name)),
							React.createElement("span", { className: "agrp-muted" }, "[" + String(member.status) + (member.registered ? "" : " · 群主拉的") + "]"),
							React.createElement("button", {
								className: "agrp-x" + (confirmMember === member.id ? " agrp-x-confirm" : ""),
								disabled: busy !== "",
								title: confirmMember === member.id ? "再次点击确认：释放该子代理" : "移出并释放该子代理",
								onClick: () => { if (confirmMember === member.id) onRelease(group, member); else setConfirmMember(String(member.id)); }
							}, confirmMember === member.id ? "确认移出" : "移出")
						));
					}
					for (const member of group.removed || []) {
						memberChips.push(React.createElement("span", { className: "agrp-chip agrp-chip-off", key: "r-" + String(member.id), title: String(member.id) },
							React.createElement("span", null, String(member.name)),
							React.createElement("span", { className: "agrp-muted" }, "[已移除]"),
							React.createElement("button", { className: "agrp-x", disabled: busy !== "", onClick: () => onRestore(group, member) }, "恢复")
						));
					}
					rows.push(React.createElement("div", { className: "agrp-card", key: String(group.id) },
						React.createElement("div", { className: "agrp-card-head" },
							React.createElement("input", {
								className: "agrp-input",
								style: { maxWidth: "220px" },
								value: renameDraft[group.id] === undefined ? String(group.name) : renameDraft[group.id],
								onChange: (event) => setRenameDraft(Object.assign({}, renameDraft, { [group.id]: event.target.value }))
							}),
							React.createElement("button", {
								className: "agrp-btn",
								disabled: busy !== "" || String(renameDraft[group.id] === undefined ? group.name : renameDraft[group.id]).trim().length === 0,
								onClick: () => onRename(group)
							}, "改名"),
							React.createElement("button", {
								className: "agrp-btn agrp-btn-primary",
								onClick: () => openSessionById(String(group.id))
							}, "打开群聊会话"),
							attached === undefined
								? React.createElement("button", {
									className: "agrp-btn",
									disabled: busy !== "",
									title: "把群会话挂进这个目录的工作区，它就会出现在左侧工作区下面",
									onClick: () => onAttach(group)
								}, busy === "attach:" + group.id ? "挂载中..." : "挂到侧边栏")
								: React.createElement("span", { className: "agrp-muted" }, "侧边栏：已在「" + String(attached.title) + "」下"),
							React.createElement("span", { style: { flex: "1" } }),
							React.createElement("button", {
								className: "agrp-btn" + (confirmDissolve === group.id ? " agrp-btn-danger" : ""),
								disabled: busy !== "",
								onClick: () => { if (confirmDissolve === group.id) onDissolve(group); else setConfirmDissolve(String(group.id)); }
							}, busy === "dissolve:" + group.id ? "解散中..." : (confirmDissolve === group.id ? "确认解散" : "解散群聊"))
						),
						React.createElement("div", { className: "agrp-muted" },
							String(group.cwd || "（未记录工作目录）")
							+ " · 群主 preset " + String(group.preset_id) + "（" + presetName(group.preset_id) + "）"
							+ (group.owner_model ? " · 模型 " + String(group.owner_model) : " · 模型未知")
							+ " · " + (group.owner_live ? "在线" : "未启动（拉人会自动启动）")
							+ " · " + String(group.id)),
						group.capability_warning
							? React.createElement("div", { className: "agrp-warn" }, String(group.capability_warning))
							: null,
						React.createElement("div", { className: "agrp-row" },
							React.createElement("span", { className: "agrp-muted" }, "成员（" + group.members.length + "）："),
							memberChips.length === 0 ? React.createElement("span", { className: "agrp-muted" }, "还没有成员") : memberChips
						),
						React.createElement("div", { className: "agrp-row" },
							React.createElement("select", {
								className: "agrp-select",
								value: picked,
								onChange: (event) => setPicker(Object.assign({}, picker, { [group.id]: event.target.value }))
							}, presets.map((preset) => React.createElement("option", { key: String(preset.id), value: String(preset.id) },
								String(preset.name) + "（" + String(preset.id) + "）"))),
							React.createElement("button", {
								className: "agrp-btn agrp-btn-primary",
								disabled: busy !== "",
								onClick: () => onPull(group, picked)
							}, busy === "pull:" + group.id + ":" + picked ? "拉取中..." : "拉入本群")
						)
					));
				}
			}
			if (err) rows.push(React.createElement("div", { className: "agrp-err", key: "err" }, err));
			if (note) rows.push(React.createElement("div", { className: "agrp-note", key: "note" }, note));
			return React.createElement("div", { className: "agrp-page" }, rows);
		}
		//#endregion
		//#region src/client/index.js
		const inject = ["slots", "inputTriggers"];
		/** Client plugin body: own the stylesheet and seat the triggers + the group panel. */
		function apply(ctx) {
			sessionsService = ctx.get("sessions") || null;
			// 客户端侧服务：把群会话挂进工作区（= 出现在左侧工作区下面）、打开会话、选目录。
			workspaceService = ctx.get("workspaces") || null;
			uiWorkspaceService = ctx.get("uiWorkspace") || null;
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
			// Blank-session seat: the header above does not exist until the session starts.
			ctx.slots.inject("conversation.input.dock", () => ctx.slots.register(
				{ name: "conversation.input.dock", id: "agent-group-panel-blank", order: -5 },
				DockTrigger
			));
			ctx.slots.inject("shell.overlay", () => ctx.slots.register(
				{ name: "shell.overlay", id: "agent-group-panel" },
				PopPanel
			));
			// 侧边栏入口 + 对应主面板：list 槽位的 id 就是 main 的 key，
			// 侧边栏自己渲染按钮并从注册元数据里取名（所以 label 必须给）。
			ctx.slots.inject("sidebar.panellist", () => ctx.slots.register(
				{ name: "sidebar.panellist", id: "agent-groups", order: 30, label: () => "群聊" },
				GroupsRailIcon
			));
			ctx.slots.inject("main", () => ctx.slots.register(
				{ name: "main", key: "agent-groups" },
				GroupsPage
			));
			// A second `@` source: this session's own resident members, labeled by agent name
			// rather than by session title. Sources on one trigger concatenate in order, so -10
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
							try { payload = await api.members(sessionId); } catch (error) { return []; }
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
