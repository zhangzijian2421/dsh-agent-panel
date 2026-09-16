# Agent / 子代理 / Preset / 会话 —— 关系类图

> 依据 DSH 0.1.5-rc.1 运行时源码阅读与行为实验整理；为可读性做了简化，
> 只列出与本插件相关、且**实际验证过**的属性与方法。

## 0. 先分清四个词（大白话）

| 词 | 是什么 | 一句话 |
|---|---|---|
| **Session 会话** | 一段对话的持久化容器 | 有 id、工作目录、日志；子代理本身也是会话 |
| **Agent** | 会话里「活着的执行体」 | 一个会话同一时刻最多一个常驻 Agent；空闲可能被卸载（冷恢复） |
| **Preset** | 岗位模板 | 一份插件行清单 = **工具 + 人格 + 行为约束**，会话创建时绑定一个 |
| **子代理 Subagent** | 由某会话派生的子会话 | `origin='subagent'`，继承父会话的工具，可附带人格与黑名单 |

---

## 1. 未安装插件：原生关系

```mermaid
classDiagram
direction TB

class Preset {
  +String id
  +String name
  +String description
  +String trust
  +list() Preset[]
  +read(id) String
  +mount(agentCtx, id)
  +recompose(agentCtx, id)
  +composedPreset(agentCtx) String
  +select(agent, presetId)
}
class PresetComposition {
  「agent.cordis.yml 的插件行清单」
  +工具行 tool-fs / bash / cordis_* …
  +人格行 persona.prefix
  +行为行 群规 / 说明
}
class Session {
  +SessionId id
  +String cwd
  +String origin
  +Session parentSession
  +Number createdAt
}
class Agent {
  「会话的常驻执行体」
  +SessionId id
  +Session session
  +Context ctx
}
class ToolRegistry {
  +register(definition)
  +schemas(scope) ToolSchema[]
  +get(name, scope)
  +restrict(filter)
  +execute(exec)
}
class SubagentRuntime {
  +startContinuable(spec) ContinuableStart
  +sendMessage(sender, targetId, content, options)
  +listChildren(parentSessionId) Entry[]
  +drainContinuableChildren(parent, childIds)
  +interrupt(targetId, authority)
}
class SubagentDescriptor {
  +String mode
  +String label
  +String persona
  +ToolFilter toolFilter
  +Number maxDepth
}
class SessionReferenceResolver {
  +listCandidates(agent, query, limit, signal)
  +prepare(agent, content, references, signal)
}

Preset "1" *-- "many" PresetComposition : 组合行
Session "1" --> "0..1" Preset : 创建时绑定（决定工具+人格）
Session "1" --> "0..1" Agent : 常驻执行体
Agent "1" --> "1" Session
Agent ..> ToolRegistry : 经作用域层看到本会话的工具
Session "parent" --> "children" Session : header.parentSession
Session "child" --> "1" SubagentDescriptor : 派生信息（首事件）
SubagentRuntime ..> Session : 创建子会话 / 列举目录
SubagentRuntime ..> Agent : parentAgent（血缘+工具继承来源）
SessionReferenceResolver ..> Session : @候选 = 除自己外的全部会话
```

### 原生语义的两个关键点（常见误解的来源）

1. **子代理不是新 preset 的载体。** `startContinuable` 只传 `persona`（人格文本）
   与 `toolFilter`（黑名单），**工具永远继承父会话**——「换脑子不换手」。
2. **`@` 引用菜单没有「子代理」概念。** 它列出除自己外的**所有**会话，
   按 cwd 亲缘排序；别人的子代理继承其父 cwd，反而排在前面。

---

## 2. 安装本插件后：聊天群 + 完整能力开关

新增角色：**面板宿主**（编排拉人/移出/恢复）、**面板客户端**（触发器 + 下拉卡片 + `@` 新源）、
**墓碑库**（跨重启记住已移出）、**名册/频道文件**（聊天群状态的落盘）。

```mermaid
classDiagram
direction TB

class AgentPanelHost {
  「lib/index.js 宿主半边」
  +state() 在线会话+成员+preset
  +subagents(sessionId) 按agent名列出
  +pull(args) 拉人编排
  +retire(args) 移出+释放
  +restore(args) 撤销墓碑
}
class AgentPanelClient {
  「lib/client.js 浏览器半边」
  +HeaderTrigger 右上角按钮
  +PopPanel 下拉面板
  +@源 session-agents
  +encodeSessionMention(id, label)
}
class RetiredStore {
  «~/.dsh/dsh-agent-panel-retired.json»
  +Set 已移出键 owner:child
  +persist()
}
class RosterFile {
  «.agent-group/roster.json»
  +Owner owner
  +Member[] members
}
class ChatLogFile {
  «.agent-group/chat.log»
  +系统消息/成员发言(JSONL)
}
class Member {
  +String id
  +String name
  +String preset_id
  +Number invited_at
}
class Session {
  +SessionId id
  +String cwd
}
class Agent {
  +SessionId id
  +Context ctx
}
class Preset {
  +String id
  +recompose(agentCtx, id)
  +read(id) String
}
class SubagentRuntime {
  +startContinuable(spec)
  +sendMessage(parent, childId, content, options)
  +listChildren(parentSessionId)
  +drainContinuableChildren(parent, childIds)
}
class ToolRegistry {
  +restrict(filter)
  +schemas(scope)
}

AgentPanelClient ..> AgentPanelHost : loopback /api/dsh-agent-panel/*
AgentPanelHost --> SubagentRuntime : startContinuable / sendMessage / drain
AgentPanelHost --> Preset : read(人格) / recompose(完整能力)
AgentPanelHost --> RosterFile : 聊天群读写名册
AgentPanelHost --> ChatLogFile : 追加系统消息
AgentPanelHost --> RetiredStore : 移出时落墓碑
AgentPanelClient ..> ToolRegistry : @源注册到 inputTriggers
SubagentRuntime --> Session : 派生子会话
SubagentRuntime --> Agent : parentAgent 血缘
Session "1" --> "0..1" Preset : 原生绑定
Agent "1" --> "0..1" Preset : 完整能力=recompose 换装
RosterFile "1" *-- "many" Member
```

### 拉人编排（`pull`）的分支逻辑

```mermaid
flowchart TB
A[前端点「拉入本会话」] --> B[读名册·定名·读目标 preset 人格]
B --> C{目标会话是聊天群?}
C -- 是 --> D[spawn: 群人格 + 群规]
C -- 否 --> E{勾选「完整能力」?}
E -- 否 --> F[spawn: preset 人格 + 会话继承工具]
E -- 是 --> G[spawn: 中性人格] --> H[recompose 子作用域为该 preset] --> I[sendMessage 投递正式简报]
D --> J[写 roster.json + chat.log]
I --> J2[不落盘 · 纯常驻子代理]
F --> J2
D --> K[成员拥有群工具 group_send 等]
F --> K2[成员工具 = 会话继承工具 - 黑名单]
H --> K3[成员工具 = 目标 preset 真实工具集]
```

> **聊天群成员强制忽略「完整能力」**：recompose 会剥掉 `group_send` / `group_read`
> 这些群工具，群规就破了——所以群成员固定走「继承群工具」路线，选项被忽略并提示。

---

## 3. 三种成员形态对照

| 形态 | 脑子（人格） | 手（工具） | 落盘 | 典型用途 |
|---|---|---|---|---|
| 群成员（聊天群拉人，开关忽略） | 目标 preset | **群工具**（group_send 等）+ 会话继承 − 黑名单 | roster.json + chat.log | 群内协作、@派活 |
| 普通成员（普通会话，开关关闭） | 目标 preset | **会话继承** − 黑名单 | 无 | 同房间出主意/调研 |
| 完整能力成员（普通会话，开关开启） | 目标 preset（recompose 挂入） | **目标 preset 真实工具集** | 无 | 跨能力借用（如极简模式里用创造模式） |

---

## 4. 移出与恢复的生命周期

```mermaid
flowchart LR
A[面板点「移出」×2] --> B[drain：释放子代理]
B --> C[聊天群? 改名册+频道系统消息]
C --> D[写墓碑 owner:child 到 retired.json]
D --> E[面板不再列出 / @源不再提供]
E --> F[原生子代理条仍保留惰性记录<br>显式发消息可冷恢复]
E --> G[面板「已移除」分区灰显，可点「恢复」撤墓碑]
```

---

## 5. 兼容性风险备注

- `@` 过滤包装了 shipped 的 `sessionReferenceResolver.listCandidates`
  （运行时可逆，不改文件）；上游若重命名该方法，过滤静默失效，面板其余功能不受影响
- 完整能力依赖 `agentPresets.recompose` 对「已创建子作用域」的支持（实验验证可用）；
  上游行为变化需回归 `test/` 下两个测试与一次手动拉取验证
