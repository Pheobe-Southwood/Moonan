# Moonan

一个本地运行的插件工作台。基座只做四件事——建 Chord 宿主、开一个端口、按 URL 装载插件模块、把 HTTP 交给插件的 `Routes` 注册表。所有功能都是插件，包括 AI 对话。

A local plugin workbench. The substrate builds a Chord host, opens one port, loads plugin modules by URL, and hands HTTP to the plugins' `Routes` registry. Every feature is a plugin.

---

## 快速开始 · Quick start

```bash
pnpm install
pnpm build
node packages/substrate/bin/moonan.js --plugin ./examples/clock-plugin
```

打开 <http://127.0.0.1:21315>，应该看到「时钟」标签页：一个每秒跳动的时钟，数据来自服务端 Chord 对象；`GET /api/clock` 由插件的 `Routes` 注册表提供。

```bash
moonan --port 21315 --plugins-dir ~/.moonan/plugins   # 默认值 / defaults
moonan --hostname 0.0.0.0                             # 局域网可访问 / reachable on the LAN
```

**基座不做鉴权**——端口对谁开放，谁就能驱动所有插件。只想本机用就别传 `--hostname`。

## 三个包 · Three packages

| 包 | 职责 | 面向谁 |
|---|---|---|
| `@moonan_ai/sdk` | 契约、注册表、浏览器钩子。根入口给两端与服务端用，`./web` 给浏览器切面用。 | 插件作者 |
| `@moonan_ai/web` (`private`) | 浏览器外壳与共享运行时打包器。 | 基座自己 |
| `@moonan_ai/moonan` | 服务端宿主、单端口网关、插件装载与 CLI。 | 使用者 |

依赖方向是单向的：`moonan → sdk`，`web → sdk`，`sdk → chord`。基座不认识任何插件包，外壳不认识任何面板——`packages/substrate/test/layering.test.ts` 盯着这条线。

## 写一个插件 · Writing a plugin

一个插件最多两个切面加一份契约：

```text
my-plugin/
├── plugin.json     # id / name / version / server / web
├── server.mjs      # 服务端切面：defineFacet，提供对象、贡献 Routes
└── web.js          # 浏览器切面：defineFacet，注册 Panels
```

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

- [CONTEXT.md](CONTEXT.md) — 词汇表：基座、宿主、切面、清单、注册表、面板
- [docs/architecture.md](docs/architecture.md) — 进程、一次请求与一次装载的完整路径
- [docs/plugins.md](docs/plugins.md) — 写一个插件：服务端切面、契约、浏览器切面
- [docs/adr/](docs/adr/) — 为什么是现在这个样子

## 开发 · Development

```bash
pnpm install
pnpm typecheck
pnpm build      # sdk → web（含 /runtime/*.js）→ moonan（内嵌 shell）
pnpm test       # 分层守护 + 基座集成（加载、路由、面板、热重载）
```

需要 Node.js ≥ 22.19。

## 状态 · Status

`0.0.2-alpha1`：内核已删除，基座收缩到 Chord。零数据库、零预设能力契约、零功能语义。AI 对话尚未回归——它会作为一个普通插件回来，和时钟插件走同一条加载路径。

## 许可 · License

MIT
