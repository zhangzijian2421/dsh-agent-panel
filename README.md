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

1. **新建一个空会话**，点 composer 上方的「＋ 创建群聊」（旁边可选群主 preset）——这个空会话就**变成**群聊。
   也可以先点「👥 群聊」打开面板再在面板里建。
2. 群主 preset 默认 `standard`，**它决定全群成员的能力上限**；建群会改会话标题为 `👥 <群名>`
   （侧边栏里区别于普通会话）。群会话仍然像普通会话一样工作，只是多了成员。
3. 在「拉进本群」列表里点任意 preset 的「拉入本群」：该 preset 的 persona 成为成员人格，
   成员挂到群主会话下（`maxDepth=1`），群内名字自动去重（重名退避 `-2` / `-3`）。
   拉人会先跑一轮**入群握手**（见「已知边界」），就位后再派活。
4. 直接在群会话里说话就是群聊：群主就是这个会话的 agent，成员的收尾消息**原生落在群主会话的记录里**
   （工具面里有 `send_message` 时成员也能主动提前汇报）——频道不需要插件自己造。
5. 成员 chip 上的「移出」（两步确认）= 原生释放子代理 + 名册软删除；「解散群聊」= 释放全部成员 + 归档群主会话。

---

## 入口与位置（v2.2：空会话即群聊入口）

- **新建一个空会话（＋ 新会话）**，空会话的 composer 上方会出现两个东西：
  `👥 群聊`（打开拉人面板）和 **`＋ 创建群聊`**（旁边可选群主 preset）。
- 点 **`＋ 创建群聊`**：这个空会话就变成群聊——群主 preset 切到所选值（原生空白会话切预设）、
  标题改为 `👥 群聊 · N`（在侧边栏里区别于普通会话）、注册进群聊面板，然后面板自动打开让你拉人。
- 群会话**本来就在工作区下面**（它就是一个普通会话），不需要任何"归属/挂载"操作；
  与普通会话的区别靠标题的 👥 前缀和面板里的群标记。
- 拉人：面板 → 选 preset → 「拉入本群」；移出/恢复/改名/解散都在面板里。
- 会话一旦开始就不能再改群主 preset（DSH 语义：空白会话才能切预设）。

---## 架构

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
| `lib/group.js` | 群聊服务：建群 / 拉人 / 移除 / 恢复 / 解散 / 状态；persona 提取、黑名单降级 || `lib/index.js` | 插件外壳：8 条 loopback 路由 + 2 个模型工具 + `@` 菜单过滤 |
| `lib/mention.js` | `@` 候选过滤（隐藏"别的会话的子代理"），与群模型无关 |
| `lib/client.js` | 浏览器半边：触发器（会话头部 + 空会话 dock）、面板 UI、`@` 源 |

把群主会话启动起来有**两条路**：首选 GUI 自己的 `sessionController.ensureSession`
（adopt 在线 / resume 冷会话 / create 新会话，并把 preset 写进会话头）；但 `sessionController`
不在 cordis 的公开 catalog 里，所以缺席时自动兜底到 catalog 内的原语
`agents.create` / `agents.resume` + `agentPresets.mount` + `agentOptions`——也就是 api-session-controller
内部 `composeAgent()` 的同一条路。两条路都有单测覆盖。

**实机验证的结论**：静态插件里 `sessionController.ensureSession` **不可用**（`createGroup` 回报的
`started_via` 是 `agents.create`），所以这条兜底其实是**主路径**；而最早的版本漏了 `agentOptions`，
导致建出来的群主 agent 没有 provider/model（症状：群主报 `{{model}}` 无值、成员报
`no provider/model`）——现在建群时会检查并如实失败。

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

- **拉人必然先跑一轮"入群握手"**：`subagents.startContinuable` 要求带一条初始 prompt 且投递即开轮
  （`delivery: 'queue'`），DSH 没有"只建档不跑"的创建原语。所以这一轮被钉死成一次**明确无任务**的握手
  （`memberWelcome`：不调研、不读文件、不调工具，只回一行就位确认）。**别在这一轮派活**——实机教训：旧文案
  写的是"收到群主派活后先动手"，成员读不出"这轮没活"，把入群当任务自发跑了 15 步 / 21 次 `bash` 并交了
  一份 52 行报告，收尾消息又原生唤醒了群主，群主跟着烧了一整轮。
  想派活就**在它就位之后再发一条带任务的消息**（那是第二轮，工具面也更完整）。
- **第一轮的工具面可能比后续窄**：某些 preset（如 `liangshen`）用 `anchorTools` 把**首个用户轮**的 wire
  收敛到 4 个工具（`bash`/`str_replace_editor`/`exit_plan_mode`/`skill`），第二轮起才恢复完整工具面
  （`ptcPresentation`）。这也是"成员在第一轮里找不到 `send_message`"的原因，不是子代理被禁。
- **归档 ≠ 删除，而且"live 的会话删不掉"**（实机踩过："群聊归档删除后删不掉，子 agent 会话也没删"）。
  设置里的会话归档/删除来自第三方插件 `@linxin666/dsh-session-archive`，它的删除有三条硬规则：
  1. 删除是**整族级联**的：以会话头的 `parentSession` 为边，选父会话会带上全部后代；
  2. 但**进程内仍然 live 的会话受保护**（原因 `attached`：会话仍被 DSH 进程占用），
     正在跑的是 `running`，你当前正在看的是 `current`；
  3. 族里只要有受保护成员，**整族跳过**（`family-protected`）；而且父会话自身受保护时，
     它的后代**根本不会被算进删除目标**——这就是"群聊删不掉、成员会话也留着"的直接原因。
  DSH 本身把打开的会话长期留在内存里（GUI 的启动路径 `(await agents.resume(...)).agent` 当场丢掉句柄，
  整轮进程冷不下来），所以正确顺序是：
  **面板里「解散群聊」（释放全部成员，并尽力把群主 agent 也下线）→ 需要就重启一次 DSH →
  在「设置 → 会话归档」里勾选该会话族删除**。销毁后不要再打开那个群会话，否则它又会 live。
  解散的返回值里有 `owner_released` / `owner_live` / `delete_hint`：句柄不在插件手里（GUI 自己 resume
  的会话）时会如实告诉你"还需重启"。
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
- **群主会话必须有 provider/model**：它来自 `agent-default-model` 设置（兜底启动路径会显式带上，
  与 GUI 自己的 `sessionController.agentOptions()` 同源）。缺失时群主会报 `{{model}}` 无值、成员会报
  `no provider/model`——所以建群会**当场失败并归档半成品会话**，而不是留下一个跑不动的群；
  面板的「当前群」行也会显示群主模型，`state` 里是 `owner_model`。- **v1 遗留物不再被读取**：工作区里的 `.agent-group/` 群目录已经没人在读（可以随手删）；
  `agent-chat-group` 群预设（含它的 `agent/pre-step` 自动初始化钩子）在 v2 里不再需要，
  但**没有替你卸载**——用该预设建的旧会话仍能正常 resume。想清理可在设置/插件管理里自行移除。
- **`@` 菜单过滤保留**：`lib/mention.js` 与群模型无关（它只是把"别的会话的子代理"从 `@` 候选里过滤掉），
  属于独立增强，v2 保留。

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
node test/host-e2e.test.mjs       # 宿主链路端到端：真实路由 + 桩宿主，建群→拉人→状态→移除→解散
node test/verify-script.test.mjs # 实机验证脚本的版本判定（v1/v2 与坏载荷不误判）
```

---

## 开发工具

```bash
node tools/read-session.mjs <会话存储目录或 .zstd 文件> [--tools] [--all]
```

DSH 的会话日志是**多帧 zstd** 的 JSONL（Node 的一次性解压只读第一帧），这个脚本按 zstd magic 逐帧解压，
并把 `request/header` 里的工具面打出来——排查"成员到底拿到了哪些工具"时非常有用。

```bash
node tools/dump-lineage.mjs
```

把 `~/.dsh/sessions` 下**每一个会话存储**的头信息读出来，列出所有 `origin=subagent` 的子代理会话
（含它的 `parent` 与 preset）以及每个父会话。排查"这个群到底拉过谁""删群之后哪些子会话还在磁盘上"
（配合上面的归档/删除语义）时一条命令就够。

```bash
node tools/verify-group.mjs [--keep] [--cwd <dir>] [--preset <id>]
```

对着本机 GUI 的 HTTP 面跑一遍**端到端实机验证**：建群 → 拉人 → 读状态（成员与状态）→ 移出 → 解散。
先探测 `/state` 是否已是 v2，未重启时会直接说明并退出，不会动任何东西；`--keep` 保留验证群以便在 GUI 里手看。

---

## 实机验证记录（2026-09-17）

在真实宿主上跑 `node tools/verify-group.mjs --keep` 与手工取会话日志确认：

| 项目 | 结果 |
| --- | --- |
| 宿主形状 | `/state` 带 `default_group_preset`；caps 全 true |
| 建群 | `group-<uuid>` 建出，群名写进会话标题（会话日志 `session/title`），`started_via=agents.create`、`owner_model=deepseek-official/deepseek-flash` |
| 拉人 | 成员 `parentSession=群主`、`delegationDepth=1`、`agentPreset=standard`；黑名单五个名字**在 standard 工具域中都存在**，不触发降级 |
| **成员工具面** | **32 个工具**：`read/write/edit/grep/glob/pwsh/send_message/skill/subagent/...` 全在，`group_pull/group_create/list_agents/interrupt_agent/ask_user_question` 全不在（对照 v1 那个只有 12 个工具、42 次调用里 40 次 pwsh 的残废成员） |
| 成员真的在跑 | 成员 `request/header` + `assistant/message` + `tool/call`（`pwsh`/`glob`）齐备 |
| 频道原生 | 群主会话记录里直接出现成员的原生通知与收尾消息（`agent/inbox/spliced` → `user/message`） |
| 群主能力面 | 37 个工具 = standard 平面 + `group_pull`/`group_create`（成员被黑名单挡住，群主/宿主可用） |
| 移出 / 解散 | `release` 释放子代理；`group-dissolve` `drained`+`archived=true`，注册表清零 |

---

## 回滚

v2 是一次不兼容重写（群聊从"会话的一个属性"变成"独立会话"）。要退回 v1：

```bash
git -C <本包目录> checkout 75d52bc      # v1.5.1（空会话拉人修复版）
# 或退回 v2 之前：git checkout 5972082^
```

然后重启 DSH + 硬刷新页面。**回滚不需要清任何东西**：v2 的注册表在
`~/.dsh/dsh-agent-panel/groups.json`，v1 完全不读它；v1 的 workspace 群目录 v2 也不读——
两代状态互不干扰。想彻底清干净，删掉 `~/.dsh/dsh-agent-panel/` 与工作区里的 `.agent-group/` 即可。

---

## 目录结构

```
lib/
  index.js      插件外壳（路由 + 模型工具 + @ 过滤安装）
  group.js      群聊服务（建群/拉人/移除/解散/状态）
  store.js      群聊注册表（纯函数 + 文件层）
  mention.js    @ 候选过滤
  client.js     浏览器半边
test/           9 个纯 node 测试
tools/          read-session.mjs（会话日志解码）、verify-group.mjs（端到端实机验证）
docs/
  group-above-session.md   可行性分析：为什么是"独立群主会话"、官方 team 包调研、多 preset 结论
  class-diagrams.md        v1 的类图与实例图（历史参考）
```
