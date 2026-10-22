# 插件

一个插件由两半组成：服务端的 **facet**（用 chord 注册跨进程对象）和可选的浏览器资源 `web.js`。五个内置面板本身就是插件，所以插件 API 只要够内置面板用，就够第三方用。

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
import { defineServerPlugin } from "@moonan_ai/plugin-sdk";

export default defineServerPlugin("hello", (host) => {
	host.agents.register({
		id: "hello",
		name: "{{helloName}}",
		description: "只会说英语的图书管理员",
		systemPrompt: "You are {{helloName}}, a librarian. Speak English only.",
		variables: [{ key: "helloName", label: "名字", type: "text", value: "Helen", global: false }],
	});
	host.log.info("hello is ready");
});
```

`setup` 在宿主安装插件时同步执行；返回 Promise 时不会阻塞启动，但拒绝会记录错误。

完整例子见 [`examples/hello-plugin`](../examples/hello-plugin)。

## ServerHost

| 成员 | 作用 |
|---|---|
| `chord` | 这个插件自己的 `FacetApi`：`serve(contract, factory)`、`root(fn)`、`signal` |
| `agents` | 注册 Agent 与工具、给 Agent 发消息 |
| `chat` | 读写对话气泡 |
| `logs` | 分页读取模型视角的日志 |
| `models` | 提供商与密钥、模型列表、自定义提供商 |
| `mcp` | 添加 / 重连 / 删除 MCP 服务，开关工具 |
| `app` | 用户昵称、语言、版本 |
| `storage` | 这个插件私有的键值存储（落在 `plugin_state` 表） |
| `log` | 带插件名前缀的日志 |

`agents.send()` 只在 Agent 有模型时才会真正投递；用 `agents.canSend()` 先判断，免得每次都在日志里留一条错误。

## 服务一个对象

对象走 chord：契约定义在 `@moonan_ai/contracts`，服务端 `serve`，浏览器 `host.get`。

```js
import { remote, hostNamed } from "@earendil-works/chord";
import { Type } from "typebox";

export const HelloContract = remote({
	host: hostNamed("moonan"),
	shape: {
		greeting: Type.Object({ text: Type.String(), at: Type.Number() }),
	},
	variants: {
		hello: {
			variant: "v1",
			state: { greeting: Type.Object({ text: Type.String(), at: Type.Number() }) },
			methods: { greet: { args: Type.Object({ name: Type.String() }), returns: Type.String() } },
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

## 浏览器那一半

`web.js` 会被服务器在 `/plugins/<id>/web.js` 提供，`GET /api/plugins` 里带 `web` 字段。这一版的外壳只挂载内置面板，磁盘插件的 `web.js` 还没有面板位，服务端对象仍然可以通过任何 chord 客户端直接使用。

内置面板的写法就是目标形态：`packages/web/src/plugins/<id>/ui.tsx` 用 `useRemote(contract, input)` 拿引用，`useReadable` 订阅状态，`useAction` 调用方法。

## 模块解析

插件目录在 `node_modules` 之外，因此 `@moonan_ai/contracts`、`@moonan_ai/plugin-sdk`、`@earendil-works/chord`、`typebox` 这四个裸标识符会被重定向到主进程正在用的那一份。这样全进程只有一个 chord 实例和一份 TypeBox，插件的对象才能注册进同一个 host。

其他依赖请随插件一起放在自己的目录里。
