# 把「群聊」搬到 session 之上：可行性分析

> **落地状态（已实施）**：本文结论已按**方案 A** 落地为 v2 —— 群聊 = 插件创建的独立群主会话（默认
> `standard`），成员 = 具名常驻子代理，频道 = 群主会话自身的记录，名册/状态走原生子代理目录，
> 唯一自建状态是 `~/.dsh/dsh-agent-panel/groups.json`。v1 的 workspace 群目录、roster.json/chat.log、
> 群工具、墓碑、auto-init 钩子、@ 过滤包装（后者单独保留为 `lib/mention.js`）都已删除。
> 官方 `agentTeams` 未采用（未安装 + 不支持每成员 preset + roster 不可改名/删除），§7 有完整论据。

> 结论先行：**可行，而且能把现在的复杂度砍掉一半以上**。但 DSH 有两条硬边界，决定了「群聊」**必须落在某个 Agent（会话）上**，不能是一个纯服务/纯数据对象；同时「成员之间直接互发」在没有官方 Team 层的情况下做不到。
>
> 另外有个重要发现：DSH **自己设计的正是这条路**（`agentTeams`：Lead 会话 + 具名常驻队友 + **按名字的 peer 消息** + 共享任务板 + `TeamView` + `waitForChange`），但**本部署没有安装它**。

---

## 1. 现状复杂度盘点（"太复杂"到底复杂在哪）

实测行数（不含文档）：

| 文件 | 行数 | 承担的东西 |
| --- | --- | --- |
| `dsh-agent-panel/lib/index.js` | 1212 | HTTP 路由、`roster.json`/`chat.log` 读写、群目录解析（含 legacy）、caller 运行期守卫、根作用域群工具、墓碑存储、auto-start、`@` 候选过滤包装 |
| `dsh-agent-panel/lib/client.js` | 444 | 面板 UI、`@` 源、两个触发器席位 |
| `agent-chat-group/group.mjs` | 672 | 群预设：`agent/pre-step` 自动初始化空名册、群工具、成员指引 |
| 测试（5 套 + 1 套） | 492 | mention 编解码、@ 过滤、群目录、caller 群解析、空白态触发器、auto-init |
| 合计（运行时代码） | **2328** | |

数据面（都在用户工作区/家目录里，各自一套生命周期）：

- `<cwd>/.agent-group/groups/<群主会话id>/roster.json` + `chat.log`（另有 legacy 单群布局 `<cwd>/.agent-group/`）
- `~/.dsh/dsh-agent-panel-retired.json`（移出墓碑）
- 群主会话自己的 `chat.log` 序号（`nextChatSeq`）

概念债（每一处都是一个曾经的 bug 现场）：

1. **"是群"靠探测**：群目录存在 = 是群。此前试过三套信号（`agentPresets.composedPreset`、`session.header.agentPreset`、`tools.get`）全部不可靠，最后才落到"文件存在"。
2. **多群映射**：一个工作区多个群 → 每个群一个目录，还要兼容旧布局。
3. **caller 守卫**：根作用域注册的群工具，每次调用都要按调用者会话反推群目录（主持人取自身、成员取 `parentSession`）。
4. **群预设 auto-init**：用 `agent/pre-step` 瀑布钩子后台写空名册，只为让"新建群会话→发第一条消息→直接拉人"成立。
5. **`@` 候选过滤包装**：运行时包住 shipped 的 `sessionReferenceResolver.listCandidates`，隐藏"其他会话的子代理"。
6. **成员工具黑名单降级**：从 `tools.restrict()` 的报错文本里正则解析 `known global tools:` 再重试。

---

## 2. DSH 的三条硬边界（决定了"之上"能做成什么）

### 2.1 只有 Agent 能发言

消息权威是 **Agent 之间的父子相邻关系**：

```
subagents.sendMessage(sender: Agent, targetId: SessionId, content, options): Promise<MessageId>
```

`sender` 必须是**活的 Agent**，`targetId` 必须是它的**直接子会话或直接父会话**。纯服务、纯 JSON 群对象没有"发送者"身份。

⇒ **群聊必须由一个会话（Agent）支撑**。想做"无会话的群实体"，它就没有嘴。

### 2.2 成员之间不能直接对话

兄弟会话之间没有任何通道：`sendMessage` 只认相邻父子。成员只能 `send_message` → 父（群主），由群主转达。

⇒ 除非有官方 Team 层那种 **by-name peer messaging**（见 §3.4），否则"成员互相 @" 只能经群主。

### 2.3 成员能力 ⊆ 群主会话能力

子 agent 由宿主这样组装（`dsh-subagent/lib/types/child-agent.js`）：

```js
applyChildComposition(childCtx, parent, composition) {
  childCtx.get('agentPresets')?.composeFrom(childCtx, parent.ctx);  // ← 加入父会话的 preset
  ... persona / toolFilter
}
```

沙箱与审批：`captureDelegatedPolicyOverrides(parent)` = 父会话的显式沙箱覆盖，审批**固定 `never`**。

这就解释了上一轮那个 bug：`settings.yaml` 里 `agent-presets.default: minimal`，空白会话被 auto-start 成 `minimal`（只有 `pwsh`），成员于是**一个人格是 cordis、工具面是 minimal** 的残废 agent —— 日志实测：子 agent 的工具面是 `agrp_pull, group_*, pwsh, sidebar_open, ssh_*`，跑的 42 次调用里 **40 次是 `pwsh`**（因为它没有 `read`/`write`/`edit`）。

⇒ **成员的能力面由"群"决定，不由"被拉的 preset"决定。** 想给成员完整能力，只有三条路：
- 群主会话的 preset 本身有完整能力（**推荐**，且可控）；
- 空白会话用原生 `agentPresets.select(agent, presetId)` 切 preset（会话级、整会话生效、非空白会抛 `agent-preset/locked`）——用户自己就是这样把本会话从 `minimal` 切到 `cordis` 的（实测 `header.agentPreset=minimal` / `composedPreset=cordis`）；
- `agentPresets.recompose(childCtx, id)` 给单个成员换 preset —— 官方文档明确：「**只在 agent 尚未产出任何东西时有效**，这个检查由调用方自己负责」，属于灰区，不做默认路径。

---

## 3. 方案

### 3.1 方案 A：群聊 = 独立「群主会话」（真·session 之上）★推荐

一个群 = 一个由插件创建的会话；成员 = 它的常驻子代理；**频道 = 它自己的会话记录**。

| 关注点 | 落地方式 | 依据（已实测） |
| --- | --- | --- |
| 建群 | `sessionController.ensureSession(newId, cwd, true, presetId)`：全新会话会 `mkdir(cwd)` → `composeAgent(presetId)` → `agents.create` | 读源码确认；全新 id 走 create 分支，**可指定 preset** |
| 拉成员 | `subagents.startContinuable({provider:'spawn', label, request:{prompt, parent: 群主Agent, persona, toolFilter, maxDepth:1}})` | 现有逻辑复用，只换 parent |
| 成员发言 | 原生 `send_message` → 父会话；子代理消息**原生落进群主会话记录**（`agent/inbox/spliced` → `user/message`） | 实测：父会话记录里有子代理的关闭报告与收尾消息 |
| 名册/状态 | 原生子代理列表（`list_agents` / `subagents.listChildren`，带 `running/idle/ready`） | shipped UI 已经渲染 |
| 群注册表 | `storageDomain`（`ctx.get('storage')` / `storageDomain` 均已挂载） | 活体探针：`storage: true, storageDomain: true` |
| 群主唤醒成员 | 群主 agent 原生工具（`send_message`/`list_agents`/`interrupt_agent`，`standard`/`cordis` preset 自带） | 本会话工具面实测存在 |
| 面板 | 沿用现有 UI，把"目标会话"换成"群聊" | — |

**砍掉的东西**：`chat.log` + 序号、`roster.json`、群目录与 legacy 布局、墓碑文件、`group_send/group_read/group_members` 根注册工具、caller 守卫、群探测、多群目录映射、群预设 auto-init 钩子、`@` 过滤包装。

**代价**：群聊是一个独立会话（要切进去说话，"我的会话就是群"不再成立）；成员间仍需群主转达；成员能力面 = 群主 preset（但**这次是可控的**）。

**预估体量**：host ≈ 300–400 行，client 可沿用现有 ~350 行，**不需要新 preset**（群主用 `standard`/`cordis` 即可）。

### 3.2 方案 B：保留"我的会话就是群"，只把状态与频道换成原生的（低风险收敛）

- 群状态 → `storageDomain`；频道 → **该会话自己的记录**（成员消息原生落进来），删掉 `chat.log`/`roster.json`/群工具/墓碑/auto-init/过滤包装。
- 仍需面对 §2.3：宿主是 `minimal` 时成员没工具 → 空白会话用原生 `select` 修 preset；非空白会话只能如实提示能力面。
- 破坏最小、见效快；但"群"仍是会话的一个属性，不是一个实体，多群/群身份/群生命周期仍然别扭。

### 3.3 方案 C：真·peer 群聊（成员互发、无群主）

- 需要 by-name peer messaging（官方 `agentTeams` 的形态）。
- **本部署没有**：活体探针 `ctx.get('agentTeams') === undefined`；整个 profile（含第三方 bundle）无任何实现/注册，它只作为 catalog 条目出现在 `dsh-tool-cordis` 里。
- 自己实现 = 绕开父子权威（向任意会话注入轮次），**越出公开契约**，不做。

### 3.4 附：官方 `agentTeams` 的形态（值得对齐，将来可迁移）

```
TeamMembership { root, id, role: 'lead'|'teammate', name }
spawnTeammate(caller=Lead, { name, description, prompt, context:'fresh'|'fork', provider })
sendMessage(caller, { target: <名字>, content })      ← peer message（成员互发）
listMembers(caller) → TeamMemberView[] { id, name, role, status, description, provider, model, diagnostics }
createTask / updateTask / listTasks / waitForChange(caller, timeoutMs, signal)
@Remote('view') remoteView(agent) → TeamView { members, tasks }
```

「backed by the exact live **Lead Session log**」——名册与任务板都存在 Lead 会话日志里，**没有额外文件**。也就是说：**群聊 = Lead 会话 + 它的具名常驻子代理 + 任务板**，这正是方案 A 的形态；差别只在 A 少了 peer messaging 与任务板。

⇒ 若这个包将来可用（升级/安装第三方 bundle），方案 A 可以平滑迁移：`spawnTeammate` ↔ 我们的拉人、`sendMessage(target)` ↔ 我们的转达、`TeamView` ↔ 我们的面板，我们退化成它的 UI 皮肤。

> **后续实测（见 §7）**：该包已发布在 npm（`0.1.5-rc.1` 与本部署同版本，可直接安装），peer mailbox / 任务板 / Web UI 都是真的；但它**不支持每个成员自己的 preset**，而"成员独立 preset"在本版本**无论走哪条路都不可行**。

---

## 4. 现在 → 新架构的映射

| 现在 | 新 | 依据 |
| --- | --- | --- |
| `<cwd>/.agent-group/groups/<owner>/roster.json` | 群注册表（`storageDomain`）+ 原生子代理列表 | `subagents.listChildren` |
| `chat.log` + `seq` 序号 | 群主会话记录（成员消息原生入 inbox） | 实测父会话 `agent/inbox/spliced` → `user/message` |
| `group_send/group_read/group_members`（根注册 + 守卫） | 原生 `send_message`(→父) + `list_agents` | `subagents.sendMessage` |
| "群目录存在 = 是群" | 显式注册表 | 探测法已三度失败 |
| 群预设 `agent/pre-step` auto-init | 不需要 | — |
| `~/.dsh/dsh-agent-panel-retired.json` 墓碑 | 原生子代理惰性记录 + 注册表软删除 | 原生无删除原语（仍是边界） |
| auto-start 读 `header.agentPreset` | 活的读 `composedPreset(agent.ctx)`，仅空白会话读 header | 实测 `3d86f452`：header=minimal / live=cordis |

---

## 5. 风险与待决问题

1. **群主 preset 谁定**：默认 `standard`？还是让用户在面板里选？（决定成员能力面）
2. **群聊在会话列表里的归类**：命名（`sessionTitle.rename` → "群聊 · XXX"）、归属哪个 workspace（`workspaceRegistry`）。
3. **群主是否需要"拉人"能力**：现在靠面板；若要让群主自己拉人，需给它 `agrp_pull` 或保留一个受限的 `group_pull`。
4. **迁移**：现有 workspace 里的群目录要不要一次性导入注册表，还是直接弃用（我倾向弃用 + 文档说明）。
5. **面板的"频道"区是否还需要**：若群聊是独立会话，用户在原生会话里就能看频道 → 客户端还能再减 ~80 行。
6. **成员沙箱**：继承群主会话的 permission preset，审批固定 `never`；群主会话若建在 `workspace-write` 下，成员就是 `workspace-write`（原生语义，不由插件放宽）。

---

## 6. 建议路径

1. **第一步（半天级）**：方案 B 的收敛 —— 状态搬进 `storageDomain`，删掉群工具/墓碑/auto-init/过滤包装；空白会话拉人时用原生 `select` 修正 preset；`auto-start` 改用 `composedPreset`。
2. **第二步**：方案 A —— 群聊成为独立实体（群主会话），面板改成"群聊列表 + 拉人"。
3. **第三步（条件成熟）**：官方 `agentTeams` 到位后迁移到原生 team 层，我们只做 UI。

---

## 附：本分析用到的实测证据

- 活体探针（动态 host 插件）结果：`agentTeams: false`、`storage: true`、`storageDomain: true`、`defaultPreset: "minimal"`、在线 agent `3d86f452`(header=minimal/live=cordis)、`d77d2888`(minimal/minimal)。
- 子 agent 日志（`7c96a48b…`）：工具面 12 个（`agrp_pull, group_members, group_read, group_send, pwsh, sidebar_open, ssh_*`）；工具调用 `group_read:1, group_members:1, pwsh:40`。
- 父会话日志（`session-d77d2888…`）：`agent/inbox/spliced` → `user/message`（子代理收尾消息原生入记录）。
- 会话头实测：`agentPreset: "minimal"`（`session-d77d2888…`、`session-a8b1b39e…` 的成员也都是同 12 个工具）。
- `ensureSession` 全新会话分支（`dsh-api-session-controller/lib/types/agent.js:489-504`）：`mkdir(cwd)` → `composeAgent(presetId)` → `agents.create({sessionId, meta:{cwd, agentPreset}})`。

---

## 7. 官方 Team 包调研 + 「多 preset agent」可行性（实测）

### 7.1 包是什么、能不能装

| 包 | 版本（npm） | 作用 |
| --- | --- | --- |
| `@deepseek-ai/dsh-experimental-agent-team` | `0.1.5-alpha.2` / `0.1.5-rc.1` / `0.1.5-rc.2` / `0.1.6-alpha.1` | 名册 + **持久 peer mailbox** + 共享任务 DAG；含 `./client`、`./remote`、`./typert`、`./invariant` |
| `@deepseek-ai/dsh-experimental-tool-agent-team` | 同上 | 模型侧工具（建 teammate、发消息、任务板） |
| `@deepseek-ai/dsh-experimental-agent-team-profile` | 同上 | 把上面两个挂进组合的 profile 行 |

- 它们只是已安装 dsh 的 **devDependencies**（发布版不带），但 **npm 上有公开发布**，且 `0.1.5-rc.1` / `rc.2` 与本部署版本对齐；peer 依赖（`cordis`、`dsh-agent`、`dsh-session`、`dsh-subagent`、`dsh-session-persistence(-jsonl)`、`schemastery`、`dsh-brand`、`dsh-invariants`、`dsh-typert-protocol`、`dsh-session-projection`）在 dsh 安装树里基本都在 ⇒ **理论可装**（需要一个可回滚的试装实验：profile bundles + 组合行）。
- README 明确要求与 `dsh-session-persistence-jsonl` 一起挂载（本部署已在用：`~/.dsh/sessions/…` 的 zstd 日志就是它）。

### 7.2 它提供什么（读官方中英文 README + 类型）

- **Lead = 任意运行时 root 会话**（`TeamId == SessionId`，隐式团队，无创建事件）；`spawnTeammate` 建**具名**常驻 teammate（`fresh` / `fork` 两种上下文）。
- **peer mailbox**：任何成员可给任何其他成员/Lead 发消息；live 立即送达，inactive 排队并在冷恢复后送达；投递去重（不丢不重）；对 teammate 的投递走 host-only 的 continuation steer 路径（"sibling 消息绝不会通过公开的相邻 Agent 消息操作伪装成 Lead"）。
- **共享任务板**：CAS revision、依赖 DAG、owner claim/complete/reassign、`writeScopes` 仅作提示。
- `waitForChange`（10s–1h）、`interrupt`（仅 Lead）、`remoteView` → `TeamView{members,tasks}`、`./remote` 提供 Web UI 的 Client contribution。
- 限制：`maxMembers 8` / `maxTasks 256` / 每成员排队 64 条 / 单条 64KB；**roster 扁平且不可变——不支持嵌套、重命名、删除、名字复用**；单进程共享 checkout；mailbox 不保证跨进程 exactly-once；idle/interrupt/退出都不会释放任务 owner。

### 7.3 「多 preset agent」（每个成员跑自己的 preset 工具面）——**本版本不可行**

四条路，全部封死：

| 路径 | 结果 | 证据 |
| --- | --- | --- |
| 让它继承 | 子 agent 加入**父会话**的 preset：`applyChildComposition` → `agentPresets.composeFrom(childCtx, parent.ctx)`；官方 team 的 teammate 也是 Lead 的直接子会话，`SpawnTeammateRequest` **没有 preset 字段**，整个 team 包**不引用 agentPresets** | 源码 + grep |
| 生成后用原生 `select` 换 | **拒绝**：`session "…" has already started; its agent preset is fixed`（`startContinuable` 返回时子会话已"开始"） | 实测×2：真 prompt 与**空 prompt** 都被拒 |
| 生成后用 `recompose` 换（灰区） | 机械上成功（返回 `se`，`composedPreset` 变 `se`），但 ① **不写 `agent-preset/selected`**（冷恢复会退回日志里的 preset）；② **成员立刻不可达**：`childPresetAfter: child-gone`，紧接着 `sendMessage` 报 `is unavailable`；**对照实验**（不做 recompose）同一时刻成员仍在线、follow-up 发送成功 | 实测 + 对照 |
| 让成员是**独立 root 会话**（各自 preset）再由插件路由 | 跨会话注入要求相邻父子：`SubagentPromptRequest` 必须同时给 `parentSessionId` + `childSessionId` 且 `mode:'continuable'`（"human message addressed to a continuable **direct child**"）⇒ 无法让两个无关 root 会话互相对话 | 类型定义 |

**结论**：`agentTeams` 也没有、`select` 也不许、`recompose` 会弄坏成员、跨会话注入没有 API ⇒ **每个成员独立 preset 的工具面，在本版本做不到**。

**能做到的（契约内）**：**能力面由群主会话决定，角色差异用 `persona` + `toolFilter` 表达**——例如 SE 成员 = 群主能力面 ∩ `deny: [write, edit]`（只读分析）、开发成员 = 全量、测试成员 = 全量 + 只读断言提示。群主 preset 选 `standard`/`cordis`，成员就不会再踩 `minimal` 那个坑。

### 7.4 因此的取舍

- **要"成员互发消息 + 任务板 + 现成 UI"** → 装官方 team 包（实验性、扁平不可变 roster、不支持改名/删除）。它给出的正是"session 之上的群聊"，只是**能力面统一**、且不能改名/删除成员。
- **要"群聊是我们的功能、成员可命名可移除、角色可控"** → 走 §3.1 方案 A（自研最小版），peer 消息用群主转达，任务板可选。
- **两者都不解决"每个成员自己的 preset"**——这条在本版本不存在。
