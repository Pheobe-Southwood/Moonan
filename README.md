# Moonan

> 实验性项目，让AI的角色扮演更沉浸，支持灵活的插件系统

Moonan 是一个**单进程**的角色扮演运行时：一个 WebUI（默认 `http://127.0.0.1:21315`）+ 一套真正的插件系统。
官方内置的五个能力（提供商管理、Agent 管理、Act、对话窗、日志窗）**都是独立包**，通过 [Chord](https://www.npmjs.com/package/@earendil-works/chord)
的 facet 机制装配；把某个插件的包删掉，应用照样能启动，只是对应的能力消失。

当前版本：`0.0.1-rc.1`

---

## 快速开始

```bash
pnpm install
pnpm build          # 编译 TS + 构建 WebUI 产物
pnpm start          # 启动，默认 http://127.0.0.1:21315
```

首次启动会在 `~/.moonan/` 建库并写入内置的「主 Agent」。使用顺序：

1. **提供商** Tab：给一个 pi-ai 内置 provider（OpenAI / Anthropic / DeepSeek / OpenRouter …）填入 API Key，或新增一个 OpenAI 兼容的自定义 provider。保存后即时生效，不需要重启。
2. **Agent** Tab：选中「主 Agent」，填 `Bot 名字` 与`角色人设`（对应提示词里的 `{{botname}}` / `{{soul}}`），选择模型；需要改整段 SYSTEM PROMPT 时展开「高级选项」。
3. **对话** Tab：点某个 Agent 的入口即可对话。
4. **日志** Tab：查看任意 Agent 的完整原始上下文（含思维链与工具详情，默认折叠）。

CLI：

```bash
moonan [start] [--port 21315] [--host 127.0.0.1] [--home ~/.moonan] [--log info]
moonan help
moonan version
```

环境变量：`MOONAN_PORT`、`MOONAN_HOME`。

### 全局安装（本机测试）

```bash
pnpm install && pnpm build
cd apps/moonan && npm link    # 把 moonan 装到 npm 的全局 bin 目录（通常是 /usr/local/bin）
cd /tmp && moonan             # 之后任意目录都能起，默认 http://127.0.0.1:21315
```

也可以直接 `pnpm install:global`（= `pnpm build` + `npm link`）。

几点说明：

- pnpm 11 已经删掉 `pnpm link --global`，所以这里用 npm 的全局链接；`npm link` 不装依赖，运行时按真实路径解析工作区里的包，因此 `workspace:*` 不会被拿去 registry 找。
- 如果 `npm prefix -g` 的 bin 目录不在 `PATH` 里，改用符号链接：`ln -sfn "$PWD/apps/moonan/dist/cli.js" /usr/local/bin/moonan`。
- 卸载：`npm rm -g @moonan/app` 再删掉那个 `moonan` 链接。

---

## 数据与隐私

**所有数据都明文存放**在 `~/.moonan/`（可用 `MOONAN_HOME` 覆盖）：

| 路径 | 内容 |
|---|---|
| `moonan.db` | SQLite（WAL）。设置、**明文 API Key**、自定义 provider、Agent 定义、完整上下文历史、入站消息队列 |
| `moonan.db-wal` / `-shm` | SQLite 的 WAL 附属文件 |

- API Key 以明文写入 `provider_cred.secret`，**不加密**。
- 服务只绑定 `127.0.0.1`；可达性即授权，没有登录流程，也不要在共享机器上运行。
- 唯一的例外见 [ADR 0005](docs/adr/0005-plaintext-storage.md)。
- Node 22 的 `node:sqlite` 仍是实验特性，启动时可能打印一条 `ExperimentalWarning`。

---

## 架构

```
浏览器 (React + Vite 打包的 SPA)
   │  CBOR 帧（pi-protocol 信封）
   ▼
自研 WebSocket 服务端 ──► pi-server.Server ──► ServerHost ──► chord 服务
   ▲                        （路由/握手/取消）      │
   │                                               ├─ moonan.host-state
HTTP 静态服务（21315）                              ├─ moonan.actions
                                                   ├─ moonan.agents
Chord facet host ──┬── 宿主 facet（全部内置服务）    ├─ moonan.transcripts
                   ├── @moonan/plugin-provider-panel ├─ moonan.providers
                   ├── @moonan/plugin-agent-manager  ├─ moonan.ui
                   ├── @moonan/plugin-act            └─ moonan.events
                   ├── @moonan/plugin-conversation
                   └── @moonan/plugin-log-window
                            │
                            ▼
                   pi-agent-core 的 runAgentLoop（每个 Agent 一个运行实体）
```

要点：

- **数据面复用 pi-server**：浏览器发 pi-protocol 的 CBOR 帧，服务端把每条 WebSocket 连接包成 `ByteConnection` 交给 `pi-server.Server.accept()`，路由、握手、取消、订阅生命周期都由它处理。**没有 unix socket**（见 [ADR 0001](docs/adr/0001-single-process-and-websocket.md)）。
- **组合层用 Chord**：服务是带类型的 token，插件是 facet，状态是 replicated state（带 delta 的增量投递）。一个 id 的服务在 node 与浏览器两侧都能用同一份数据访问代码。
- **Agent 运行时用 pi-agent-core**，不用 pi-durable（见 [ADR 0002](docs/adr/0002-agent-core-not-durable.md)）；持久化是自研的 SQLite 层。
- **ActBlock**：主 Agent 的上下文里「下一步可用的 actions」在每次请求前先摘后挂，任意时刻只有一份，且从不落库（见 [ADR 0004](docs/adr/0004-actblock.md)）。

---

## 仓库结构

```
apps/moonan/           服务器 + CLI + 持久化 + 运行时（bin: moonan）
packages/plugin-sdk/   插件契约：服务 token、类型、（node 侧）注册入口
packages/ui/           WebUI：瑞士风格样式、宿主 shell、各 Tab 组件、浏览器侧 wire
packages/plugins/*     五个官方插件（各自独立成包，node 侧 facet）
docs/adr/              架构决策记录
CONTEXT.md             词汇表（术语的唯一解释）
```

---

## 插件开发

一个插件最少是「一个 `package.json` + 一个 node 入口」。UI 是可选的。

### node 侧

```ts
import { definePlugin } from '@moonan/plugin-sdk';

export const myPlugin = definePlugin({
  id: '@example/my-plugin',
  setup(_env, services) {
    // ⚠️ setup 必须同步完成，而且这里**只能**注册自己提供的东西。
    // 想用别人的服务（agents / actions / providers / …），放进 onReady：
    services.onReady(async (ctx) => {
      ctx.define.action({
        id: 'example.wave',
        title: '挥手',
        description: '向场景里的其他人挥手。',
        parameters: Type.Object({ who: Type.String() }),
        available: () => true,
        run: async (args, api) => {
          await api.writeSidebar({ kind: 'character', text: `（向${args.who}挥了挥手）` });
          return { ok: true, text: '已挥手' };
        },
      });
      await ctx.ui.contribute({ tab: { tab: 'logs', componentId: 'my-panel' } });
    });
  },
});
```

注册后把插件加进 `apps/moonan/src/plugins.ts` 的清单即可。

### UI 侧

宿主 shell 在 `packages/ui`（`src/shell.tsx` + `src/tabs/*.tsx`）。每个 Tab 的内容是一个组件，
它通过 `useReplicatedValue(services.agents.state)` 之类订阅服务状态，通过 `services.agents.list()` 之类发调用——
**没有** `Context` 参数，也没有 fetch：远端绑定负责补齐。

rc1 里 Tab 组件住在 `packages/ui` 内（而不是各自的插件包），这是「插件 UI 必须先与宿主一起构建」这个约束的直接体现；
契约（服务 id、方法签名、状态形状）已经与 node 侧统一，切换加载机制时组件可以整体搬到插件包里。
取舍理由与后续计划见 [ADR 0007](docs/adr/0007-ui-react-host-convention.md)。

### 两条必须知道的 Chord 约束

1. **服务句柄在属性访问时就做阶段校验**。`setup` 阶段访问 `services.agents` 会抛
   `service handles cannot be used while setting_up`。所以 SDK 只给 `setup` 暴露
   `log` / `define` / `onReady`，其余都在 `onReady(ctx)` 的回调里给。
2. **chord 的严格 JSON 校验不接受 symbol key、原型、函数、`undefined` 之外的任何东西**。
   任何要写进 replicated state 的插件数据（尤其是 TypeBox schema）都要先过 `toPlainJson()`
   （`apps/moonan/src/runtime/agent-manager.ts`），否则会得到 `Value contains a symbol key…`
   之类的报错。细节见 [ADR 0008](docs/adr/0008-chord-integration-constraints.md)。

---

## 开发与测试

```bash
pnpm typecheck     # tsc -b，全部包
pnpm test          # node:test（单测 + 端到端）
pnpm dev           # 后端 tsx watch
pnpm dev:web       # 前端 vite dev（21316，/api 代理到 21315）
pnpm build         # tsc -b + vite build → apps/moonan/dist/web
```

测试覆盖：

- `actblock.test.ts`：ActBlock 的摘/挂幂等性、变量渲染、净化；
- `agent-instance.test.ts`：用 faux provider 驱动多轮生成，断言「每次请求恰好一份 ActBlock」、steer 的注入点、`write` 不触发生成、重启后上下文一致；
- `wire.test.ts`：自研 WebSocket 客户端跑通 pi-protocol 握手、服务调用、订阅增量；
- `ui-wire.test.ts`：**直接跑 UI 那份 wire 代码**（浏览器与 node 共用），验证真实链路；
- `app.test.ts`：进程骨架、插件登记、内置 provider 列表。

---

## 已知限制（rc1）

- OAuth 登录只是占位：按钮禁用并标注「尚未实现」。
- 自定义 Agent 的"插件可以自己写 UI"目前是宿主约定，不是运行时可装载的 bundle。
- 没有真实的聊天平台适配（QQ/微信），actions 的前置条件机制用内置 action 演示。
- 日志窗的历史分页每次 50 条；超长会话的行高是估算值，展开后才精确。
- 单进程：任何插件里的死循环都会拖住整个应用（拆分方案见 [ADR 0001](docs/adr/0001-single-process-and-websocket.md) 的"后续"一节）。

## 许可

MIT
