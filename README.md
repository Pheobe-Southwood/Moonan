# Moonan

一个本地运行的插件工作台。平台只做四件事：建 Chord 宿主、开一个端口、把插件目录/包解析成切面模块 URL、把 HTTP 交给插件的 `Routes` 注册表；外加发布一份 `Manifest`，告诉浏览器该加载哪些切面。所有功能都是插件。

A local plugin workbench. The platform builds a Chord host, opens one port, resolves plugins to facet module URLs, and hands HTTP to the plugins' `Routes` registry. Every feature is a plugin.

**平台不是 Chord 的 host。** Chord 的 host 才是对象、状态与重载的运行时；Moonan 是它上面的应用层，负责进程、端口、插件发现、切面装载、清单和浏览器外壳。

---

## 快速开始 · Quick start

```bash
pnpm install
pnpm build
node packages/platform/bin/moonan.js --plugin ./examples/clock-plugin
```

打开 <http://127.0.0.1:21315>：一个每秒跳动的「时钟」标签页，数据来自服务端 Chord 对象；`GET /api/clock` 由插件的 `Routes` 注册表提供。

常用参数：

| 参数 | 作用 |
|---|---|
| `--port <n>` | 监听端口（默认 `21315`） |
| `--plugins-dir <dir>` | 扫描插件目录（默认 `~/.moonan/plugins`） |
| `--plugin <包名\|目录>` | 追加一个插件，可重复 |
| `--hostname <addr>` | 绑定地址（默认 `127.0.0.1`） |
| `--dev` | 校验每次 cell 写入与暴露状态 |
| `--allow-origin <o>` | 同源之外额外放行一个浏览器 origin |
| `--max-calls <n>` | 每条 WebSocket 链路的并发调用上限 |

只想本机用，就别传 `--hostname`：平台不做账号鉴权，端口对谁开放，谁就能驱动所有插件。

## 概念 · Concepts

| 词 | 一句话 |
|---|---|
| 平台 Platform | 拥有进程、端口、插件发现、切面装载、清单与外壳；不含任何功能语义 |
| 宿主 Host | Chord 创建的对象容器。这里有两个：服务端宿主与浏览器宿主 |
| 切面 Facet | 插件在某一种宿主里的那一半代码；身份是模块 URL，也是装载与重载的单位 |
| 契约 Contract | 用 TypeBox 描述的、两端各写一份的对象说明；身份是指纹，不是模块实例 |
| 注册表 Registry | 插件贡献东西的唯一通道：键值表，整表随代码版本替换 |
| 清单 Manifest | 平台公布给浏览器的唯一远程对象：已解析的切面、显示名、版本与错误 |

完整释义（含每个词的取舍与反例）见 [CONTEXT.md](CONTEXT.md)。

## 三个包 · Three packages

| 包 | 职责 | 面向谁 |
|---|---|---|
| `@moonan_ai/sdk` | 契约、注册表、浏览器钩子。根入口给两端与服务端用，`./web` 给浏览器切面用 | 插件作者 |
| `@moonan_ai/web`（private） | 浏览器外壳与共享运行时打包器 | 平台自己 |
| `@moonan_ai/moonan` | 平台：服务端宿主、单端口网关、插件/切面装载与 CLI | 使用者 |

依赖方向是单向的：`moonan → sdk`、`web → sdk`、`sdk → chord`。平台不导入任何插件代码，只把切面 URL 交给 Chord——`packages/platform/test/layering.test.ts` 盯着这条线。

Chord 锁定在 `1.4.0`（`sdk`、`web`、`moonan` 都依赖这一版），插件按同一版本对齐。

## 写一个插件 · Writing a plugin

一个插件是一个目录或一个 npm 包，最多两个切面：

```text
my-plugin/
├── package.json   # 可选：version / type / 依赖
├── server.mjs     # 服务端切面：defineFacet，提供对象、贡献 Routes
└── web.js         # 浏览器切面：defineFacet，注册 Panels
```

服务端最小形态：

```js
import { Type, defineFacet, hostNamed, method, remote } from "@moonan_ai/sdk";

const Clock = remote("moonan.clock", {
	version: 1,
	input: Type.Object({}),
	host: hostNamed("moonan"),
	variants: { v1: { state: { at: Type.Number() }, methods: { tick: method() } } },
});

export default defineFacet((api) => {
	api.serve(Clock, (_input, _principal, self) => {
		const at = self.state("at", Type.Number(), Date.now());
		return { variant: "v1", at, tick: (ctx) => at.change(ctx, () => Date.now()) };
	});
});
```

四条硬规则：

- **`hostNamed("moonan")`**：服务端只有一个宿主，名字就是这个。写别的名字，`serve` 会当场拒绝，启动直接失败。
- **契约两端各写一份**：浏览器切面拿不到服务端的模块；Chord 认指纹（名字、版本、成员、类型住在哪个宿主），不认模块实例。
- **注册表贡献必须来自 `{ lifetime: "host" }` 对象**：`Routes` 与 `Panels` 都一样。
- **浏览器切面是单个 ESM 文件**：浏览器没有模块 hook，重载只会换掉入口。

完整的插件写法（目录与包两种来源、`uses`、持久化、热重载）见 [docs/plugins.md](docs/plugins.md)，可运行的例子见 [examples/clock-plugin](examples/clock-plugin)。

## 运行时边界 · Runtime boundaries

- **没有账号鉴权。** 同源校验与 `--allow-origin` 只拒绝跨源浏览器，不是安全边界，也不保护直接访问端口的非浏览器客户端。
- **平台不落盘。** 没有数据库、没有配置文件；插件要持久化就自己开自己的文件。
- **单宿主、启动即定。** 所有服务端切面共享一个代码版本；一个切面在 `setup` 里抛错会让整次启动失败——Chord 的 `install` 不是回滚事务，继续跑只会留下半个插件。
- **重载粒度是切面，不是插件。** `POST /api/plugins/reload` 重新解析入口，然后把全部服务端切面放进**一次** `host.reload`（breaking 契约的提供方与消费方永远同批），再 `await host.ready()`。
- **浏览器不参与服务端提交。** 它靠 `Manifest` 得知切面变化，只在 `web.url#hash` 变化时换自己的切面；服务端-only 的改动不会刷新页面。

## 文档 · Documentation

- [CONTEXT.md](CONTEXT.md) — 词汇表：平台、宿主、插件、切面、契约、清单、注册表、面板
- [docs/architecture.md](docs/architecture.md) — 进程、一次请求、一次装载、一次重载、一次广播的完整路径
- [docs/plugins.md](docs/plugins.md) — 写一个插件：来源、服务端切面、契约、浏览器切面、热重载

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

`0.0.4-alpha1`：平台建立在 Chord 之上，不含数据库、预设能力契约或功能语义。插件由切面组成；平台一次装载/重载全部服务端切面，启动失败即关闭宿主。

AI 对话尚未回归——它会作为一个普通插件回来，和时钟插件走同一条加载路径。

## 许可 · License

MIT
