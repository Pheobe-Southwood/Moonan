# Moonan

一个本地运行的插件工作台。平台只做四件事：建 Chord 宿主、开一个端口、把插件目录/包解析成切面模块 URL、把 HTTP 交给插件的 `Routes` 注册表。所有功能都是插件，包括 AI 对话。

A local plugin workbench. The platform builds a Chord host, opens one port, resolves plugin directories/packages to facet module URLs, and hands HTTP to the plugins' `Routes` registry. Every feature is a plugin.

**平台不是 Chord 的 host。** Chord 的 host 才是对象/状态/重载的运行时；平台是它上面的应用层，负责进程、端口、插件发现、切面装载、Manifest 和浏览器外壳。

---

## 快速开始 · Quick start

```bash
pnpm install
pnpm build
node packages/platform/bin/moonan.js --plugin ./examples/clock-plugin
```

打开 <http://127.0.0.1:21315>，应该看到「时钟」标签页：一个每秒跳动的时钟，数据来自服务端 Chord 对象；`GET /api/clock` 由插件的 `Routes` 注册表提供。

```bash
moonan --port 21315 --plugins-dir ~/.moonan/plugins   # 默认值 / defaults
moonan --hostname 0.0.0.0                             # 局域网可访问 / reachable on the LAN
moonan --dev                                          # 校验每次 cell 写入 / validate cell writes
```

**平台不做鉴权**——端口对谁开放，谁就能驱动所有插件。只想本机用就别传 `--hostname`。浏览器侧还有一道同源校验：跨源的 WebSocket 和内建 `POST /api/plugins/reload` 会被拒绝，其他 origin 用 `--allow-origin` 显式放行；这不是账号鉴权，也不保护直接访问端口的非浏览器客户端。

## 三个包 · Three packages

| 包 | 职责 | 面向谁 |
|---|---|---|
| `@moonan_ai/sdk` | 契约、注册表、浏览器钩子。根入口给两端与服务端用，`./web` 给浏览器切面用。 | 插件作者 |
| `@moonan_ai/web` (`private`) | 浏览器外壳与共享运行时打包器。 | 平台自己 |
| `@moonan_ai/moonan` | 平台：服务端宿主、单端口网关、插件/切面装载与 CLI。 | 使用者 |

依赖方向是单向的：`moonan → sdk`，`web → sdk`，`sdk → chord`。平台不导入任何插件代码，只把切面 URL 交给 Chord；外壳不认识任何面板——`packages/platform/test/layering.test.ts` 盯着这条线。

## 写一个插件 · Writing a plugin

一个插件是一个目录或包，最多两个切面：

```text
my-plugin/
├── package.json   # 可选：name / version / type / 依赖
├── server.mjs     # 服务端切面：defineFacet，提供对象、贡献 Routes
└── web.js         # 浏览器切面：defineFacet，注册 Panels
```

纯服务端插件没有 `web.js`，纯前端插件没有 `server.mjs`，都是完整插件。没有 `plugin.json`，也没有插件 ID：**切面的模块 URL 才是运行时的身份**。

服务端：

```js
import { Routes, Type, defineFacet, hostNamed, local, remote } from "@moonan_ai/sdk";

export default defineFacet((api) => {
	api.serve(Counter, (input, _principal, self) => {
		const count = self.state("count", Type.Number(), 0);
		return { variant: "v1", count, bump: (ctx) => count.change(ctx, (n) => n + 1) };
	});
});
```

浏览器：

```js
import { Panels } from "@moonan_ai/sdk/web";

export default defineFacet((api) => {
	api.serve(Root, (_input, _p, self) => {
		self.register(Panels, { counter: { id: "counter", title: "计数", order: 10, component: CounterPanel } });
		return { noop: () => undefined };
	}, { lifetime: "host" });
});
```

一个可运行、零 AI 概念的例子见 [`examples/clock-plugin`](examples/clock-plugin)。

## 文档 · Documentation

- [CONTEXT.md](CONTEXT.md) — 词汇表：工作台、平台、宿主、插件、切面、清单、注册表、面板
- [docs/architecture.md](docs/architecture.md) — 进程、一次请求、一次装载与一次重载的完整路径
- [docs/plugins.md](docs/plugins.md) — 写一个插件：目录/包入口、服务端切面、契约、浏览器切面
- [docs/adr/](docs/adr/) — 为什么是现在这个样子

## 开发 · Development

```bash
pnpm install
pnpm typecheck
pnpm build      # sdk → web（含 /runtime/*.js）→ moonan（内嵌 shell）
pnpm test       # 分层守护 + 平台集成（解析、装载、路由、面板、热重载、官方语义对齐）
pnpm dev        # build 后以 --dev 启动示例时钟插件
```

需要 Node.js ≥ 22.19。

## 状态 · Status

`0.0.3-alpha1`：平台建立在 Chord 之上，不含数据库、预设能力契约或功能语义。插件由切面组成；平台一次装载/重载全部服务端切面，启动失败即关闭宿主。AI 对话尚未回归——它会作为一个普通插件回来，和时钟插件走同一条加载路径。

## 许可 · License

MIT
