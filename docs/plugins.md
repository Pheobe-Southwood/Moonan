# 插件

一个插件是一个**包**，最多有三个入口：

| 入口 | 文件 | 跑在哪 | 作用 |
|---|---|---|---|
| `.` | `server.ts` → `dist/server.js` | Node 进程 | chord facet：服务远程对象、贡献注册表、使用内核的能力契约 |
| `./contract` | `contract.ts` → `dist/contract.js` | 两边 | 这个插件导出的 `local()` 契约，给别的插件 `self.get` 用 |
| `./web` | `web.tsx` → `dist/web.js` | 浏览器 | chord facet：把面板注册进浏览器的 `Panels` 注册表 |

五个内置面板就是五个这样的包：`@moonan_ai/plugin-chat`、`-logs`、`-agents`、`-providers`、`-mcp`。它们和第三方插件走**同一条加载路径**（`host.load([url])`），唯一区别是 URL 从哪来：内置包来自 `import.meta.resolve`，磁盘插件来自 `plugin.json`。

## 装在哪里

```
~/.moonan/plugins/hello/
├── plugin.json
├── server.mjs     # 必须，ESM，默认导出 defineFacet(...)
└── web.js         # 可选，浏览器直接 import 的 ESM
```

```json
{
	"id": "hello",
	"name": "Hello",
	"version": "1.0.0",
	"server": "server.mjs",
	"web": "web.js"
}
```

`server` 缺省时依次找 `server.mjs`、`server.js`；`web` 缺省取 `web.js`。

**插件必须是 ESM。** 目录里没有 `package.json` 时 Node 会把 `.js` 当 CommonJS，`export default` 会炸。所以要么用 `.mjs`，要么放一个 `{"type": "module"}` 的 `package.json`；两种都不满足时 Moonan 会跳过并说明原因。`web.js` 不受这条限制：浏览器只认 ESM，没有 CJS 这一说。

## 写一个服务端插件

```js
import { defineFacet, local, method } from "@earendil-works/chord";
import { Type } from "typebox";
import { AgentDefinitions } from "@moonan_ai/contracts";

// 注册表只接受 lifetime: "host" 的对象，所以每个做贡献的插件都有这么一个根对象。
const Root = local("moonan.hello.root", {
	version: 1,
	input: Type.Object({}),
	members: { noop: method() },
});

export default defineFacet((api) => {
	api.serve(
		Root,
		(_input, _principal, self) => {
			self.register(AgentDefinitions, {
				hello: {
					id: "hello",
					pluginId: "hello",
					name: "{{helloName}}",
					description: "只会说英语的图书管理员",
					systemPrompt: "You are {{helloName}}, a librarian. Speak English only.",
					variables: [{ key: "helloName", label: "名字", type: "text", value: "Helen", global: false }],
				},
			});
			return { noop: () => undefined };
		},
		{ lifetime: "host" },
	);
});
```

完整例子见 [`examples/hello-plugin`](../examples/hello-plugin)。

## 内核认识什么：注册表

| 注册表 | 值 | 落在哪 | 说明 |
|---|---|---|---|
| `AgentDefinitions` | `AgentDefinition` | 服务端 | 声明一个 Agent；`id` 全局唯一，`pluginId` 由插件自报 |
| `AgentTools` | `{ tool, agents? }` | 服务端 | 静态工具；`agents` 省略表示所有 Agent 可用 |
| `AgentToolGroups` | `{ tools: () => AgentTool[], agents? }` | 服务端 | 运行时会变的工具集（MCP 用它）；内核在每个回合开始时重读 |
| `Panels` | `{ id, order, title, component }` | **浏览器** | 顶层标签页；由插件的 web facet 注册，shell 只负责渲染 |

前三个来自 `@moonan_ai/contracts`，`Panels` 来自 `@moonan_ai/web-api`。

注册表是**声明式**的：`self.register` 在工厂里一次写全，重载时整表替换。值不会序列化，所以可以带函数——`AgentToolGroups.tools` 和 `Panels.component` 都靠这一点。

`Panels` 之所以在浏览器：chord 的注册表是 per-host 的，服务端的注册表无法镜像到浏览器，而面板组件本来也过不了 wire。于是服务的归服务、界面的归界面，见 [ADR-0014](adr/0014-panels-belong-to-the-browser.md)。

## 内核给什么：能力契约

全是 `local()` 契约，由内核以 `{ lifetime: "host" }` 提供，插件用 `self.get(...)` 拿，进程内直接调用：

| 契约 | 能做什么 |
|---|---|
| `HostPaths` | 读 `dataDir`，拼自己的数据库路径 |
| `AgentAdmin` | `send` / `canSend` / `interrupt`；`send` 只入队，立即返回 |
| `TranscriptAdmin` | 分页读模型视角的转录（`page` / `count`） |
| `ModelAdmin` | 提供商列表、模型列表、密钥、自定义提供商、刷新 |
| `AppAdmin` | 用户昵称、语言、版本 |

声明了 `uses` 的 facet 会在 reload 时被重新绑定：

```js
export default defineFacet((api) => {
	// ...
}, { uses: [HostPaths, AgentAdmin] });
```

内置插件的 `uses` 一览：`agents: []`、`providers: [ModelAdmin]`、`chat: [HostPaths, AgentAdmin, AppAdmin]`、`mcp: [HostPaths]`、`logs: [TranscriptAdmin]`。

对话气泡、MCP 配置这类**插件自己的数据**不在内核里：每个插件在 `plugins-data/<id>.db` 里放自己的表。

## 插件之间：可以互相依赖

`./contract` 就是给这个用的。提供方：

```js
// examples/clock-plugin/server.mjs
export const Clock = local("example.clock", {
	version: 1,
	input: Type.Object({}),
	members: { now: method(Type.Object({}), Type.String()) },
});
```

消费方 `self.get(Clock, {})`，并在 facet 上声明 `uses: [Clock]`。

两个插件不需要共享模块实例：契约的身份是**指纹**，由「名字 + 版本 + 输入 schema + 成员」算出。所以消费方可以 `import "@moonan_ai/plugin-chat/contract"`，也可以在自己文件里写出逐字相同的定义（磁盘插件没有 `node_modules` 时就这么做）。

- 提供方先加载：`uses` 只在 reload 时校验，缺失时 `self.get` 会直接失败。
- 改 schema 必须升 `version`，否则 reload 以 `contract_mismatch` 拒绝。
- 内置插件这一版**互相不依赖**，机制由 `examples/clock-plugin` 与 `examples/greeter-plugin` 验证。`ProvidersContract` 留在 `@moonan_ai/contracts`，因为它描述的是内核的数据，而不是 providers 插件的私产。

见 [ADR-0012](adr/0012-plugins-may-depend-on-plugins.md)。

## 浏览器那一半

`web.tsx` 编译成 `dist/web.js`，由服务器在 `/plugins/<id>/web.js` 提供（同一目录下的相对 import 也能取到，比如 `/plugins/chat/ui.js`）。shell 拿到 `AppContract.plugins[].web` 后逐个 `host.load([url])`。

```tsx
import { defineFacet, local, method } from "@earendil-works/chord";
import { Panels } from "@moonan_ai/web-api";
import { Type } from "typebox";
import { ChatTab } from "./ui.js";

const Root = local("moonan.chat.web", {
	version: 1,
	input: Type.Object({}),
	members: { noop: method() },
});

export default defineFacet((api) => {
	api.serve(
		Root,
		(_input, _principal, self) => {
			self.register(Panels, {
				chat: { id: "chat", order: 10, title: { zh: "对话", en: "Chat" }, component: ChatTab },
			});
			return { noop: () => undefined };
		},
		{ lifetime: "host" },
	);
});
```

面板组件收到 `{ host, user, locale }`：

```tsx
import { useReadable, useRemote, useT, type PanelProps } from "@moonan_ai/web-api";
import { ChatContract } from "./contract.js";
import { messages } from "./i18n.js";

export function ChatTab({ host, user }: PanelProps) {
	const t = useT(messages);          // 自己的文案，回退到 shell 的字典
	const chat = useRemote(host, ChatContract, { agent: "main" });
	const bubbles = useReadable(chat?.messages, []);
	// ...
}
```

- `useRemote(host, contract, input)`：每次重连 host 会换，钩子随之重新取引用。
- `useT(messages)`：文案归插件所有；`common.save` 这类通用词回退到 shell。
- `title` 是数据（`{zh, en}`），不是 i18n key——shell 不需要为每个插件准备词条。

**共享运行时**：`index.html` 里的 import map 把 `react`、`react/jsx-runtime`、`react-dom`、`@earendil-works/chord`、`typebox`、`@moonan_ai/contracts`、`@moonan_ai/web-api` 指到 `/runtime/*.js`。插件只应该 import 这些；别的裸标识符浏览器解析不了。没有构建步骤的插件（比如 `examples/panel-plugin`）也能工作，只要它用 `createElement` 而不是 JSX。

这一套是 Moonan 自己的扩展，chord 并没有浏览器 loader，见 [ADR-0013](adr/0013-experimental-browser-facet-loader.md)。`GET /api/plugins` 返回 `experimental: true`；`POST /api/plugins/reload` 返回 `reloadBrowser: true`，因为浏览器不是 reload 参与者，只能整页刷新。

## 服务一个远程对象

跨进程对象要 `remote(name, { version, input, host, variants })`：

```js
import { hostNamed, method, remote } from "@earendil-works/chord";
import { Type } from "typebox";

export const HelloContract = remote("hello.greeting", {
	version: 1,
	input: Type.Object({}),
	host: hostNamed("moonan"),
	variants: {
		v1: {
			state: { text: Type.String(), at: Type.Number() },
			methods: { greet: method(Type.Object({ name: Type.String() }), Type.String()) },
		},
	},
});
```

几条硬规则，都是 chord 的：

- 对象必须声明 `host: hostNamed("moonan")`；用 `hostFamily` 会在连接时报「declared for … but moonan serves it」。
- 成员名不能是 `status`、`value`、`release`、`then` 等保留字（完整列表见 chord 的 `RESERVED_MEMBERS`）。
- 单元格只接受严格 JSON：值为 `undefined` 的属性会直接抛错。
- 状态对外是 `Readable`：`ref.x.value` 取值，`ref.x.subscribe(fn)` 订阅，没有 `.get()`。
- 在方法调用之外改状态要用 `chord.root(ctx => cell.change(ctx, next))`。
- 长任务（一次对话回合）用 `api.root(...)` 起一个 root；`self.task` 只放**可重启**的后台活（重载时会被停掉并重启）。

## 插件数据库

用 `self.resource` 打开，用 chord 自带的迁移器，进程内只有这一个写者：

```js
const paths = self.get(HostPaths, {});
const db = self.resource("db", {
	version: 1,
	deps: [paths],
	open: async () => {
		const dir = join(paths.dataDir.value, "plugins-data");
		await mkdir(dir, { recursive: true });
		const database = await openNodeSqliteDatabase(join(dir, "hello.db"));
		await database.exec("PRAGMA journal_mode = WAL");
		await applySqliteMigrations(database, [{ version: 1, statements: ["CREATE TABLE …"] }], {
			table: "schema_migrations",
		});
		return database;
	},
	close: (database) => database.close(),
});
```

资源带版本号：重载时版本不变就沿用同一个连接；改表结构时把 `version` 加一，旧连接先关、新代码再开。

### 单元格也有版本

`self.state(name, schema, initial, { version, migrate })`：单元格按**名字**跨重载存活，重载不会重跑 `init`。因此改单元格的**值结构**时必须把 `version` 加一，否则 chord 会以 schema 不匹配拒绝这次重载；旧值需要转换时提供 `migrate(old, from)`。

```ts
const pending = self.state("pending", Type.Array(BubbleSchema), [], {
	version: 2,
	migrate: (old, from) => (from < 2 ? upgradeBubbles(old) : (old as Bubble[])),
});
```

alpha5 没有改动任何单元格的值结构（`PluginInfo` 只是多了一个可选字段），所以没有 `migrate` 函数；这条规则留给下一次真正改结构的版本。

## 热重载

```bash
curl -X POST http://127.0.0.1:21315/api/plugins/reload -d '{"id":"hello"}'
```

不带 `id` 重载全部已加载插件。状态单元、进行中的回合、插件数据库连接都会被保留，详见[架构](architecture.md#热重载)。

浏览器不会跟着热重载：`reloadBrowser: true` 是在提醒前端整页刷新，面板的浏览器半边才会重新加载。

## 模块解析

插件目录在 `node_modules` 之外，因此下面这些裸标识符会被重定向到主进程正在用的那一份：

- 三个基础库：`@moonan_ai/contracts`、`@earendil-works/chord`、`typebox`
- 所有已安装的插件包及其 `./contract` 子路径：`@moonan_ai/plugin-chat`、`@moonan_ai/plugin-chat/contract`……

这样全进程只有一个 chord 实例和一份 TypeBox，插件的注册表令牌与契约才能和内核的对上。映射由 `createMoonan({ sharedModules })` 传入，`packages/moonan/src/plugins/index.ts` 生成。

其他依赖请随插件一起放在自己的目录里。

## 开发

只有一个端口：Node 进程同时服务 WebSocket 和构建好的前端。

```bash
pnpm dev     # 一次完整构建 + 三个 watcher（tsc / vite build --watch / esbuild --watch）+ tsx watch
pnpm build   # contracts → web-api → core → plugin-* → web → moonan
```

改了 `packages/contracts` 或 `packages/web-api` 的导出面，要让 `/runtime/contracts.js` 重建；watch 模式会自动做，手动时跑 `pnpm --dir packages/web build:runtime`。
