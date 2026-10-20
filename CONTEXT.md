# Moonan 词汇表

本文件**只是词汇表**：每个术语在这里只有一个意思。实现细节、参数形状、决策理由都不写在这里（那些在代码与 `docs/adr/`）。

约定：与实现冲突时，以本文件的定义为准，并把冲突报告出来。

---

## 角色扮演的概念

### Agent
一个具备人设、变量、模型与**独立上下文**的生成主体。每个 Agent 有自己的一条对话历史。
不是 `Provider`，不是插件，也不是"角色"本身——Agent 是驱动角色的主体。

### AgentDefinition
Agent 的可编辑配置：`name`、`description`、`systemPrompt`、`variables`、`model`、`scope`、`ui`、`tools`。
持久化在 `agent_meta` 表。是配置，不是运行中的实例。

### SOUL
「Bot 名字」所扮演角色的**人设文本**。它是变量 `{{soul}}` 的值。
不是 Agent 的 SYSTEM PROMPT——人设是提示词的**输入**，提示词是模板。

### BotName
角色名，变量 `{{botname}}` 的值。可以与 Agent 的显示名 `name` 相同，但两者不是一回事：
`name` 是 UI 里的标签，`BotName` 是故事里角色的名字。

### SystemPrompt
带 `{{变量}}` 占位符的提示词**模板**，存在 AgentDefinition 里，用户可编辑。
它**不是**发给模型的东西。

### RenderPrompt
把变量代入 SystemPrompt 之后、真正发给模型的文本。每次请求前重新计算，因此改变量下一轮就生效。
它**不落库**：历史里保存的是模板，渲染结果是请求期的产物。

### 主 Agent
内置的那个 Agent，id 固定为 `main`，扮演"角色扮演场景的导演"。用户主要编辑它的 `{{botname}}` 与 `{{soul}}`。
它是内置的，但注册它的插件（`@moonan/plugin-agent-manager`）可以被替换。

---

## Act 机制

### Action
一个可由 `act` 工具调用的语义动作：id、说明、TypeBox 参数 schema、前置条件、执行函数。
**一个 Action 不等于一个 tool**：多个 Action 共用 `act` 这一个 tool。

### Precondition
Action 的可用性谓词（`available(input)`），在每次请求前求值。不可用的 Action 不会出现在 ActBlock 里。
不是权限系统。

### ActBlock
追加在「本轮最后一条 tool result（没有则最后一条 user 消息）」末尾的**「下一步可用的 actions」**段落，
以 `<!--moonan:act-block-->` 开头。任意时刻最多一份，且**永不落库**。
不是 SystemPrompt 的一部分，也不是 `act` 工具的 description（后者也有一份，那是另一回事）。

### Act
官方插件（`@moonan/plugin-act`）的名字；它没有 UI。它做的两件事：给主 Agent 注册 `act` 工具、
用 token 标记自己已装载。ActBlock 的渲染与摘挂由宿主实现，以保证所有 Agent 一致。

---

## 会话与流

### Conversation
一个 Agent 的持久化消息历史（`conversation` + `transcript` 两张表）。在 rc1 中 `Conversation.id === Agent.id`。
不是**对话窗**——对话窗是它的 UI。

### TranscriptMessage
历史里的一条消息：role（`system` / `user` / `assistant` / `tool`）、原文内容、时间、可选的用量。
`content` 里存的永远是**原文**，不含 ActBlock。

### 模型视图（model view）
把历史渲染成"真正发给 provider 的上下文"的结果：ActBlock 会在这里被挂上、旧块被摘掉。
它**不是**历史，也不持久化。

### steer / followUp / write
三种入站消息语义，对应 pi-agent-core 的两个注入点加一次纯写入：

| 名称 | 何时生效 | 典型用途 |
|---|---|---|
| `steer` | 当前 assistant 回合的 tool 调用跑完之后、下一次请求之前 | 「用户打开了对话窗」这类不该打断输出的通知 |
| `followUp` | Agent 本来要停下时 | 让它在跑完后再继续一轮 |
| `write` | 立即写入历史，**不触发生成** | 对话窗左侧"角色发出的消息" |

三者都先落 `queue` 表，因此进程重启不丢。

---

## 插件系统

### Plugin
一个独立包，导出 node 入口（`definePlugin`）与可选的 UI 入口。
**不是** Tab：一个 Tab 的内容可以由多个插件贡献。

### Facet
Chord 的装配单元：插件在宿主里的一"面"。每个插件至少一个 facet；facet 在 `setup` 阶段声明自己提供与依赖的服务，
Chord 据此校验整张依赖图、按依赖顺序激活、逆序销毁。

### Service
带类型的稳定 token（`{ id, local }`）。插件用 `env.use()` 拿别人的实现，用 `env.provide()` 提供自己的实现。
远端可暴露的服务，其成员只能是「strict JSON 值」「`(...args, Context) => Promise<JSON|void>`」或 `ReplicatedState`。

### Replicated state
Chord 的状态原语：生产者 `change()` 出原子修订，消费者拿到**不可变**的完整值，跨进程时以 delta 增量投递。
Moonan 的 Agent 列表、action 列表、provider 列表、日志实况流都是它。

### Tab
宿主固定的顶层导航项，共四个：**提供商 / Agent / 对话 / 日志**。
内置插件不出现"插件槽"里，也没有开关——它们就是这些 Tab 的实现者。

### 对话窗
「对话」Tab 里，每个注册了 `ui.dialog` 的 Agent 各有一个入口的界面。左侧是角色消息，右侧是用户消息。
用户点进某个入口会给**那个** Agent 发一条 `steer` 通知。

### 日志窗
「日志」Tab：任意 Agent 的完整原始上下文 + 实时流式输出。只通过 `moonan.transcripts` 取数，不直接读数据库。

---

## 宿主侧

### provider-registry（`moonan.providers`）
provider 列表、模型列表、API Key 的读写。它拥有**明文**凭据存储。
与 pi-ai 的 `Models` 集合是同一份数据的两面：配置一改，下一次请求就用到。

### 凭据存储（CredentialStore）
pi-ai 的接口（`read` / `list` / `modify` / `delete`），Moonan 的实现把值明文写进 `provider_cred` 表。
`modify` 是唯一写路径，因此 OAuth 刷新（rc2）不会被并发双重执行。

### ws-bridge
把每条 WebSocket 连接包成 pi-server 的 `ByteConnection` 的那一层。它只做字节搬运与同源/本机校验。
**不是**应用协议——协议是 pi-protocol。
