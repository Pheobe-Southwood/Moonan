# 架构

## 一句话

一个 Node 进程持有一份 SQLite、一套 chord host 和若干个 pi-agent-core 实例；浏览器是一个 chord 客户端；插件在服务端注册 facet，在浏览器里贡献一个 React 面板。

## 包

| 包 | 职责 |
|---|---|
| `moonan` | CLI、HTTP/WS 服务器、五个内置插件 |
| `@moonan_ai/core` | 存储、模型、运行时、chord 宿主 facet、插件加载 |
| `@moonan_ai/contracts` | 所有跨进程契约（TypeBox + chord `remote`） |
| `@moonan_ai/plugin-sdk` | 插件作者看到的接口：`defineServerPlugin`、`ServerHost` |
| `@moonan_ai/web` | React 19 应用，五个面板，中英双语 |
| `@moonan_ai/testing` | 假 OpenAI 服务、假 MCP 服务，测试与 e2e 用 |

依赖方向是单向的：`moonan → core → contracts`，`web → contracts`，谁都不反向依赖。

## 进程

```
┌─────────────────────────── Node ───────────────────────────┐
│ HTTP :21315  ── /           静态文件（dist/web）             │
│              ── /api/plugins  外部插件的 web.js              │
│              ── /ws          chord 服务器                    │
│                                                            │
│ chord host "moonan"                                        │
│   ├─ core facets: app / agent-index / agent                │
│   └─ plugin facets: agents / providers / chat / mcp / logs │
│                                                            │
│ AgentRuntime ── pi-agent-core Agent（每个 Agent 一个）        │
│ Store ── SQLite（明文 JSON 列）                              │
└────────────────────────────────────────────────────────────┘
                 ▲  WebSocket（JSON 帧）
                 │
        ┌────────┴────────┐
        │  浏览器 chord    │  客户端 host（kind: "client"）
        │  React 应用      │  每个面板持有自己的 Ref
        └─────────────────┘
```

开发时 Vite 在 21315 提供页面，并把 `/ws`、`/api`、`/plugins` 代理到 21316 的 Node 进程。生产只有一个进程，21315 同时服务静态文件和 WebSocket。

## 一次对话的完整路径

1. 浏览器 `ChatContract.post({ text })`。
2. chat 插件写入 `chat_messages`，把气泡推进状态单元，启动 2 秒合批计时器。
3. 计时器到点，把这一批拼成
   `{用户昵称}通过webui给你发送了 N 条消息：\n[HH:MM] …`，交给 `AgentRuntime.send`。
4. Agent 空闲时 `prompt()`，忙时 `steer()`——永不打断正在进行的回合。
5. pi-agent-core 调模型（`pi-ai` 的 `streamSimple`），事件流回到 `AgentInstance`：
   - `message_update` 的增量以 50 ms 节流写进 `live` 状态单元；
   - `message_end` / `turn_end` 落库到 `agent_messages`。
6. 模型调用 `act` 工具 → chat 插件再写一条 `chat_messages`（`direction: "out"`）并推给浏览器。
7. 工具结果回给模型，回合继续，直到 `agent_end` 把状态改回 `idle`。

模型输出的普通文本是「内心独白」，只出现在日志面板；用户能看到的一切都必须经过 `act`。

## 状态如何流动

- 服务端对象的 `state` 是 `Cell`，chord 负责增量同步到浏览器。
- 浏览器把 `Readable` 交给 React：`value` + `subscribe`。
- pi-agent 的事件不经过 chord 调用，所以单元格更新用 `api.root(ctx => cell.change(ctx, …))`，并按 50 ms 合并，避免每个 token 一次事务。

## 断线

chord 的链路不会续接：连接断开，所有引用释放。因此：

- 服务端在启动时把 app、agent-index 和每个 Agent 对象**钉住**，浏览器断开不会中断正在跑的回合；
- 浏览器每次重连都新建一个客户端 host，并递增 `generation`，让所有钩子重新取引用；
- 对话消息有两条来源：初始快照来自数据库，之后靠状态增量。两者都在，所以断线期间 `act` 写入的气泡在重连后仍会出现。

## 插件加载

1. 内置插件在 `moonan/src/plugins/*`，编译进主包，启动时 `host.install(facet)`。
2. 外部插件在 `~/.moonan/plugins/<id>/`，需要 `plugin.json`（`id`、`name`、`version`、`server`、`web`）。
3. 外部插件的模块解析由 `module.registerHooks` 兜底：`@moonan_ai/contracts`、`@moonan_ai/plugin-sdk`、`@earendil-works/chord`、`typebox` 一律指向主进程里的那一份，保证只有一份 chord 和一份 TypeBox。
4. 单个插件加载失败只会记录错误并把 `error` 放进插件列表，不会拖垮进程。

## 生命周期

```
createMoonan()
  ├─ 打开数据库、跑迁移
  ├─ 建 ModelRegistry / AgentRuntime / AppService / McpService
  ├─ 安装 core facets
  ├─ 安装内置插件 → 注册主 Agent 与 act 工具
  ├─ 扫描并加载外部插件
  ├─ 钉住 app / agent-index / agent:* 引用
  ├─ 后台连接已保存的 MCP 服务
  └─ 启动 HTTP + WebSocket
```
