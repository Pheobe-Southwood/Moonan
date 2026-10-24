# 架构

## 一句话

内核只保留三件事——模型网关、Agent 的记忆与运行、chord 宿主；对话、日志、MCP、面板都是插件；插件与内核之间只剩两条通道：**注册表**（贡献什么）与**能力契约**（能用什么）。

## 包

| 包 | 职责 |
|---|---|
| `@moonan_ai/moonan` | CLI、HTTP/WS 服务器、构建好的前端 |
| `@moonan_ai/core` | 存储、模型、Agent 运行时、能力契约、chord 宿主、插件加载 |
| `@moonan_ai/contracts` | 内核侧契约（TypeBox + chord `remote`）、注册表令牌、能力契约 |
| `@moonan_ai/web-api` | 浏览器侧 SDK：`Panels` 注册表、`PanelProps`、hooks、i18n、共享组件 |
| `@moonan_ai/plugin-{agents,providers,chat,mcp,logs}` | 五个内置插件，各自带 server / contract / web 三个入口 |
| `@moonan_ai/web` | React 19 shell：没有任何面板，只有导航与 chord 客户端（`private`） |
| `@moonan_ai/testing` | 假 OpenAI 服务、假 MCP 服务，测试与 e2e 用 |

依赖方向是单向的：`moonan → plugin-* → contracts`，`moonan → core → contracts`，`plugin-* → web-api → contracts`。**没有** `core → plugin-*`，也没有 `web → plugin-*`：内核不认识「对话」「MCP」，shell 不认识任何面板。`packages/moonan/test/layering.test.ts` 盯着这三条线。

## 进程

```
┌─────────────────────────── Node ────────────────────────────┐
│ HTTP :21315  ── /             静态文件（dist/web）            │
│              ── /api/plugins  插件清单（experimental: true）   │
│              ── /plugins/:id/*  插件的浏览器资源（web facet）  │
│              ── /runtime/*.js  共享运行时（react/chord/…）     │
│              ── /api/plugins/reload  POST，热重载             │
│              ── /ws           chord 服务器                    │
│                                                             │
│ chord host "moonan"                                         │
│   ├─ 内核 facet：agent / agent-index / app                   │
│   ├─ 能力 facet：host-paths / agent-admin / transcript-admin  │
│   │              model-admin / app-admin                     │
│   └─ 插件 facet：agents / providers / chat / mcp / logs       │
│                                                             │
│ AgentRuntime ── pi-agent-core Agent（每个 Agent 一个，懒建）  │
│ Store ── moonan.db（设置、人设、转录、凭据）                  │
│ 插件 ── plugins-data/<id>.db（各自的 SQLite）                 │
└─────────────────────────────────────────────────────────────┘
                  ▲  WebSocket（JSON 帧）
                  │
         ┌────────┴─────────────┐
         │  浏览器 chord         │  客户端 host（kind: "client"）
         │  shell + web facet    │  Panels 注册表在这里，面板组件在这里
         └──────────────────────┘
```

只有一个进程、一个端口：Node 同时服务静态文件、`/runtime/*`、插件资源与 WebSocket。开发时没有第二个 dev server——插件资源必须和 WebSocket 同源，代理只会多一种两边不一致的方式。开发用 `vite build --watch` + `tsc -w` + `esbuild --watch` 代替 HMR。

## 一次对话的完整路径

1. 浏览器 `ChatContract.post({ text })`。
2. chat 插件把气泡写进自己的 `plugins-data/chat.db`，`revision` 加一，并推入批次队列。
3. `ChatContract` 对象挂在 `revision` 上，重新读一页气泡推给浏览器；`post` 到这里就返回了。
4. chat 插件的 `task` 每 100 ms 检查队列，满 2 秒就拼成
   `{用户昵称}通过webui给你发送了 N 条消息：\n[HH:MM] …`，调用 `AgentAdmin.send`。
5. `AgentAdmin` 只把消息放进 Agent 对象的 `inbox` 状态单元，**立即返回**（ACK）。
6. `inbox` 监听器在 commit 阶段启动，看到队列非空就 `api.root(...)` 开一个新回合：
   取走一条消息 → `agent.prompt(...)`。
7. pi-agent-core 调模型（`pi-ai` 的 `streamSimple`），事件流回到 `AgentInstance`：
   - 增量写进内存，`Progress` 按 50 ms 与输出字节数合并提交到 `live` 状态单元；
   - `message_end` / `turn_end` 用水位把新消息落进 `agent_messages`。
8. 模型调用 `send_message` 工具 → chat 插件再写一条气泡（`direction: "out"`）并 `revision` 加一。
9. 工具结果回给模型，回合继续，直到 `agent_end` 把状态改回 `idle`；`inbox` 里还有消息就再开一轮。

模型输出的普通文本是「内心独白」，只出现在日志面板；用户能看到的一切都必须经过 `send_message`。打开或切回对话窗不在这条路径上：它只读取已有气泡，不会向 Agent 发送提示词。

## 状态如何流动

- 服务端对象的 `state` 是 `Cell`，chord 负责增量同步到浏览器。
- 浏览器把 `Readable` 交给 React：`value` + `subscribe`。
- 方法执行期间用方法的 `ctx` 改单元格；pi 的事件不在 chord 调用树里，所以用 `api.root(ctx => cell.change(ctx, …))`，并用 `@earendil-works/chord/output` 的 `Progress` 限流。

## 断线

chord 的链路不会续接：连接断开，所有引用释放。因此：

- 内核启动时把 app、agent-index 和每个 Agent 对象**持有**到进程结束（`host.get` 拿到的引用会保存并在关闭时 `release()`）；浏览器断开不会中断正在跑的回合；
- 需要掩过短暂断开的对象带 `linger`（Agent 对象 30 秒、ChatContract 30 秒）；
- 浏览器每次重连都新建一个客户端 host，并递增 `generation`，让所有钩子重新取引用；
- 对话气泡有两条来源：`ChatContract.messages` 的初始快照与 `revision` 触发的重读。断线期间写入的气泡，重连后仍会出现。

## 热重载

`POST /api/plugins/reload`（可带 `{"id": "chat"}`）触发 `host.reload([moduleUrl])`：

1. **Prepare**：新代码的工厂在每个存活对象上重跑一次，只做声明；状态单元被保留，任务和监听器还没启动。
2. **Commit**：注册表整表替换；`task`、监听器用新代码重启；`lifetime: "host"` 对象重新注册自己的贡献。
3. **进行中的回合**是 `api.root` 启动的 root，会被「祖父化」——它在旧代码上跑完，继续写共享的单元格。
4. 新代码的 `AgentInstance` 不会 `dispose` 旧实例；旧实例跑完回合后自毁（僵尸队列），进程退出时兜底。
5. 插件数据库是 `self.resource`，版本不变就不重开；chat 的 `pending` 单元格保留，新代码接着合批。
6. 转录按水位追加，新旧两代代码不会写出重复行。

不保证的部分：连续两次重载时，第一次遗留的 root 会在 `taskStopDeadline`（默认 5 秒）后被中止；需要迁移单元格版本的重载最多等 5 秒，超时则本次重载中止（回合不丢，重试即可）。

## 插件加载

1. 内置插件是独立包（`@moonan_ai/plugin-*`），磁盘插件在 `~/.moonan/plugins/<id>/`；两者都走 `host.load([moduleUrl])` + `nodeLoader`，唯一区别是 URL 从哪来。
2. 内置模块用 `import.meta.resolve(pkg)` 解析（跟随 `--conditions=development`）；解析到的文件不存在时退到包里 `src/server.ts`，tsx/Vitest 可以加载。
3. 磁盘插件需要 `plugin.json`（`id`、`name`、`version`、`server`、`web`）。
4. 模块解析由 `module.registerHooks` 兜底：`@moonan_ai/contracts`、`@earendil-works/chord`、`typebox`，加上所有已安装插件包及其 `./contract` 子路径，一律指向主进程里的那一份，保证全进程只有一份 chord、一份 TypeBox（`@moonan_ai/plugin-sdk` 已删除）。
5. 单个插件加载失败只会记录错误并把 `error` 放进插件列表，不会拖垮进程。
6. 浏览器那一半是另一条路径：shell 从 `AppContract.plugins[].web` 拿 URL，逐个 `host.load([url])`，由 `packages/web/src/chord/facet-loader.ts` 动态 `import()`。一个模块失败只记日志，其他面板照常出现（[ADR-0013](adr/0013-experimental-browser-facet-loader.md)）。

## 生命周期

```
createMoonan()
  ├─ 打开 moonan.db、跑迁移
  ├─ 建 Store / ModelRegistry / AppService / AgentRuntime
  ├─ 安装内核 facet 与能力 facet
  ├─ 订阅 agents / agent-tools / agent-tool-groups 注册表（面板不在服务端）
  ├─ 依次加载内置插件模块，再扫描并加载磁盘插件
  ├─ 持有 app / agent-index / agent:* 引用（并因此激活每个 Agent 对象）
  └─ 启动 HTTP + WebSocket

close()
  ├─ 关 HTTP 与 WebSocket
  ├─ 中止并释放全部 Agent 实例（含僵尸）
  ├─ 释放持有的引用
  ├─ 关闭 chord host（停 task、关资源）
  └─ 关 moonan.db
```
