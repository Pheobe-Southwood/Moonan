# 插件

一个插件就是**一个 chord facet 模块**：默认导出 `defineFacet(...)` 的产物，可以服务跨进程对象、贡献注册表条目、使用内核的能力契约。五个内置面板本身就是插件，所以插件 API 只要够内置面板用，就够第三方用。

## 装在哪里

```
~/.moonan/plugins/hello/
├── plugin.json
├── server.mjs     # 必须，ESM 模块，默认导出一个 facet
└── web.js         # 可选，浏览器资源
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

**插件必须是 ESM。** 目录里没有 `package.json` 时，Node 会把 `.js` 当 CommonJS 加载，于是 `export default` 和 ESM-only 的依赖都会炸。所以要么用 `.mjs`，要么在插件目录放一个 `{"type": "module"}` 的 `package.json`；两种都不满足时 Moonan 会跳过并说明原因。

缺少 `plugin.json` 或入口文件的插件同样会被跳过，并在日志里写清原因；加载过程抛错只会把错误记进插件列表，不会影响进程。

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

| 注册表 | 值 | 说明 |
|---|---|---|
| `AgentDefinitions` | `AgentDefinition` | 声明一个 Agent；`id` 全局唯一，`pluginId` 由插件自报 |
| `AgentTools` | `{ tool, agents? }` | 静态工具；`agents` 省略表示所有 Agent 可用 |
| `AgentToolGroups` | `{ tools: () => AgentTool[], agents? }` | 运行时会变的工具集（MCP 用它）；内核在每个回合开始时重读 |
| `Panels` | `{ id, titleKey, order }` | 顶层面板；前端按 `id` 找组件 |

注册表是**声明式**的：`self.register` 在工厂里一次写全，重载时整表替换。值不会序列化，可以带函数（`AgentToolGroups` 就是靠这一点）。

## 内核给什么：能力契约

全是 `local()` 契约，由内核以 `{ lifetime: "host" }` 提供，插件用 `self.get(...)` 拿，进程内直接调用：

| 契约 | 能做什么 |
|---|---|
| `HostPaths` | 读 `dataDir`，拼自己的数据库路径 |
| `AgentAdmin` | `send` / `canSend` / `interrupt`；`send` 只入队，立即返回 |
| `TranscriptAdmin` | 分页读模型视角的转录（`page` / `count`） |
| `ModelAdmin` | 提供商列表、模型列表、密钥、自定义提供商、刷新 |
| `AppAdmin` | 用户昵称、语言、版本 |

对话气泡、MCP 配置这类**插件自己的数据**不在内核里：每个插件在 `plugins-data/<id>.db` 里放自己的表。

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

export default defineFacet((api) => {
	api.serve(HelloContract, (_input, _principal, self) => {
		const text = self.state("text", Type.String(), "hello");
		return {
			variant: "v1",
			text,
			greet: ({ name }) => `hello, ${name}`,
		};
	});
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
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { applySqliteMigrations } from "@earendil-works/chord/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { HostPaths } from "@moonan_ai/contracts";

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

## 浏览器那一半

`web.js` 会被服务器在 `/plugins/<id>/web.js` 提供，`GET /api/plugins` 里也带 `web` 字段。这一版的外壳只挂载内置面板：`Panels` 里出现未知 `id` 时显示占位面板，磁盘插件的 `web.js` 还没有面板位，服务端对象仍可以通过任何 chord 客户端直接使用。

内置面板的写法就是目标形态：`packages/web/src/plugins/<id>/ui.tsx` 用 `useRemote(contract, input)` 拿引用，`useReadable` 订阅状态，`useAction` 调用方法。

## 热重载

```bash
curl -X POST http://127.0.0.1:21315/api/plugins/reload -d '{"id":"hello"}'
```

不带 `id` 重载全部已加载插件。状态单元、进行中的回合、插件数据库连接都会被保留，详见[架构](architecture.md#热重载)。

## 模块解析

插件目录在 `node_modules` 之外，因此 `@moonan_ai/contracts`、`@earendil-works/chord`、`typebox` 这三个裸标识符会被重定向到主进程正在用的那一份。这样全进程只有一个 chord 实例和一份 TypeBox，插件的注册表令牌才能和内核的对上。

其他依赖请随插件一起放在自己的目录里。
