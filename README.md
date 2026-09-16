# dsh-agent-panel

给 [DeepSeek Harness](https://github.com/) Web GUI 用的 **Agent 拉人面板** 插件：在任意会话右上角把已安装的 agent preset「拉」进当前会话成为常驻成员，并在 `@` 菜单里用 agent 名引用它们。

一个包同时挂 **宿主半边**（loopback HTTP 路由 + 模型工具 `agrp_pull`）和 **浏览器半边**（会话标题栏触发器 + 下拉面板 + `@` 菜单新分组）。

---

## 功能

### 1. 面板：把 agent 拉进会话

- 会话右上角 `👥 群聊拉人` → 就地弹出面板
- 列出**全部在线会话**做目标（当前会话排第一并标「当前」，可切换）
- 列出**已安装 preset**，点「拉入本会话」即拉起一个常驻子 agent：
  - 人格取自该 preset 的 `persona.prefix`（`|` / `>` 各种标量块都支持）
  - 成员名自动去重（重名 `-2` / `-3`）
  - `maxDepth=1`（成员不能再往下拉人）
  - 工具黑名单按目标会话的工具域**自动降级**，不会因为名字不认识而失败
- **聊天群会话**（存在 `.agent-group/roster.json` 且名册归属该会话）额外同步：
  - 写 `roster.json`、追加 `chat.log` 系统消息（与群聊 preset 的 `group_invite` 完全兼容，两条路径可混用）
  - 普通会话则不落任何文件，纯拉一个常驻子 agent

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
      name: '@local/dsh-agent-panel'
```

装完 **重启 DSH**，刷新页面。

安装位置参考（Windows）：

| 项 | 路径 |
|---|---|
| Profile | `%USERPROFILE%\.dsh\profiles\web\` |
| 包 | `<profile>\node_modules\@local\dsh-agent-panel`（可直接 junction 到本仓库） |
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
| POST | `/api/dsh-agent-panel/pull` | `{sessionId, cwd?, ownerId?, presetId, name?}` |
| POST | `/api/dsh-agent-panel/retire` | `{sessionId, cwd?, memberId}` |
| POST | `/api/dsh-agent-panel/restore` | `{sessionId, memberId}` |

---

## 架构要点

**宿主半边**（`lib/index.js`）

- 只硬依赖 `webServer`；`fs` / `sessions` / `agents` / `subagents` / `agentPresets` 全部 `ctx.get` 判空，缺失时在对应路由报错
- 拉人走 `subagents.startContinuable({provider:'spawn', request:{parent, persona, toolFilter, maxDepth}})`
- **鸭子类型 AbortSignal**：`startContinuable` 强制要 signal，而动态沙箱里没有 `AbortController`；`dsh-subagent` 只调用 `throwIfAborted()`、读 `aborted`、增删 `abort` 监听，故用一个永不中止的等价对象即可
- **工具黑名单降级**：`tools.restrict()` 按**父会话工具域**校验 deny 名字，报错信息里会列出真实域名；解析它做精确裁剪，避免整次拉人失败
- **写策略显式化**：`fs.writeText` 默认策略会拒绝点路径（`.agent-group`）；显式传 `{mode:'workspace-write', workspaceRoot}` 后干净通过（不滥用 danger-full-access）

**浏览器半边**（`lib/client.js`）

- `__ModuleLoader__.load({id, factory})` 形态；`inject: ["slots", "inputTriggers"]`
- 面板挂在 `conversation.session.header.utilities`（触发器）+ `shell.overlay`（下拉卡片）
- `@` 源注册在 `ctx.inputTriggers.registerSource`，`order: -10` 排在 Sessions/Files 之前
- **`@` 源的 `candidates` 永不 reject**（控制器会丢弃 fetch 失败的源），且**不提供 `header`**（那是「钻取面包屑」钩子，返回非空数组以外的东西会破坏菜单渲染）

---

## 测试

不需要测试框架，纯 node：

```bash
node test/mention-codec.test.mjs    # mention 编码与 shipped codec 逐字节兼容（含 ] \ emoji 转义）
node test/mention-filter.test.mjs   # @ 过滤语义：保留自己的树、丢弃他人的、失败降级、可回滚
```

---

## 已知边界

- **原生子代理条不可删/改名**：DSH 的 `dsh-subagent` 没有删除原语，子代理是「可冷恢复」的持久化实体，原生 UI 的记录会永久保留（惰性、不运行）。本插件的「移出」= 释放 + 名册/墓碑清理，属于 DSH 语义内的上限
- 插件为进程级单例面板：状态里的会话枚举是全量的，会话很多时首次打开会有一次遍历
- `cwd` 的路径分隔符按首次出现推断（Windows `\` / POSIX `/`），混用盘符的极端场景未覆盖

---

## License

MIT — 见 [LICENSE](./LICENSE)。
