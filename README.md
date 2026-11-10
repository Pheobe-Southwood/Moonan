# Moonan

一个本地运行的插件工作台。平台建 Chord 宿主、开一个端口、把插件目录/包解析成切面模块 URL、把 HTTP 交给插件的 `Routes` 注册表、发布 `WebFacetCatalog` 告诉浏览器加载哪些切面，并维护一个统一的 `moonan:data` 数据文件。所有功能都是插件；「装哪些插件」本身有一份引擎配置（`plugins.json`），可以在 WebUI 的「插件」页里改。

A local plugin workbench. The platform builds a Chord host, opens one port, resolves plugins to facet module URLs, publishes `WebFacetCatalog`, and keeps one unified data file. Every feature is a plugin, and which plugins load is a small engine config the 插件 tab can edit.

**平台不是 Chord 的 host。** Chord 的 host 才是对象、状态与重载的运行时；Moonan 是它上面的应用层，负责进程、端口、插件发现、切面装载、Web 切面目录、统一数据和浏览器外壳。

---

## 安装 · Install

```bash
npx @moonan_ai/moonan
# 或者装下来长期用
npm i -g @moonan_ai/moonan
moonan
```

平台通过 `optionalDependencies` 带上两个官方插件：`@moonan_ai/ai-gateway`（「模型」页）与
`@moonan_ai/plugin-manager`（「插件」页），所以不需要再传 `--plugin`。打开
<http://127.0.0.1:21315> 会直接看到两个标签页；不带官方插件时（`--no-official`）仍是一个空壳。

官方插件也可以单独安装（例如只想升级 `ai-gateway`）。第三方插件用 `--plugin` 临时加载，或在
「插件」页里添加；插件要和平台**装在同一个项目或同一个全局前缀**里，好让 `@earendil-works/chord`
只有一份，免得依赖解析出两套安装。

## 从源码开始 · From source

```bash
pnpm install
pnpm dev
```

打开 <http://127.0.0.1:21315>：内置的「模型」与「插件」两个标签页（官方插件由平台清单自动加载）。
`pnpm dev` 以 `--dev` 启动；不要 chord 的写入校验时用 `pnpm start`。

常用参数：

| 参数 | 作用 |
|---|---|
| `--port <n>` | 监听端口（默认 `21315`） |
| `--plugins-dir <dir>` | 启动时扫描插件目录（默认 `~/.moonan/plugins`） |
| `--plugins-file <path>` | 插件注册表（默认 `~/.moonan/plugins.json`） |
| `--plugin <包名\|目录>` | 只对本次进程追加一个插件，可重复 |
| `--no-official` | 不加载内置官方插件 |
| `--safe-mode` | 只加载锁定的官方插件（恢复用） |
| `--allow-management` | 非回环绑定也开启插件管理接口 |
| `--hostname <addr>` | 绑定地址（默认 `127.0.0.1`） |
| `--dev` | 校验每次 cell 写入与暴露状态 |
| `--allow-origin <o>` | 同源之外额外放行一个浏览器 origin |
| `--max-calls <n>` | 每条 WebSocket 链路的并发调用上限 |
| `--data-file <path>` | 统一数据文件（默认 `~/.moonan/data.json`） |

只想本机用，就别传 `--hostname`：平台不做账号鉴权，端口对谁开放，谁就能驱动所有插件。

### 局域网 / Tailnet

```bash
pnpm start:tailnet   # 绑定 Tailscale IPv4，只从 tailnet 可达
pnpm start:lan       # 绑定 0.0.0.0，局域网与 tailnet 都可达
pnpm dev:tailnet     # 同上，带 --dev（校验每次 cell 写入）
pnpm dev:lan
```

`start:tailnet` 会用 `tailscale ip -4` 自动找地址并打印 `http://100.x.y.z:21315`
（有 MagicDNS 时也打印 `http://<node>.<tailnet>.ts.net:21315`）。非回环绑定时插件管理接口默认关闭；
需要远程管理就加 `--allow-management`（脚本和 `moonan` 都支持）。自定义端口：

```bash
pnpm start:tailnet -- --port 21316
```

**平台没有账号鉴权。** 绑定 `0.0.0.0` 会让同一局域网内任何人都能驱动全部插件；优先用
`start:tailnet`，并只把端口分享给可信设备。不要把 21315 转发到公网。

## 概念 · Concepts

| 词 | 一句话 |
|---|---|
| 平台 Platform | 拥有进程、端口、插件发现、切面装载、Web 切面目录、统一数据与外壳；不含任何功能语义 |
| 宿主 Host | Chord 创建的对象容器。这里有两个：服务端宿主与浏览器宿主 |
| 切面 Facet | 插件在某一种宿主里的那一半代码；身份是模块 URL，也是装载与重载的单位 |
| 契约 Contract | 用 JSON Schema 描述的、两端各写一份的对象说明（构建器来自 `@earendil-works/pi-schema`）；身份是指纹，不是模块实例 |
| 注册表 Registry | 插件贡献东西的唯一通道：键值表，整表随代码版本替换 |
| Web 切面目录 WebFacetCatalog | 平台公布给浏览器的唯一远程对象：已解析的切面、显示名、版本与错误 |
| 数据存储 DataStore | 平台唯一的统一数据文件：插件按 namespace 读写，导出/导入由平台协调 |
| 模型提供商 ModelProviders | ai-gateway 自己定义并导出的服务端注册表：其他插件按 id 查找模型运行时 |

完整释义（含每个词的取舍与反例）见 [CONTEXT.md](CONTEXT.md)。

## 包 · Packages

| 包 | 职责 | 面向谁 |
|---|---|---|
| `@moonan_ai/sdk` | 通用契约、`DataCodecs`、浏览器钩子。根入口给两端与服务端用，`./web` 给浏览器切面用 | 插件作者 |
| `@moonan_ai/web`（private） | 浏览器外壳与共享运行时打包器；构建产物随 `@moonan_ai/moonan` 一起发布 | 平台自己 |
| `@moonan_ai/moonan` | 平台：服务端宿主、单端口网关、`moonan:data`、插件注册表/切面装载与 CLI | 使用者 |
| `@moonan_ai/ai-gateway` | 内置插件，也是独立发布的包：在「模型」标签页配置 pi-ai 提供商与模型 | 使用者 |
| `@moonan_ai/plugin-manager` | 内置插件：在「插件」标签页启用/停用/添加/移除插件 | 使用者 |

依赖方向是单向的：`moonan → sdk`、`web → sdk`、`sdk → chord + pi-schema`，官方插件 `ai-gateway → sdk + pi-ai`、`plugin-manager → sdk`。平台不导入任何插件代码，只把切面 URL 交给 Chord；官方插件只出现在平台 `package.json` 的 `optionalDependencies` 与 `moonan.officialPlugins` 清单里——`packages/platform/test/layering.test.ts` 盯着这条线。

Chord 锁定在 `1.5.0`（`sdk`、`web`、`moonan` 都依赖这一版），契约 schema 用 `@earendil-works/pi-schema` `1.5.0` 的构建器写；插件按同一版本对齐。

## 内置插件

### ai-gateway（「模型」页）

[`packages/ai-gateway`](packages/ai-gateway/README.md) 是仓库内置的模型网关面板。它把 pi-ai 的提供商、模型和请求参数搬进
统一数据文件中的一个数据集：

- 内置目录来自 `@earendil-works/pi-ai@1.5.0`：42 个提供商，添加时导入它们的对话模型目录。
- 自定义提供商支持 OpenAI 兼容、Anthropic、Google、Mistral、Bedrock、Vertex 等 API。
- 每个模型都能逐字段编辑：上下文、输出上限、价格与阶梯价、输入模态、输入限制、推理等级映射、
  提示缓存、采样参数、`compat` 兼容覆盖（按 API 从 pi-ai 的真实 schema 生成表单）、模型请求头。
- 「拉取模型」从上游的 `/models`（Anthropic `/v1/models`、Google `models`、Ollama `/api/tags`）
  读取目录；失败时按提供商回退到 pi-ai 内置目录，并把回退原因显示在面板上。
- 密钥、提供商、模型、全局请求默认值全部写在服务端统一数据文件的
  `ai-gateway/config` 数据集里（默认 `~/.moonan/data.json`，可用 `MOONAN_DATA_FILE`
  或 `--data-file` 改路径）。文件权限 `0600`，目录 `0700`；浏览器只拿到掩码。
- 面板不写 `localStorage`、`sessionStorage` 或 IndexedDB。

服务端切面重载不会丢配置：`DataStore` 是权威，`config` cell 是投影；统一数据文件原子替换。
「高级」页可以显式从统一数据文件重新加载；主文件损坏时会尝试 `.bak`，再不行就保留 `.corrupt-*` 并从空数据开始。
其他服务端插件可以通过 `ModelProviders` 注册表按 id 取得 ai-gateway 的 `MutableModels` 运行时。

### plugin-manager（「插件」页）

[`packages/plugin-manager`](packages/plugin-manager/README.md) 是插件管理页：它列出每个插件的
名称、版本、来源、启用/运行状态与解析错误，并提供启用、停用、添加（登记已安装的包或目录）与
移除。它是普通 web-only 插件，通过平台的 `/api/v1/plugins` 控制面工作；页面本身被标记为
`locked`，避免在界面里把管理页自己关掉。

- **启用/停用立即生效**：服务端切面走一次 `host.reload`，浏览器切面随 `WebFacetCatalog` 上下线；重启后状态保持。
- **添加不是下载**：平台只登记已经安装在同一条安装树（或当前工作目录）里的包，以及本地目录；不会联网 `npm install`。失败时页面会给出可复制的修复提示。
- **移除只改加载清单**：不卸载 npm 包、不删目录；内置插件不能移除，但可以停用（管理页除外）。
- **恢复入口**：`moonan plugins list|add|enable|disable|remove` 直接编辑注册表，不启动服务器；启动失败时平台会降级为「只加载锁定插件」，让「插件」页仍能打开。内置插件不能 `remove`（每次启动都会重新合并官方默认），只能停用。

## 统一数据 · Unified data

平台把可导出的插件数据放在一个 JSON 文件里（默认 `~/.moonan/data.json`，`--data-file` 或
`MOONAN_DATA_FILE` 可改）。插件注册 `DataCodecs` 后，自己的 namespace 才会进入统一导出：

```bash
curl http://127.0.0.1:21315/api/data/status
curl http://127.0.0.1:21315/api/data/export > moonan-data.json
curl -X POST http://127.0.0.1:21315/api/data/import \
  -H 'content-type: application/json' --data @moonan-data.json
```

导出默认省略 API Key；`?includeSecrets=1` 才包含明文。导入是原子的：未知 namespace、重复
namespace 或 codec 失败都会整批拒绝。`moonan:data` 内部用 `DataStore.update` 串行化读改写。

插件选择**不在**这份导出里：`plugins.json` 是引擎配置，故意独立于 `moonan:data`——否则导入一个
数据文件就能改变进程下次加载哪些插件。

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
import { defineFacet, hostNamed, method, remote, num, obj } from "@moonan_ai/sdk";

const Clock = remote("moonan.clock", {
	version: 1,
	input: obj({}, { open: true }),
	host: hostNamed("moonan"),
	variants: { v1: { state: { at: num() }, methods: { tick: method() } } },
});

export default defineFacet((api) => {
	api.serve(Clock, (_input, _principal, self) => {
		const at = self.state("at", num(), Date.now());
		return { variant: "v1", at, tick: (ctx) => at.change(ctx, () => Date.now()) };
	});
});
```

四条硬规则：

- **`hostNamed("moonan")`**：服务端只有一个宿主，名字就是这个。写别的名字，`serve` 会当场拒绝，启动直接失败。
- **契约两端各写一份**：浏览器切面拿不到服务端的模块；Chord 认指纹（名字、版本、成员、类型住在哪个宿主），不认模块实例。
- **注册表贡献必须来自 `{ lifetime: "host" }` 对象**：`Routes`、`Panels`、`DataCodecs`、`ModelProviders` 都一样。
- **浏览器切面是单个 ESM 文件**：浏览器没有模块 hook，重载只会换掉入口。

完整的插件写法（目录与包两种来源、`uses`、持久化、热重载）见 [docs/plugins.md](docs/plugins.md)。

## 运行时边界 · Runtime boundaries

- **没有账号鉴权。** 同源校验与 `--allow-origin` 只拒绝跨源浏览器，不是安全边界，也不保护直接访问端口的非浏览器客户端。命中的插件路由会拒绝浏览器跨站请求（`Sec-Fetch-Site: cross-site`，例如第三方页面的 `<img>`/`<form>`，或从其它站点进入的导航）；插件无法放行，显式 `--allow-origin` 的 origin 例外，非浏览器客户端不受影响。
- **插件管理接口默认只在本机可用。** `/api/v1/plugins*` 在回环绑定之外返回 403，除非显式 `--allow-management`；它同样校验同源/跨站。管理接口能改变进程加载的代码，等同于本机代码执行入口。
- **平台落两类文件。** 可导出的插件数据在统一数据文件 `~/.moonan/data.json`（`moonan:data`）；「装哪些插件」在引擎配置 `~/.moonan/plugins.json`（`--plugins-file`）。插件选择不参与数据导出/导入。
- **单宿主，启动失败会降级。** 所有服务端切面共享一个代码版本；一个切面在 `setup` 里抛错时，平台先整体启动失败，再自动用「只加载锁定插件」重试一次（registry 不改动），让「插件」页能打开并定位问题。`--safe-mode` 直接走这条恢复路径。
- **重载粒度是切面，不是插件。** `POST /api/plugins/reload` 重新解析入口，然后把**当前全部**服务端切面放进**一次** `host.reload` 重新 import（breaking 契约的提供方与消费方永远同批），再 `await host.ready()`；没有服务端切面时它也提交空批次，revision 照常 +1。启用/停用只把**新增/移除的切面**放进批次，未列出的切面继续运行。`/api/plugins/reload` 与 `/api/v1/plugins/reload` 是同一个管理策略（非回环绑定默认 403）。
- **浏览器不参与服务端提交。** 它靠 `WebFacetCatalog` 得知切面变化，只在 `web.url#hash` 变化时换自己的切面；服务端-only 的改动不会刷新页面。

## 文档 · Documentation

- [CONTEXT.md](CONTEXT.md) — 词汇表：平台、宿主、插件、切面、契约、Web 切面目录、数据存储、注册表、面板
- [docs/architecture.md](docs/architecture.md) — 进程、一次请求、一次装载、一次重载、一次广播的完整路径
- [docs/plugins.md](docs/plugins.md) — 写一个插件：来源、服务端切面、契约、浏览器切面、热重载
- [docs/release.md](docs/release.md) — 发布：版本真源、发布顺序、`latest` 策略、CI 与手动命令

## 开发 · Development

```bash
pnpm install
pnpm typecheck
pnpm build      # sdk → web（含 /runtime/*.js）→ moonan（内嵌 shell）
pnpm test       # 分层守护 + 打包守护 + 平台集成（解析、装载、路由、面板、热重载、官方语义对齐）
pnpm dev        # build 后以 --dev 启动，官方插件（模型 + 插件）自动加载
```

需要 Node.js ≥ 22.19。

## 状态 · Status

`0.1.0-alpha1`：契约 schema 从 TypeBox 换到 `@earendil-works/pi-schema`（Chord 1.5.0 的官方写法），`sdk` 不再导出 `Type`，改用 `obj`、`str`、`num`、`literal`、`record` 等构建器；契约 JSON 与指纹不变，旧页面只会整页刷新一次。平台建立在 Chord 之上，不含预设能力契约或功能语义；持久化分为统一数据文件与插件注册表两份。插件由切面组成；启停只重载新增/移除的切面，手动 reload 才重读全部服务端切面。

`0.0.5-alpha3`：平台建立在 Chord 之上，不含预设能力契约或功能语义；唯一的持久化是 `moonan:data` 统一数据文件。插件由切面组成；平台一次装载/重载全部服务端切面，启动失败即关闭宿主。

`sdk` / `moonan` / `ai-gateway` / `plugin-manager` 四个包发布到 npm（本版新增插件管理页）；`ai-gateway` 在「模型」标签页配置 pi-ai 的提供商与模型，
配置保存在平台统一数据文件的 `ai-gateway/config` 数据集里，并通过 `ModelProviders` 暴露给其他服务端插件。AI 对话尚未回归——它会作为一个普通插件回来，和 `ai-gateway` 走同一条加载路径。

## 许可 · License

MIT
