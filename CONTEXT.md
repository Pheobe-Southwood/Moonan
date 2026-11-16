# Moonan

一个本地运行、需要登录的插件工作台：平台提供宿主、网络、插件发现、切面装载、Web 切面目录、账户与按账户隔离的统一数据，所有功能——包括 AI 对话——都是插件。

## 语言

**工作台（Workbench）**
用户运行的那个本地应用：平台、插件与浏览器外壳的组合。
_Avoid_: 平台, platform

**平台（Platform）**
Moonan 的应用层：拥有进程、端口、插件发现、插件注册表、切面装载、Web 切面目录、账户与会话、统一数据与浏览器外壳。它不含功能语义：不知道对话、模型或面板是什么。
_Avoid_: 基座, substrate, 内核, kernel, 核心, core, 运行时, runtime, 宿主

**宿主（Host）**
Chord 创建的对象容器。平台运行时有两个：Node 侧的「服务端宿主」与浏览器侧的「浏览器宿主」。插件的两个切面分别装进这两个宿主。远程对象按主体（principal）各建一份实例，所以同一个服务端宿主里可能同时有多个账户的对象。
_Avoid_: 运行时, runtime, 实例

**主体（Principal）**
Chord 意义上的调用者身份，是应用定义的、可 JSON 序列化的值。Moonan 恰好有三种：`host`（平台自身代码与宿主级对象）、`browser`（浏览器宿主自身代码，服务端见不到）、`user`（已登录账户：账户 id、用户名、角色、服务端会话 id）。主体由服务端认证器盖章，客户端不能自报身份。
_Avoid_: 用户, user（不限定为登录账户时）, 身份, identity

**账户（Account / User）**
一个可登录的用户记录：稳定 id（UUID）、唯一且不区分大小写的用户名、角色、密码散列与时间戳。代码与 HTTP 接口里叫 user / `/api/v1/users`，WebUI 里叫「用户」。数据归属按 id，不按用户名——改名不丢数据。
_Avoid_: 会员, member, 登录名

**角色（Role）**
账户的权限等级：`admin` 或 `user`。只有管理员能使用插件管理与账户管理接口；角色写在服务端盖的主体的主体上，不信任客户端自报。最后一个管理员不能被降级或删除。
_Avoid_: 权限, permission, 权限组, 组, group

**会话（Session）**
一次登录在服务端的一条记录。浏览器持有 `moonan_session` cookie（HttpOnly、SameSite=Lax、30 天；HTTPS 反代后可用 `--secure-cookies` 加 Secure），服务端只存 token 的 SHA-256 散列。登出、改密码、改角色、删除账户都会让会话失效。会话 id 也在 Chord 的对象键里：新登录得到新的远程对象，同一次登录的两个标签页共享对象。
_Avoid_: 登录态, token, cookie（指会话本身时）

**账户数据库（AuthStore / auth.db）**
平台自己的 SQLite 账户库 `~/.moonan/auth.db`（`--auth-db` 或 `MOONAN_AUTH_DB` 可改）：用户、密码散列（scrypt）与会话；schema v1，文件 `0600`、目录 `0700`。它不属于插件数据：不参与 `/api/data/export`，损坏时启动失败而不是静默丢弃账户。
_Avoid_: 用户数据库, 账号库, user.db

**数据所有者（Data owner）**
`DataStore` 里的分区键：登录账户是 `user:<uuid>`，平台自己的记账数据是 `host`。所有读写、导出、导入都显式带 owner；两个 owner 可以用同一个 namespace 而互不可见。删除账户会清掉该 owner 的全部数据集。
_Avoid_: 用户, tenant, 租户

**插件（Plugin）**
一个可独立分发的功能：最多一个服务端切面与一个浏览器切面。目录或包只是分发方式；插件本身不是运行时单位。
_Avoid_: 模块, module, 扩展, extension, 组件

**切面（Facet）**
插件在某一种宿主里的那一半代码。切面的身份是模块 URL；平台装载与重载的单位是切面，不是插件。
_Avoid_: 半边, 部分, 入口, 模块

**契约（Contract）**
用 JSON Schema 描述的、可以在两端各自写一份的对象说明，构建器来自 `@earendil-works/pi-schema`。契约的身份是指纹（名字 + 版本 + 成员），不是模块实例。
_Avoid_: 接口, interface, API, 类型定义

**Web 切面目录（WebFacetCatalog）**
平台向浏览器公布的唯一远程对象：已解析插件的显示名、版本、来源（包 / 目录）、浏览器切面 `{ url, hash }` 与错误。浏览器据此决定加载哪些浏览器切面、以及何时因为内容 hash 变化而重载。只有一个 host-lifetime 的 `WebFacetCatalogStore` 持有权威状态，每个 `WebFacetCatalog` 只是它的远程视图；目录对每个登录会话内容相同（它不承载账户数据），面板是否渲染由外壳的 `adminOnly` 过滤，真正的授权在服务端接口。
_Avoid_: 清单, manifest, 插件列表, 配置, config

**数据存储（DataStore）**
平台唯一的插件数据服务，落在内嵌的 SQLite 数据库 `~/.moonan/data.db` 里；local、host-lifetime。数据集按「数据所有者 + namespace」分区，`read`/`write`/`update`/`remove`/`exportAll`/`importAll` 都显式带 owner；`DataStore` 负责事务化写入、数据库迁移、revision，库损坏时隔离为 `data.corrupt-<ts>.db` 并从空库开始。它不知道任何插件的 schema。旧版（schema 1）数据在升级到 schema 2 时被丢弃，不做迁移。
_Avoid_: data.json, JSON 文件, JSON file, 数据文件, 配置文件, config file, 共享数据

**数据集（Dataset）**
`DataStore` 中一个所有者名下的命名 JSON 值：`{ value, version }`。namespace 是稳定字符串（建议 `包名/数据集`），version 属于数据本身，不属于 Chord 契约。
_Avoid_: 表, table, 文档, document

**数据编解码器（DataCodec）**
插件贡献到 `DataCodecs` 注册表的导出/导入逻辑：当前版本、`migrate`、`export`（负责脱敏）、`import`（负责校验/合并）。平台按 owner + namespace 调用，不理解内容；codec 本身看不到 owner，只看到该 owner 的值。
_Avoid_: 序列化器, serializer, 迁移器, migrator

**插件注册表（Plugin Registry）**
引擎配置 `~/.moonan/plugins.json`：一组 `{ ref, enabled }`，决定进程启动时加载谁。它**不是** Chord 的 Registry（后者是插件贡献的键值表）；这里“注册表”只是文件名沿用。官方默认由平台 `package.json` 的 `moonan.officialPlugins` 给出，`builtin`/`locked` 是派生值，不落盘。
_Avoid_: Chord 注册表, Registry（不加限定语时）

**插件地址（ref）**
一个插件的分发地址：npm 包名，或目录的绝对路径。它是注册表与管理接口的键，不是运行时身份；运行时身份仍是切面模块 URL。`--plugin` 与目录扫描产生 ephemeral 条目，不写入注册表。
_Avoid_: 插件 ID, plugin id

**模型提供商（ModelProvider）**
ai-gateway 包定义并导出的 `ModelProviders` 注册表的一项：`id`、`title`、key-free 的 `list(principal)` 与 server-only 的 `runtime(principal)`，两者都是异步的、按传入账户读该账户的配置。ai-gateway 用它暴露 pi-ai 的 `MutableModels`；消费者按 id 查找，不直接依赖插件内部。
_Avoid_: 模型列表, model list, 供应商, vendor

**注册表（Registry）**
插件**贡献**东西的唯一通道：键值表，整表随代码版本替换。平台只按名字读取，永远不知道是谁注册的。`Routes`、`Panels`、`DataCodecs`、`ModelProviders` 都是注册表。
_Avoid_: 钩子, hook, 事件总线, 回调

**路由注册表（Routes）**
服务端注册表，键是 `"GET /path"` 或 `"/path"`，值是 HTTP 处理函数。插件用它扩展平台的 HTTP 端点；处理函数拿到的 `ctx.principal` 是这次请求的登录账户。
_Avoid_: 控制器, 中间件, 接口层

**面板（Panel）**
浏览器里的一个顶层页面：标题是纯字符串，内容是组件，顺序由 `order` 决定，`adminOnly` 决定外壳是否渲染它。平台不认识任何具体面板。
_Avoid_: 页面, page, 标签页, tab, 视图

**面板注册表（Panels）**
浏览器宿主上的注册表。浏览器切面把面板注册进去，外壳只负责按 `order` 排序、按当前账户角色过滤 `adminOnly` 并渲染。`adminOnly` 只是界面隐藏，不是授权：面板调用的接口必须在服务端再校验角色。
_Avoid_: 路由表, 菜单

**共享运行时（Shared Runtime）**
平台预先打好的 React、Chord、pi-schema 与 SDK 各一份 ESM。多一份 React 会让 hooks 报错；多一份 Chord 会让页面里出现第二个协议与对象身份世界（注册表按**名字**认表，同名不会因此失配，但两个宿主的对象互不可见）。
_Avoid_: vendor, 依赖包, 外部依赖

**插件来源（Plugin source）**
插件从哪儿来：已安装的 npm 包，或磁盘上的一个目录。两者都只是通向切面模块 URL 的一条路。
_Avoid_: 安装位置, 路径

**根（Root）**
一次短调用树。HTTP 请求进来、面板发一次调用、任务的每一次回调，都在自己的根里跑完。根绑定代码版本与主体，所以热重载时旧根跑旧代码，请求里看到的注册表也是发起时那一版。
_Avoid_: 事务, 请求上下文

**代码版本（Code version）**
一次重载提交后的一整套实现与注册表。宿主同时最多保留当前与上一版，旧根跑完即退休。
_Avoid_: 代数, 代次, generation, epoch
