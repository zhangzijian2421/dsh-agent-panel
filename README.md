# dsh-agent-panel

给 DeepSeek Harness Web GUI 用的 **Agent 拉人面板** 插件：在任意会话右上角把已安装的 agent preset「拉」进当前会话成为常驻成员，并在 `@` 菜单里用 agent 名引用它们。

一个包同时挂 **宿主半边**（loopback HTTP 路由 + 模型工具 `agrp_pull`）和 **浏览器半边**（会话标题栏触发器 + 下拉面板 + `@` 菜单新分组）。

---

## 功能

### 1. 面板：把 agent 拉进会话

- 会话右上角 `👥 群聊拉人` → 就地弹出面板
- **空会话（还没发过第一条消息）同样有按钮**：DSH 原生的会话头部在空白态整块隐藏
  （`ConversationSessionHeader` 只在 `!session.blank` 时渲染），挂在头部里的按钮那时**根本不存在**；
  因此本插件在 composer 上方的 `conversation.input.dock` 补了一个**只在空白态显示**的同一按钮，
  会话一旦开始就自动让位给右上角那个（不会重复出现）
- 列出**全部在线会话**做目标（当前会话排第一并标「当前」，可切换）
- 列出**已安装 preset**，点「拉入本会话」即拉起一个常驻子 agent：
  - 人格取自该 preset 的 `persona.prefix`（`|` / `>` 各种标量块都支持）
  - 成员名自动去重（重名 `-2` / `-3`）
  - `maxDepth=1`（成员不能再往下拉人）
  - 工具黑名单按目标会话的工具域**自动降级**，不会因为名字不认识而失败
- **任何会话拉人都会自动变群**（第 1 档行为）：目标会话没有群目录时，`pull` 会先为它创建
  `groups/<会话id>/roster.json`，再写入成员与系统消息——面板随即把它显示为聊天群
  （返回 `autoGrouped: true`）
- **群工具由面板自己提供**（第 3 档）：`group_send` / `group_read` / `group_members` 由本插件
  在根作用域注册（与 `agrp_pull` 同层），每次调用按**调用者会话**在运行期解析群目录：
  - 主持人 → 自己会话的群；成员（子代理）→ 其**父会话**的群
  - 因此**成员一定有群工具**（子作用域能解析根注册的工具），**不依赖会话是否使用群预设**
  - 没有群目录的会话调用会得到明确错误（提示先在面板拉人自动建群），不是静默失败
  - 群预设会话里 preset 的同名工具按作用域就近解析（两者语义一致：同一份 roster/chat.log）
- **一个工作区支持多个互相独立的群聊**：每个群一个目录
  `<cwd>/.agent-group/groups/<群主会话id>/{roster.json,chat.log}`，
  同一个工作区里开多个聊天群会话互不干扰；旧布局（整工作区单群）继续兼容
  - 群预设会话在**首次步进**时就会自动写入空名册（`agent/pre-step` 钩子），
    因此「新建群预设会话 → 发第一条消息 → 直接拉人」成立，无需任何初始化动作
  - 也可调用 `POST /init` 显式创建
- **空/未启动会话也能直接拉人**：目标会话还没有常驻 Agent 时，`pull` 会先调用
  `sessionController.ensureSession(sessionId, cwd, true, 该会话已选预设)` 把它启动起来
  （复用在线 agent / 恢复冷会话 / 按该会话的预设创建），再拉人；返回 `autoStarted: true`
  —— 未启动的会话在面板里不再显示为「无法拉人」，拉人按钮始终可用
- **当前会话永远是可选目标**：即使它没有被列入状态（例如 `header.cwd` 为空），面板也会把它补进
  目标列表；`pull` 在缺 `cwd` 时按会话自身解析工作目录，所以这个目标依然可用

### 2. 成员状态与移出

- 实时状态 `running` / `idle` / `ready`
- 每名成员带两步确认的「移出」：释放子 agent（`drainContinuableChildren`）+ 聊天群同步改名册与频道
- 移出记录**落盘**在 `~/.dsh/dsh-agent-panel-retired.json`，跨重启生效
- 被移出的成员进入「已移除」分区（灰显 + `[已移除]`），可一键「恢复」显示
- 名册写入失败时**不做任何改动**并报错，不会出现「名册删了人还在」的脏状态

### 3. `@` 菜单

- **新增分组「本会话子 agent」**：名字是 **agent 名**（拉人时定的成员名），不是会话标题；副标题显示 `常驻成员/一次性 · 运行中/待命`
  - 选中后插入的是**规范会话引用** `@[名](dsh-session:…)`，走 DSH 原生的 session-reference 上下文注入（选中该 agent 会话的快照注入 prompt），不是死文本
- **过滤噪音**：隐藏「其他会话的子代理」，只保留根会话 + 本会话自己的子 agent 树

### 4. 模型工具

- `agrp_pull`：与前端口径完全一致，供 agent 侧直接拉人（省略 `preset_id` 时返回当前状态）

---

## 安装

包形态遵循 DSH 官方 bundle 形状：`package.json` 的 `dsh.client` 声明浏览器半边，`dsh.bundle.patch` 指向 `cordis.patch.yml`（装载两半的那一行）。

```bash
# 方式 A：官方 CLI（推荐）
dsh plugin --profile web add link:<本仓库路径或 URL>
```

```yaml
# 方式 B：手动装进 profile
# 1) 把包放进 <profile>/node_modules/<包名>（junction / 复制均可）
# 2) 在 <profile>/cordis.patch.yml 里插入一行：
- insert:
    - id: agent-panel
      name: '@zijians-bow-is-long/dsh-agent-panel'
```

装完 **重启 DSH**，刷新页面。

安装位置参考（Windows）：

| 项 | 路径 |
|---|---|
| Profile | `%USERPROFILE%\.dsh\profiles\web\` |
| 包 | `<profile>\node_modules\@zijians-bow-is-long\dsh-agent-panel`（可直接 junction 到本仓库） |
| 启用行 | `<profile>\cordis.patch.yml` 或 `<profile>\package.json` 的 `dsh.profile.bundles` |

> **注意（踩过的坑）**：某些 profile 配了 pnpm 供应链策略（`minimumReleaseAge`），会让 `dsh plugin add` 因**既有 lockfile** 里较新的包而整体失败。此时用手动方式（方式 B）等价、且不动 lockfile。
>
> 另外：本插件的 `@` 菜单过滤会包装 shipped 的 `sessionReferenceResolver.listCandidates`（运行时可逆，不改任何文件）。若上游重命名该方法，过滤会静默失效（退回原行为），面板其余功能不受影响。

---

## HTTP API

全部限定 loopback（同机浏览器），返回 JSON：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/dsh-agent-panel/state` | 在线会话 + 各自的成员/已移除/频道消息 + 已安装 preset |
| GET | `/api/dsh-agent-panel/subagents?sessionId=` | 单个会话的子 agent（按 agent 名，已排除已移出） |
| POST | `/api/dsh-agent-panel/pull` | `{sessionId, cwd?, ownerId?, presetId, name?}` — 会话未启动时自动启动；无群目录时自动建群 |
| POST | `/api/dsh-agent-panel/retire` | `{sessionId, cwd?, memberId}` |
| POST | `/api/dsh-agent-panel/restore` | `{sessionId, memberId}` |
| POST | `/api/dsh-agent-panel/init` | `{sessionId, cwd?, name?}` — 显式创建群目录与空名册（正常流程由群预设自动完成） |

---

## 架构要点

**宿主半边**（`lib/index.js`）

- 只硬依赖 `webServer`；`fs` / `sessions` / `agents` / `subagents` / `agentPresets` 全部 `ctx.get` 判空，缺失时在对应路由报错
- 拉人走 `subagents.startContinuable({provider:'spawn', request:{parent, persona, toolFilter, maxDepth}})`
- **鸭子类型 AbortSignal**：`startContinuable` 强制要 signal，而动态沙箱里没有 `AbortController`；`dsh-subagent` 只调用 `throwIfAborted()`、读 `aborted`、增删 `abort` 监听，故用一个永不中止的等价对象即可
- **工具黑名单降级**：`tools.restrict()` 按**父会话工具域**校验 deny 名字，报错信息里会列出真实域名；解析它做精确裁剪，避免整次拉人失败
- **写策略显式化**：`fs.writeText` 默认策略会拒绝点路径（`.agent-group`）；显式传 `{mode:'workspace-write', workspaceRoot}` 后干净通过（不滥用 danger-full-access）
- **自动启动未启动会话**：`sessionController.ensureSession(sessionId, cwd, true, preset)` —— 与 GUI 启动会话同一条宿主路径（adopt 在线 / resume 冷会话 / 按会话自带预设 create）；`preset` 取 `session.header.agentPreset`，避免用默认预设覆盖用户的选择
- **多群目录解析**（`resolveGroupDir`）：新布局 `groups/<ownerSessionId>/` 优先；旧布局仅当名册 owner 匹配时沿用；名册读取失败一律按「不存在」处理，绝不因此让拉人失败
- **面板自带群工具**（`installGroupTools`）：`group_send` / `group_read` / `group_members` 注册在插件自身的根作用域，调用时用 `callerGroup` 按调用者会话解析群目录（主持人取自身、成员取 `parentSession`），无群目录则明确报错
- **群目录自动就绪**：群预设（`agent-chat-group/group.mjs`）在会话首次步进的 `agent/pre-step`（waterfall，监听器必须 `return next()`）里后台写入空名册——群目录的存在本身就是「这是群」的标记，前端无需检测或初始化

**浏览器半边**（`lib/client.js`）

- `__ModuleLoader__.load({id, factory})` 形态；`inject: ["slots", "inputTriggers"]`
- 面板挂在 `conversation.session.header.utilities`（正式会话的触发器）+ `conversation.input.dock`（**空白会话**的触发器，`session.blank` 门控，非空白返回 `null`）+ `shell.overlay`（下拉卡片）
  - 空白态判定优先用 dock 的 owner prop `session.blank`，取不到时退回标准 props 的 `useSession((s) => s.blank)`；两者都没有就保持隐藏，宁可少显示也不重复出现两个按钮
- `@` 源注册在 `ctx.inputTriggers.registerSource`，`order: -10` 排在 Sessions/Files 之前
- **`@` 源的 `candidates` 永不 reject**（控制器会丢弃 fetch 失败的源），且**不提供 `header`**（那是「钻取面包屑」钩子，返回非空数组以外的东西会破坏菜单渲染）

---

## 测试

不需要测试框架，纯 node：

```bash
node test/mention-codec.test.mjs    # mention 编码与 shipped codec 逐字节兼容（含 ] \ emoji 转义）
node test/mention-filter.test.mjs   # @ 过滤语义：保留自己的树、丢弃他人的、失败降级、可回滚
node test/blank-trigger.test.mjs    # 空白会话触发器：头部席位 + dock 席位、blank 门控、不重复渲染
```

---

## 已知边界

- **原生子代理条不可删/改名**：DSH 的 `dsh-subagent` 没有删除原语，子代理是「可冷恢复」的持久化实体，原生 UI 的记录会永久保留（惰性、不运行）。本插件的「移出」= 释放 + 名册/墓碑清理，属于 DSH 语义内的上限
- **无 cwd 的会话不进状态列表，但仍可被拉人**：`state` 会跳过 `header.cwd` 为空的会话，
  不过只要你正看着那个会话，面板就会把它补成目标（`pull` 自己解析 cwd）
- **群工具是全局注册**：`group_send` / `group_read` / `group_members` 对每个会话的工具面都可见（调用时按会话守卫，无群目录会报错）。群预设会话里 preset 的同名工具按作用域就近解析，两者语义一致（同一份 roster/chat.log）
- 插件为进程级单例面板：状态里的会话枚举是全量的，会话很多时首次打开会有一次遍历
- `cwd` 的路径分隔符按首次出现推断（Windows `\` / POSIX `/`），混用盘符的极端场景未覆盖

---

## License

MIT — 见 [LICENSE](./LICENSE)。
