# Moonan

一个本地运行、需要登录的插件工作台。平台建 Chord 宿主、开一个端口、把插件目录/包解析成切面模块 URL、把 HTTP 交给插件的 `Routes` 注册表、发布 `WebFacetCatalog` 告诉浏览器加载哪些切面，并维护一份按账户隔离的 `moonan:data` 数据存储（内嵌 SQLite 数据库 `~/.moonan/data.db`）。账户与会话单独放在 `~/.moonan/auth.db`。所有功能都是插件；「装哪些插件」本身有一份引擎配置（`plugins.json`），可以在 WebUI 的「插件」页里改。

A local, account-based plugin workbench. The platform builds a Chord host, opens one port, resolves plugins to facet module URLs, publishes `WebFacetCatalog`, and keeps one unified data store partitioned per account (an embedded SQLite database). Accounts and sessions live in a separate `~/.moonan/auth.db`. Every feature is a plugin, and which plugins load is a small engine config the 插件 tab can edit.

**平台不是 Chord 的 host。** Chord 的 host 才是对象、状态与重载的运行时；Moonan 是它上面的应用层，负责进程、端口、插件发现、切面装载、Web 切面目录、账户与按账户隔离的数据，以及浏览器外壳。Chord 的 principal 在 Moonan 里就是平台自身（`host`）、浏览器宿主（`browser`）或一个登录会话（`user`）。

---

## 安装 · Install

```bash
npx @moonan_ai/moonan
# 或者装下来长期用
npm i -g @moonan_ai/moonan
moonan
```

平台通过 `optionalDependencies` 带上两个官方插件：`@moonan_ai/ai-gateway`（「模型」页）与
`@moonan_ai/plugin-manager`（「插件」「用户」页），所以不需要再传 `--plugin`。打开
<http://127.0.0.1:21315> 会先要求创建**第一个管理员**（用户名 + 密码）；之后用它登录，普通账户再由管理员在「用户」页创建。没有自助注册，也没有免登录模式。

官方插件也可以单独安装（例如只想升级 `ai-gateway`）。第三方插件用 `--plugin` 临时加载，或在
「插件」页里添加；插件要和平台**装在同一个项目或同一个全局前缀**里，好让 `@earendil-works/chord`
只有一份，免得依赖解析出两套安装。

## 从源码开始 · From source

```bash
pnpm install
pnpm dev
```

打开 <http://127.0.0.1:21315>：第一次打开先创建管理员。官方插件由平台清单自动加载；管理员能看到「模型」「插件」「用户」三个标签页，普通账户只看到「模型」等非管理面板。

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
| `--hostname <addr>` | 绑定地址（默认 `127.0.0.1`） |
| `--auth-db <path>` | 账户数据库路径（SQLite，默认 `~/.moonan/auth.db`；也可用 `MOONAN_AUTH_DB`） |
| `--data-db <path>` | 可导出插件数据的数据库路径（SQLite，默认 `~/.moonan/data.db`；也可用 `MOONAN_DATA_DB`） |
| `--secure-cookies` | 给会话 cookie 加 `Secure`（部署在 HTTPS 反向代理后时用） |
| `--dev` | 校验每次 cell 写入与暴露状态 |
| `--allow-origin <o>` | 同源之外额外放行一个浏览器 origin |
| `--max-calls <n>` | 每条 WebSocket 链路的并发调用上限 |
| `--web-dist <dir>` | 用自己构建的外壳替换内置的那份 |

账号与会话始终生效：`--auth-db` 决定账户库位置，`--secure-cookies` 只影响 cookie 属性，不改变认证流程。

### 局域网 / Tailnet

```bash
pnpm start:tailnet   # 绑定 Tailscale IPv4，只从 tailnet 可达
pnpm start:lan       # 绑定 0.0.0.0，局域网与 tailnet 都可达
pnpm dev:tailnet     # 同上，带 --dev（校验每次 cell 写入）
pnpm dev:lan
```

`start:tailnet` 会用 `tailscale ip -4` 自动找地址并打印 `http://100.x.y.z:21315`
（有 MagicDNS 时也打印 `http://<node>.<tailnet>.ts.net:21315`）。这些脚本不再提供
`--allow-management`：远程管理就是用管理员账户登录。自定义端口：

```bash
pnpm start:tailnet -- --port 21316
```

**账号是强制的，但明文 HTTP 仍会泄露密码。** 绑定非回环地址时，登录密码经 HTTP 明文传输；
优先用 `start:tailnet`（tailnet 加密设备间传输），或自己套一个 HTTPS 反向代理并加
`--secure-cookies`。不要把 21315 转发到公网。

## 概念 · Concepts

| 词 | 一句话 |
|---|---|
| 平台 Platform | 拥有进程、端口、插件发现、切面装载、Web 切面目录、账户/会话、统一数据与外壳；不含任何功能语义 |
| 宿主 Host | Chord 创建的对象容器。这里有两个：服务端宿主与浏览器宿主；远程对象按主体各建一份 |
| 主体 Principal | Chord 里的调用者身份：`host`、`browser` 或 `user`（登录账户 + 会话 id） |
| 账户 Account / User | 可登录的用户：稳定 id、唯一用户名、角色（admin / user）；数据归属按 id 而非用户名 |
| 会话 Session | 一次登录的服务端记录；浏览器拿 `moonan_session` cookie，登出/改密码/改角色/删账户都会让它失效 |
| 账户数据库 AuthStore | 单独的 SQLite `auth.db`：用户、密码散列、会话；不属于插件数据，不参与导出 |
| 切面 Facet | 插件在某一种宿主里的那一半代码；身份是模块 URL，也是装载与重载的单位 |
| 契约 Contract | 用 JSON Schema 描述的、两端各写一份的对象说明（构建器来自 `@earendil-works/pi-schema`）；身份是指纹，不是模块实例 |
| 注册表 Registry | 插件贡献东西的唯一通道：键值表，整表随代码版本替换 |
| Web 切面目录 WebFacetCatalog | 平台公布给浏览器的唯一远程对象：已解析的切面、显示名、版本与错误 |
| 数据存储 DataStore | 按「所有者 + namespace」分区的统一数据：内嵌 SQLite 数据库，导出/导入只覆盖一个账户 |
| 数据所有者 Data owner | 分区键：登录账户是 `user:<uuid>`，平台记账是 `host`；两个 owner 可以用同一 namespace 而互不可见 |
| 面板 Panel | 浏览器里的一个顶层页面；`adminOnly` 决定外壳是否渲染它，服务端授权另算 |
| 模型提供商 ModelProviders | ai-gateway 自己定义并导出的服务端注册表：其他插件按 id 查找按账户的模型运行时 |

完整释义（含每个词的取舍与反例）见 [CONTEXT.md](CONTEXT.md)。

## 包 · Packages

| 包 | 职责 | 面向谁 |
|---|---|---|
| `@moonan_ai/sdk` | 通用契约、主体辅助函数、`DataCodecs`、浏览器钩子。根入口给两端与服务端用，`./web` 给浏览器切面用 | 插件作者 |
| `@moonan_ai/web`（private） | 浏览器外壳（登录/初始化、顶栏、按角色过滤面板）与共享运行时打包器；构建产物随 `@moonan_ai/moonan` 一起发布 | 平台自己 |
| `@moonan_ai/moonan` | 平台：服务端宿主、单端口网关、`moonan:data`、账户与会话、插件注册表/切面装载与 CLI | 使用者 |
| `@moonan_ai/ai-gateway` | 内置插件，也是独立发布的包：在「模型」标签页按账户配置 pi-ai 提供商与模型 | 使用者 |
| `@moonan_ai/plugin-manager` | 内置插件：在「插件」页启用/停用/添加/移除插件，在「用户」页管理账户（仅管理员） | 使用者 |

依赖方向是单向的：`moonan → sdk`、`web → sdk`、`sdk → chord + pi-schema`，官方插件 `ai-gateway → sdk + pi-ai`、`plugin-manager → sdk`。平台不导入任何插件代码，只把切面 URL 交给 Chord；官方插件只出现在平台 `package.json` 的 `optionalDependencies` 与 `moonan.officialPlugins` 清单里——`packages/platform/test/layering.test.ts` 盯着这条线。

Chord 锁定在 `1.5.0`（`sdk`、`web`、`moonan` 都依赖这一版），契约 schema 用 `@earendil-works/pi-schema` `1.5.0` 的构建器写；插件按同一版本对齐。插件数据与账户库都用 Chord 1.5.0 自带的 SQLite 层（`@earendil-works/chord/sqlite` + `@earendil-works/chord/sqlite/node`，底层是 Node 内置的 `node:sqlite`），不引入额外数据库依赖。

## 内置插件

### ai-gateway（「模型」页）

[`packages/ai-gateway`](packages/ai-gateway/README.md) 是仓库内置的模型网关面板。它把 pi-ai 的提供商、模型和请求参数搬进**每个账户各一份**的数据集（namespace `ai-gateway/config`）：

- 内置目录来自 `@earendil-works/pi-ai@1.5.0`：42 个提供商，添加时导入它们的对话模型目录。
- 自定义提供商支持 OpenAI 兼容、Anthropic、Google、Mistral、Bedrock、Vertex 等 API。
- 每个模型都能逐字段编辑：上下文、输出上限、价格与阶梯价、输入模态、输入限制、推理等级映射、
  提示缓存、采样参数、`compat` 兼容覆盖（按 API 从 pi-ai 的真实 schema 生成表单）、模型请求头。
- 「拉取模型」从上游的 `/models`（Anthropic `/v1/models`、Google `models`、Ollama `/api/tags`）
  读取目录；失败时按提供商回退到 pi-ai 内置目录，并把回退原因显示在面板上。
- 密钥、提供商、模型、该账户的请求默认值全部写在**当前登录账户**的数据集里（默认数据库
  `~/.moonan/data.db`，可用 `MOONAN_DATA_DB` 或 `--data-db` 改路径）。每个账户只能看到、导出自己的配置；
  管理员也不能通过 `/api/data/export` 拿到别人的密钥。数据库文件权限 `0600`，目录 `0700`；浏览器只拿到掩码。
- 面板不写 `localStorage`、`sessionStorage` 或 IndexedDB。

服务端契约是**按主体**（per principal）的远程对象：`AiGateway` 契约 v4 的每个实例绑定一个登录会话，
它的 `config` cell 是从该账户 `DataStore` 数据集的投影；换账户登录会得到另一组实例。服务端切面重载不会丢配置：
`DataStore` 是权威，cell 是投影；数据库的每次变更都是一个事务。「高级」页可以显式从当前账户的数据集重新加载；
数据库损坏时会隔离为 `data.corrupt-<ts>.db` 并从空库开始（不再有 `.bak` 备份或 JSON 文件恢复）。
其他服务端插件可以通过 `ModelProviders` 注册表按 id 取得模型运行时：`list(principal)` 是当前账户的 key-free
模型目录，`runtime(principal)` 是该账户的 `MutableModels`（含凭据，只在服务端用）。

### plugin-manager（「插件」「用户」页）

[`packages/plugin-manager`](packages/plugin-manager/README.md) 是管理插件：它提供两个只对管理员可见的面板。
「插件」面板列出每个插件的名称、版本、来源、启用/运行状态与解析错误，并提供启用、停用、添加（登记已安装的包或目录）与移除；
「用户」面板列出账户（用户名、角色、创建/更新时间），提供创建账户、重置密码、切换角色、删除账户，并标出当前登录的管理员。
两个面板都标记 `adminOnly`，普通用户看不到标签页；对应接口在服务端也只接受管理员（普通用户 403 `admin_required`）。

- **启用/停用立即生效**：服务端切面走一次 `host.reload`，浏览器切面随 `WebFacetCatalog` 上下线；重启后状态保持。
- **添加不是下载**：平台只登记已经安装在同一条安装树（或当前工作目录）里的包，以及本地目录；不会联网 `npm install`。失败时页面会给出可复制的修复提示。
- **移除只改加载清单**：不卸载 npm 包、不删目录；内置插件不能移除，但可以停用（管理页除外）。
- **账户管理**：创建/重置密码/改角色/删除都立即吊销该账户的会话与 Chord 对象；最后一个管理员不能被降级或删除；删除账户会同时清掉该账户的插件数据，清理失败时面板会显示警告。
- **恢复入口**：`moonan plugins list|add|enable|disable|remove` 直接编辑注册表，不启动服务器；启动失败时平台会降级为「只加载锁定插件」，让「插件」页仍能打开。内置插件不能 `remove`（每次启动都会重新合并官方默认），只能停用。

## 统一数据 · Unified data

平台把可导出的插件数据放在一个内嵌的 SQLite 数据库里（默认 `~/.moonan/data.db`，`--data-db` 或
`MOONAN_DATA_DB` 可改）。它由 Node 内置的 `node:sqlite` 打开（经 Chord 1.5.0 的
`@earendil-works/chord/sqlite/node`），没有独立的数据库进程；WAL + `synchronous=NORMAL`，
每次变更都在一个事务里（同目录会出现 SQLite 的 `-wal`/`-shm` 边车文件，属于数据库的一部分）。

数据库里的每个数据集由 **owner + namespace** 两个键确定：owner 是 `user:<账户 uuid>`，namespace 是插件自己的稳定名字。
`DataStore`（契约版本 3，数据库 schema 2）的每个方法都显式带 owner；旧版 schema 1 的行在升级时被丢弃，
不做旧数据迁移（本项目还没有需要保留的数据）。两个账户可以使用完全相同的 namespace 而互不可见。

插件注册 `DataCodecs` 后，自己的 namespace 才会进入**当前登录账户**的统一导出：

```bash
# 首次启动用浏览器创建管理员后，用 curl 登录并保存 cookie：
curl -c /tmp/moonan-cookies -H 'content-type: application/json' \
  -d '{"username":"admin","password":"<密码>"}' \
  http://127.0.0.1:21315/api/auth/login

curl -b /tmp/moonan-cookies http://127.0.0.1:21315/api/data/status
curl -b /tmp/moonan-cookies http://127.0.0.1:21315/api/data/export > moonan-data.json
curl -b /tmp/moonan-cookies -X POST http://127.0.0.1:21315/api/data/import \
  -H 'content-type: application/json' --data @moonan-data.json
```

导出默认省略 API Key；`?includeSecrets=1` 才包含明文。导入是原子的：未知 namespace、重复
namespace 或 codec 失败都会整批拒绝。导出/导入只作用于 cookie 对应的账户；管理员也没有「看别人数据」的接口。
未登录时以上端点返回 401 `unauthorized`。

账户库是另一个 SQLite 文件（默认 `~/.moonan/auth.db`，`--auth-db` 或 `MOONAN_AUTH_DB` 可改）：schema v1，
表 `moonan_users`（id、用户名、角色、scrypt 密码散列）与 `moonan_sessions`（token 散列、过期时间），
文件 `0600`、目录 `0700`。它**不在**统一导出里——导出包绝不能携带密码散列或会话。账户库损坏时启动直接失败
（不静默重建，否则会丢账户）；`data.db` 损坏仍保持原来的隔离行为。

数据数据库本身三张表：`moonan_data_datasets` 每行是一个 `(owner, namespace)` 数据集（`version`、JSON
`value`、`updated_at`，主键 `(owner, namespace)`）；`moonan_data_meta` 单行记录格式标识、store revision、
dataset 总数与最近保存时间；`moonan_data_schema` 记录数据库自己的迁移版本。数据库文件权限 `0600`、目录
`0700`；库损坏时保留为 `data.corrupt-<ts>.db`（连同 `-wal`/`-shm` 边车）并从空库开始，
`notice` 会显示在 ai-gateway 的存储信息里——不再有 `.bak` 备份或 JSON 文件恢复。

导出/导入仍是可移植的 JSON bundle（`format: "moonan.data"`，`formatVersion: 1`），只有存储引擎
和分区方式变了。这是破坏性变更：旧版全局数据（schema 1）不会被读取或迁移，旧版 JSON 数据文件也不会。

插件选择**不在**这份导出里：`plugins.json` 是引擎配置，故意独立于 `moonan:data`——否则导入一份
数据 bundle 就能改变进程下次加载哪些插件。

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

六条硬规则：

- **`hostNamed("moonan")`**：服务端只有一个宿主，名字就是这个。写别的名字，`serve` 会当场拒绝，启动直接失败。
- **契约两端各写一份**：浏览器切面拿不到服务端的模块；Chord 认指纹（名字、版本、成员、类型住在哪个宿主），不认模块实例。
- **注册表贡献必须来自 `{ lifetime: "host" }` 对象**：`Routes`、`Panels`、`DataCodecs`、`ModelProviders` 都一样。
- **浏览器切面是单个 ESM 文件**：浏览器没有模块 hook，重载只会换掉入口。
- **服务端按登录账户行动**：工厂的第二个参数是调用者主体（远程对象按主体各建一份）；HTTP 插件路由的
  `ctx.principal` 是登录用户。持久化时用 `dataOwner(principal)` 作 owner，别用用户名。
- **权限在服务端校验**：管理员能力用 `requireAdmin(ctx.principal)`；`PanelContribution.adminOnly` 只隐藏标签页，不是授权。

完整的插件写法（目录与包两种来源、`uses`、持久化、热重载、账户与数据隔离）见 [docs/plugins.md](docs/plugins.md)。

## 运行时边界 · Runtime boundaries

- **没有免登录模式。** 浏览器外壳的登录/初始化页是公开的；其余 `/api/*`、`/facets/*` 未登录返回 401 `unauthorized`，`/ws` 没有有效会话 cookie 直接拒绝。会话 cookie `moonan_session` 是 HttpOnly + SameSite=Lax、30 天；用 HTTPS 反代时加 `--secure-cookies`。登录失败按「来源地址 + 用户名」限流：15 分钟内 5 次失败后返回 429（带 `retryAfter`）。
- **首次初始化要在可信网络完成。** 账户库为空时，初始化页对任何能访问端口的人开放——先完成第一次管理员创建，再把端口开放给不可信网络；否则别人可以先设置管理员。
- **同源校验与 `--allow-origin` 是第二道门。** 它们只拒绝跨源浏览器，不是认证；命中的插件路由仍会拒绝浏览器跨站请求（`Sec-Fetch-Site: cross-site`，例如第三方页面的 `<img>`/`<form>`，或从其它站点进入的导航）；插件无法放行，显式 `--allow-origin` 的 origin 例外，非浏览器客户端不受影响。
- **插件管理接口与账户管理接口是管理员专属。** `/api/plugins`、`/api/plugins/reload`、`/api/v1/plugins*`、`/api/v1/users*` 只接受 `role: "admin"` 的登录会话：未登录 401 `unauthorized`，普通用户 403 `admin_required`；它们同样校验同源/跨站。没有 `--allow-management`，也没有「只读降级」——`/api/plugins` 现在是管理员诊断接口。插件管理能改变进程加载的代码，等同于本机代码执行入口。
- **登录之后，管理动作会吊销 Chord 对象。** 登出（只吊销当前会话）、改密码/改角色/删除账户（吊销该用户全部会话）都会调用 `host.invalidatePrincipal`：对应的远程对象与链路立刻失效，浏览器回到登录页；账户删除还会清掉该账户的插件数据集。
- **平台落三类持久化。** 可导出的插件数据在内嵌 SQLite 数据库 `~/.moonan/data.db`（`moonan:data`，按 owner 分区，`--data-db` 可改）；账户与会话在另一个 SQLite 数据库 `~/.moonan/auth.db`（`--auth-db` 可改，不参与导出）；「装哪些插件」在引擎配置 `~/.moonan/plugins.json`（`--plugins-file`，仍是 JSON）。备份要覆盖三处。
- **单宿主，启动失败会降级。** 所有服务端切面共享一个代码版本；一个切面在 `setup` 里抛错时，平台先整体启动失败，再自动用「只加载锁定插件」重试一次（registry 不改动），让「插件」页能打开并定位问题。`--safe-mode` 直接走这条恢复路径。账户库打不开则不会降级：认证是启动前提。
- **重载粒度是切面，不是插件。** `POST /api/plugins/reload` 重新解析入口，然后把**当前全部**服务端切面放进**一次** `host.reload` 重新 import（breaking 契约的提供方与消费方永远同批），再 `await host.ready()`；没有服务端切面时它也提交空批次，revision 照常 +1。启用/停用只把**新增/移除的切面**放进批次，未列出的切面继续运行。`/api/plugins/reload` 与 `/api/v1/plugins/reload` 是同一个管理策略（都要求管理员）。
- **浏览器不参与服务端提交。** 它靠 `WebFacetCatalog` 得知切面变化，只在 `web.url#hash` 变化时换自己的切面；服务端-only 的改动不会刷新页面。

## 文档 · Documentation

- [CONTEXT.md](CONTEXT.md) — 词汇表：平台、宿主、主体、账户、会话、插件、切面、契约、Web 切面目录、数据存储、注册表、面板
- [docs/architecture.md](docs/architecture.md) — 进程、一次登录/一次请求、一次装载、一次重载、一次广播的完整路径
- [docs/plugins.md](docs/plugins.md) — 写一个插件：来源、服务端切面、主体与用户数据、契约、浏览器切面、热重载
- [docs/release.md](docs/release.md) — 发布：版本真源、发布顺序、`latest` 策略、CI 与手动命令

## 开发 · Development

```bash
pnpm install
pnpm typecheck
pnpm build      # sdk → web（含 /runtime/*.js）→ moonan（内嵌 shell）
pnpm test       # 分层守护 + 打包守护 + 平台集成（认证、数据隔离、解析、装载、路由、面板、热重载）
pnpm dev        # build 后以 --dev 启动，官方插件（模型 + 插件/用户）自动加载
```

需要 Node.js ≥ 22.19。

## 状态 · Status

**多用户重构（breaking；本轮不升版本号，仍为 `0.1.0-alpha2`）**：新增账户/会话/角色与管理员专属的插件、账户管理；
Chord 主体进入平台（服务端按登录会话建远程对象）；`moonan:data` 升级到契约 v3 / 数据库 schema 2，按 `user:<id>` 分区，
旧数据丢弃、不迁移；ai-gateway 契约升到 v4，配置、密钥与模型按账户隔离；plugin-manager 增加「用户」面板。
没有未登录模式，也没有 `--allow-management` 或只读 `/api/plugins` 降级路径。

`0.1.0-alpha2`：契约 schema 从 TypeBox 换到 `@earendil-works/pi-schema`（Chord 1.5.0 的官方写法），`sdk` 不再导出 `Type`，改用 `obj`、`str`、`num`、`literal`、`record` 等构建器；契约 JSON 与指纹不变，旧页面只会整页刷新一次。平台建立在 Chord 之上，不含预设能力契约或功能语义；持久化分为插件数据、账户库与插件注册表三份。插件由切面组成；启停只重载新增/移除的切面，手动 reload 才重读全部服务端切面。

`0.0.5-alpha3`：平台建立在 Chord 之上，不含预设能力契约或功能语义；唯一的持久化是 `moonan:data` 统一数据。插件由切面组成；平台一次装载/重载全部服务端切面，启动失败即关闭宿主。

`sdk` / `moonan` / `ai-gateway` / `plugin-manager` 四个包发布到 npm（本版新增插件管理页与账户模型）；`ai-gateway` 在「模型」标签页按账户配置 pi-ai 的提供商与模型，
配置保存在该账户的 `ai-gateway/config` 数据集里，并通过 `ModelProviders` 暴露给其他服务端插件。AI 对话尚未回归——它会作为一个普通插件回来，和 `ai-gateway` 走同一条加载路径。

## 许可 · License

MIT
