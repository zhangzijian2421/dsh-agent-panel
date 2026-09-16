# @zijians-bow-is-long/dsh-agent-panel

给 DeepSeek Harness Web GUI 用的**群聊面板**：在 GUI 里建一个独立群聊、把已安装的 agent preset 拉成群的常驻成员，并在 `@` 菜单里按成员名引用它们。

> **v2 架构：群聊在 session 之上。** 一个群 = 一个由本插件创建的**独立群主会话**，成员 = 它的具名常驻子代理，频道 = 群主会话自己的记录。
> 不再往你的工作区里撒 `.agent-group/` 目录，也不再自建 roster.json / chat.log / 群工具 / 墓碑。

---

## 快速开始

安装（profile 里已有这一行时跳过）：

```bash
dsh plugin --profile web add @zijians-bow-is-long/dsh-agent-panel
# 或手动：把包放进 ~/.dsh/profiles/web/node_modules/，并加入 package.json 的 dsh.profile.bundles
```

使用：

1. 点会话右上角（或**空会话** composer 上方）的「👥 群聊」按钮打开面板。
2. 面板里选「创建群聊」的 preset（默认 `standard`，**它决定全群成员的能力上限**），点「创建群聊」。
   插件会创建一个独立会话 `group-<uuid>`，预设名写进会话标题（会话列表里就叫「群聊 · 1」）。
3. 在「拉进本群」列表里点任意 preset 的「拉入本群」：该 preset 的 persona 成为成员人格，
   成员挂到群主会话下（`maxDepth=1`），群内名字自动去重（重名退避 `-2` / `-3`）。
4. 点「打开群聊会话」进群说话：群主就是那个会话的 agent，成员用原生 `send_message` 向它汇报，
   这些消息**原生落在群主会话的记录里**——频道不需要插件自己造。
5. 成员 chip 上的「移出」（两步确认）= 原生释放子代理 + 名册软删除；「解散群聊」= 释放全部成员 + 归档群主会话。

---

## 架构

```
group-<uuid>            ← 群主会话（root 会话，preset 建群时指定，默认 standard）
   ├── 成员 A           ← 续存型子代理：label = 群内名字，persona = 被拉 preset 的 persona
   ├── 成员 B              toolFilter = 成员黑名单，maxDepth = 1
   └── …

频道 = 群主会话自己的会话记录（成员 send_message → 父会话，原生 inbox 消息）
名册/状态 = 原生子代理目录（subagents.listChildren：running / idle / inactive）
唤醒/转达 = 群主 agent 自带的 send_message
唯一自建状态 = ~/.dsh/dsh-agent-panel/groups.json（哪些会话是群、群名、群主 preset、成员当初用哪个 preset 拉的）
```

三段代码：

| 文件 | 职责 |
| --- | --- |
| `lib/store.js` | 注册表：纯函数 + 原子文件读写（坏文件降级成空注册表，永不抛） |
| `lib/group.js` | 群聊服务：建群 / 拉人 / 移除 / 恢复 / 解散 / 状态；persona 提取、黑名单降级 |
| `lib/index.js` | 插件外壳：8 条 loopback 路由 + 2 个模型工具 + `@` 菜单过滤 |
| `lib/mention.js` | `@` 候选过滤（隐藏"别的会话的子代理"），与群模型无关 |
| `lib/client.js` | 浏览器半边：触发器（会话头部 + 空会话 dock）、面板 UI、`@` 源 |

---

## HTTP API（仅 loopback）

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/dsh-agent-panel/state` | 群聊列表 + 成员 + preset 列表 + 服务可用性 |
| POST | `/api/dsh-agent-panel/group-create` | 建群：`{session_id?｜cwd?, preset_id?, name?}` |
| POST | `/api/dsh-agent-panel/group-rename` | 改名：`{group_id, name}`（同时写会话标题） |
| POST | `/api/dsh-agent-panel/group-dissolve` | 解散：`{group_id}` |
| POST | `/api/dsh-agent-panel/pull` | 拉人：`{group_id, preset_id, name?}` |
| POST | `/api/dsh-agent-panel/release` | 移出：`{group_id, member_id}` |
| POST | `/api/dsh-agent-panel/restore` | 恢复显示：`{group_id, member_id}` |
| GET | `/api/dsh-agent-panel/members?sessionId=` | 某会话自己的常驻成员（`@` 菜单用） |

模型工具：`group_pull`（不带 `preset_id` 时返回群状态）、`group_create`。两者都在成员黑名单里——只有群主与宿主能用。

---

## v1 → v2 删掉了什么，为什么

| v1 机制 | v2 |
| --- | --- |
| `<cwd>/.agent-group/groups/<owner>/{roster.json,chat.log}` + legacy 目录布局 | 群主会话 id + 原生子代理目录；注册表在 `~/.dsh/` |
| 自己写的频道（`chat.log`、`seq` 序号、系统消息） | 群主会话自己的记录 |
| 根作用域注册的 `group_send/group_read/group_members` + 每次调用反推群目录的 caller 守卫 | 原生 `send_message`（成员→群主）+ 群主自带的唤醒能力 |
| "群目录存在 = 是群"的探测法（曾三度因信号不可靠而重写） | 显式注册表：哪些会话是群是记下来的，不是猜的 |
| 群预设 `agent/pre-step` 自动写空名册 | 不需要：建群就是一次显式 API 调用 |
| `~/.dsh/dsh-agent-panel-retired.json` 墓碑 + 内存态 | 注册表里的 `removedAt` 软删除 |
| 运行时包装 `sessionReferenceResolver.listCandidates`（与群模型无关） | 保留（独立模块 `lib/mention.js`） |

---

## 已知边界（都是 DSH 的语义，不是插件缺陷）

- **成员之间不能直接互发消息**：`subagents.sendMessage` 的权威是"相邻父子"，兄弟会话之间没有通道；
  成员只能向群主汇报，由群主转达。
- **成员能力面 = 群主的 preset**：子 agent 通过 `agentPresets.composeFrom(childCtx, parent.ctx)` 加入父会话的
  preset。**"每个成员跑自己的 preset 工具面"在本版本不可实现**（四条路都实测封死，见
  [`docs/group-above-session.md`](docs/group-above-session.md) §7）。所以群主请用 `standard` / `cordis`；
  面板对 `minimal` 群主会显式告警（否则成员只有 `pwsh`）。角色差异用 persona + 成员黑名单表达。
- **沙箱继承**：delegation 的沙箱取父会话的显式覆盖，审批固定 `never`——群主会话在 `workspace-write` 下时，
  成员也在 `workspace-write` 下，需要审批的操作会被自动拒绝。
- **原生子代理没有删除原语**：「移出」= 释放（`drainContinuableChildren`）+ 名册软删除；DSH 的持久记录
  仍在（可冷恢复），面板用「已移除」区区分。群主不在线时只能标记名册。
- **成员名单包含"群主自己拉的人"**：群主用原生 subagent 工具拉进来的子代理也会显示（标 `群主拉的`），
  否则面板会"少人"。
- **空会话的按钮**：DSH 的会话头部在空白态整块不渲染，所以空白会话用一个只在 blank 时出现的 dock 触发器顶上。

---

## 测试

不需要测试框架，纯 node：

```bash
node test/store.test.mjs          # 注册表：坏文件降级、成员软删除、原子写
node test/group-service.test.mjs  # 建群/拉人/状态/移除/解散（桩 ctx 走全流程）
node test/plugin-mount.test.mjs   # 插件外壳：路由/工具注册、loopback 围栏、坏 JSON 体
node test/client-panel.test.mjs   # 客户端面板：RPC 路径与字段名、两步确认、错误渲染（VM + 桩 React）
node test/mention-codec.test.mjs  # mention 编码与 shipped codec 逐字节兼容
node test/mention-filter.test.mjs # @ 过滤语义：保留自己的树、丢弃他人的、失败降级
node test/blank-trigger.test.mjs  # 空会话触发器：两个席位、blank 门控、不重复渲染
```

---

## 开发工具

```bash
node tools/read-session.mjs <会话存储目录或 .zstd 文件> [--tools] [--all]
```

DSH 的会话日志是**多帧 zstd** 的 JSONL（Node 的一次性解压只读第一帧），这个脚本按 zstd magic 逐帧解压，
并把 `request/header` 里的工具面打出来——排查"成员到底拿到了哪些工具"时非常有用。

```bash
node tools/verify-group.mjs [--keep] [--cwd <dir>] [--preset <id>]
```

对着本机 GUI 的 HTTP 面跑一遍**端到端实机验证**：建群 → 拉人 → 读状态（成员与状态）→ 移出 → 解散。
先探测 `/state` 是否已是 v2，未重启时会直接说明并退出，不会动任何东西；`--keep` 保留验证群以便在 GUI 里手看。

---

```
lib/
  index.js      插件外壳（路由 + 模型工具 + @ 过滤安装）
  group.js      群聊服务（建群/拉人/移除/解散/状态）
  store.js      群聊注册表（纯函数 + 文件层）
  mention.js    @ 候选过滤
  client.js     浏览器半边
test/           6 个纯 node 测试
docs/
  group-above-session.md   可行性分析：为什么是"独立群主会话"、官方 team 包调研、多 preset 结论
  class-diagrams.md        v1 的类图与实例图（历史参考）
```
