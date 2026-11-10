# 一次请求、一次装载、一次重载

这篇只讲路径：一个字节从哪进、经过谁、到哪出。概念的释义在 [CONTEXT.md](../CONTEXT.md)。

## 进程里有什么

```text
node packages/platform/bin/moonan.js
  │
  ├── Chord 宿主 "moonan"            ← 服务端宿主，名字必须和契约里的 hostNamed("moonan") 一致
  │     ├── moonan:data 切面          ← DataStore + DataCodecs 视图（local）
  │     ├── moonan:web-facets 切面    ← WebFacetCatalogStore + WebFacetCatalog（local + remote）
  │     ├── 插件 A 的服务端切面
  │     └── 插件 B 的服务端切面
  │
  ├── ~/.moonan/data.json             ← 统一数据文件（可由 --data-file 改）
  ├── ~/.moonan/plugins.json          ← 插件注册表：哪些 ref 启用（引擎配置，不参与导出）
  └── HTTP + WebSocket 服务（一个端口）
```

**只有一个进程，一个端口。** 没有独立的 UI 服务、没有反向代理、没有数据库进程。平台有两类落盘：统一数据文件（插件数据，可导出/导入）与插件注册表（引擎配置，决定启动时加载谁）。插件仍可为缓存或二进制资产开自己的文件，但那些文件不属于统一导出。两种文件都走 `data.ts` 的临时文件 + fsync + rename 原子写。

## 一次装载

启动顺序是刻意的，顺序错了浏览器会拿到过期的目录：

```text
1. 读插件注册表（plugins.json；损坏 → .bak → 隔离 .corrupt-* + 警告）
2. 合并条目
     注册表意图 ＋ 缺失的官方默认（builtin/locked 来自 moonan.officialPlugins）
     ＋ --plugin（ephemeral）＋ --plugins-dir 扫描（ephemeral）
     --safe-mode → 只保留 locked 官方条目，忽略注册表
3. 逐个解析成切面模块 URL（含停用条目，用于展示错误/版本）
     目录 → server.mjs / server.js 与 web.js / web.mjs（各自可选）
     包   → exports["."] 与 exports["./web"]（各自可选）
     失败 → 记在记录的 error 上，不抛出
4. 建宿主
5. 一次 host.load([data 切面, web-facets 切面, ...启用的服务端切面 URL])：
     先装完所有切面，再统一激活宿主对象
     data 切面提供 host-lifetime 的 DataStore
     web-facets 切面同时提供 WebFacetCatalogStore 与远程 WebFacetCatalog
     失败 → 关闭宿主
6. 失败且存在非锁定条目 → 记录错误，用「只隔离全部非锁定条目」重试一次
     （注册表不改动；成功则 startup.degraded=true，被隔离条目 startupSkipped=true）
     仍失败 → 抛出原始错误
7. host.get(DataStore, {}) / host.get(WebFacetCatalogStore, {})：平台持有引用
8. host.get(WebFacetCatalog, {}) 激活一次后立即 release；失败则启动失败
9. 开端口；GET /api/v1/plugins 发布完整快照
```

`moonan:data`、`moonan:web-facets` 与插件切面在**同一个** `host.load` 批次里：Chord 会先装完所有切面，再激活宿主对象，所以插件的 host-lifetime 对象可以在工厂里 `self.get(DataStore, {})` / `self.get(WebFacetCatalog, {})`，不会因为“晚装一步”而得到 `unknown_type`。

第 5 步失败时**不**逐个 `host.reload` 去归因。Chord 的 `install` 不是回滚事务：一个 `setup` 在 `api.serve` 之后抛错，服务已经留在宿主里；继续运行会让平台看起来“其他插件正常”，实际上一个失败的插件仍在提供类型。Chord 的规矩是放弃启动时关闭宿主，平台照做。

第 6 步是恢复策略，不是“假装没坏”：失败事实写进日志和 `/api/v1/plugins.startup`，被隔离的条目仍然 `enabled: true`（配置意图没变），只是 `startupSkipped`。直接重新启动会再试一次；用户可以在「插件」页逐个启用（启用是事务性的，失败不破坏现状），或 `moonan plugins disable <ref>` 改注册表，或 `--safe-mode` 进恢复壳。

## 一次请求

```text
浏览器 / curl
  │
  ├── /ws                     → WebSocket 升级 → chord 协议（对象调用走这里）
  ├── /api/plugins            → 内建：插件列表的 HTTP 视图（只读，不受管理开关限制）
  ├── /api/plugins/reload     → 内建：POST 重新解析并重载当前全部服务端切面（管理策略同 /api/v1）
  ├── /api/data/status        → 内建：DataStore.storage
  ├── /api/data/export        → 内建：GET 导出；?includeSecrets=1 才含明文
  ├── /api/data/import        → 内建：POST 原子导入
  ├── /facets/<hash>/<file>   → 浏览器切面与其同目录资源（越界即 403）
  ├── 插件路由                 → 浏览器跨站请求（Sec-Fetch-Site: cross-site）先被 403 拒绝
  ├── /api/*（未命中）         → JSON 404；不回落到 SPA
  ├── 其它                     → Routes 注册表："GET /path" 优先，其次 "/path"
  └── 仍未命中                → 外壳静态文件；不是文件就回 index.html（前端路由）
```

`Routes` 的查找发生在 `host.root()` 里，并且根跟着这次 HTTP 响应的生命周期：

```ts
const controller = new AbortController();
response.on("close", () => {
	if (!response.writableEnded) controller.abort();
});
const handled = await host.root(
	async (ctx) => {
		const view = host.registry(Routes);
		const handler = view.get(`${method} ${pathname}`, ctx) ?? view.get(pathname, ctx);
		if (!handler) return false;
		await handler(request, response, ctx);
		return true;
	},
	{ signal: controller.signal },
);
```

绑定到一个根，意味着这次请求看到的是**一个特定代码版本**的注册表。重载期间进来的请求要么用旧版跑完，要么用新版——不会看到半新半旧的表。客户端断开时 `ctx.signal` 会 abort，插件的嵌套调用随根一起取消，而不是继续为一个没人读的响应工作。

`/api/data/export` 与 `/api/data/import` 同样在 `host.root` 里调用 `DataStore`，所以 `DataCodecs.table(ctx)` 看到的是这次请求对应代码版本的 codec 表；`/api/data/status` 只读 `DataStore.storage` 这个 state 成员，不经过根。

## 一次重载 / 一次插件启停

```text
POST /api/plugins/reload 或 /api/v1/plugins/reload   ← 手动：重载当前全部服务端切面
POST /api/v1/plugins/{enable,disable,install,remove}   ← 管理接口：只重载变动的切面
  │
  ├── 串行队列             → 同一进程内一次只跑一个 mutation
  ├── 候选条目             → 注册表意图（启用的 ref 集合）
  ├── 重新解析全部条目     → 删除/改名的入口变成 remove 的 facet；web 内容 hash 重算；停用条目也解析，用于展示错误
  ├── next / added / removed → next = 启用且未隔离且无 error 的 server URL；added = next - installed；removed = installed - next
  ├── 手动 reload          → host.reload([...next])：重读全部当前期望的服务端模块；零切面也提交 host.reload([])
  ├── 管理 mutation        → host.reload([...added], { remove })；两者都空（纯 web 变化）则不提交
  ├── chord 内部           → prepare → gate → commit → retire
  ├── 提交成功             → chord 的 code version +1，平台直接读 host.codeVersion；替换已发布条目与 installed
  ├── 等待宿主对象         → host.ready()；激活失败在这里 reject（提交已经生效，仍发布/持久化）
  ├── 发布快照             → catalogStore.update({ version, facets: 启用的, revision })
  └── 管理 mutation 成功   → 写回 plugins.json（原子替换）
```

`/api/v1/plugins/reload` 与管理 mutation 走同一条 `sync`：管理动作只是先把候选条目改成“目标意图”，
再进入同一事务。区别只在批次内容——管理 mutation 只把 added（以及 removed）交给 chord，未列出的已安装
切面继续运行；手动 reload 把当前全部服务端切面重新列一遍，因为只有重新 import 才能发现磁盘上的模块被
改过，breaking contract 的 provider 与 consumer 因此总在同一批里。零服务端切面的手动 reload 仍提交
`host.reload([])`：code version +1，作为「这次 reload 确实执行了」的信号。停用条目不会出现在 catalog 里，
也不会被 `/facets/*` 服务。

`revision` 取自 **chord 的 code version**（`host.codeVersion`）：启动时是 1，每次提交 +1。它是 Moonan 的应用状态，不是 chord 被移除的 `Shape.codeVersion`，也不能当协议字段用。

`reloadBrowser` 说的是「启用中的浏览器切面集合或其内容变了」，不是「服务端 code version 变了」。它比较 reload 前后启用条目的 `webSignature`（每个 web facet 的 `url#hash`；停用/隔离条目不参与）：

- 只 reload 服务端切面：hash 不变 → `false`，浏览器不重载；
- 改了 web.js / 增删 web 切面：hash 变 → `true`；
- 纯前端插件没有服务端切面：管理启停不触发 chord 提交（`host.reload` 跳过），但仍发布新 hash；手动 `/reload` 例外——它提交空批次让 `revision` +1（「提交已发生」的信号，不是「切面变了」）。

`moonan:data` 与 `moonan:web-facets` 不在插件 reload 批次里：它们的契约/实现保持，插件 reload 只替换插件切面以及 `DataCodecs`、`ModelProviders` 等注册表；`ModelProviders` 由 ai-gateway 自己定义，平台不参与。平台 facet 改代码需要重启进程。

### 官方信号 vs 平台信号

| 信号 | 谁裁决 | 动作 |
|---|---|---|
| 协议版本失配 | chord 链接层 | **整页刷新**（guide 的协议失配条款） |
| 插件契约失配 / `upgrade_required` | chord | **重载 web 切面**（官方补救就是 “reload its web facets”）。外壳在 WebFacetCatalog 报告 web 切面变化时做；若没有任何切面变化，重载同一文件无意义——这是插件自身 web 代码与契约不同步 |
| 平台 WebFacetCatalog 契约失配 | Moonan 例外 | **整页刷新**：外壳不是可重载切面，只有新壳能理解新契约 |
| web 模块内容变化（hash） | Moonan（内容层） | 触发 client-local `host.reload`；hash **不判断契约兼容**，那始终由 chord 裁决 |

chord 支持 `kind: "client"` 的宿主本地 reload 自己的切面（client-local code version 不跨父链接），浏览器不参与 cluster 重载协调。`host.reload` 在 prepare 阶段是事务性的：prepare 失败时旧代码保留、旧 `plugins` 列表也保留，下一次 WebFacetCatalog 发布仍会重试。提交成功但 `host.ready()` 失败时，代码已经提交：平台照常发布目录，但把这次请求报成失败（400），不让“激活失败”伪装成“没重载”。

移除一个切面同样是一次 chord 提交（`host.reload([], { remove })`）：被移除类型的引用变 `gone`，`ReloadReport.removed` 给出类型名。移除 provider 不会让 prepare 失败——chord 对已移除的 service 跳过 `uses` 检查；消费方的引用会随之下线。

旧代码的根还在跑时，旧实现继续为它服务；根结束后，那一版才退休。这是 chord 自带的事务语义，平台没有额外做什么。

## 一次广播

`WebFacetCatalog` 是远程对象，chord 按 principal 建实例：**宿主自己的一个，以及所有浏览器共用的一个**（`acceptWebSockets` 给每个连接同一个 principal——官方 WebSocket 测试也给所有已认证客户端同一个常量 principal；按连接区分是应用选择，不是 chord 要求）。所有实例共享同一个权威状态，平台不遍历、不复制：

```text
WebFacetCatalogStore（local, lifetime: "host"）
  snapshot cell = { version, facets, revision }
        │  derive
        ├── version
        ├── facets
        └── revision
              ▲
              │ self.get(WebFacetCatalogStore, {})
WebFacetCatalog（remote, per principal）
  return { variant: "v1", version: store.version, facets: store.facets, revision: store.revision }
```

`publishWebFacetCatalog()` 只做一次 `store.update(...)`；Chord 负责把 store 的派生 state 以 snapshot/delta 推给每个 WebFacetCatalog 引用。没有 `replicatedState`，没有每实例 `self.on`，也没有第二份 cell。

投递走 chord 的发布队列，**是异步的**：`POST /api/plugins/reload` 的 `revision` 直接取 `host.codeVersion`，不从 cell 读；也不要假定 `reload()` 返回时页面上的 cell 已经更新。

## 一次面板出现

```text
浏览器外壳启动
  │
  ├── 先建 link，再等 socket open（服务端的 hello 在 Connection 构造时就发出一次，link 建晚了就可能错过它——是顺序问题，不是网络问题）
  ├── 连 /ws，建 kind:"client" 宿主（整页只建一次）
  ├── host.hold(WebFacetCatalog) → 引用立刻返回，可能仍是 loading
  ├── 第一批：一次 host.load([...web 切面 URL])
  │     ├── chord 先装完所有切面，再等它们的 host 对象激活
  │     ├── 安装不是回滚事务：激活失败也记下这一批，页面走恢复路径
  │     └── 插件切面把自己注册进 Panels 注册表
  ├── 外壳订阅 Panels，按 order 排序渲染标签页
  └── WebFacetCatalog.facets[].web.hash 变化 → host.reload(只列变动的 URL, { remove })
        ├── 没列出的切面继续运行；resolve = 已提交 → 立即记下新签名
        └── host.ready() 失败只报横幅，不回滚（提交已是既成事实）
```

浏览器只比较 `web.url#hash`。服务端只改了服务端代码、web 文件没变时，hash 不变，浏览器不重载；改了 `web.js` 才会换。WebFacetCatalog 的 `revision` 仍发布，但只作为诊断字段，不驱动重载。若 WebFacetCatalog 本身因契约升级无法绑定，`useRemote` 会把它报成 fatal，外壳刷新页面——旧壳无法在不刷新页面的情况下理解新契约。插件面板不应该使用 `isFatalContractError` 把插件契约失配升级成整页刷新：官方补救是重载 web 切面，外壳会在 WebFacetCatalog 报告切面变化时做；若切面没变而错误持续，那是插件的 web 代码与契约不同步，重载同一文件或整页刷新都修不了。

第一条值得单独说：**建 link 要在 socket `open` 之前**。服务端在 `Connection` 构造时就发 `hello`，晚挂的监听能不能看到它取决于运行时的事件循环——是竞态，不是保证；收不到 `hello` 的客户端不知道对端会 ack，于是自己从不发 ack，服务端的流控窗口再也不排空，表现为「状态不再到达」，而不是一条报错。提前建 link 是安全顺序，也没有代价：`webSocketLink` 在 open 前缓存出站帧，而帧要到达也总得先有它落脚的 link。

断线不重建宿主：`host.connect` 换掉 link，Chord 会把每个远程引用重新 hold，值在重新水合前保持可读（状态 `loading`）。浏览器切面与 `Panels` 注册表留在原地。

外壳从头到尾不知道任何一个具体面板是什么，也没导入过任何插件。它只知道有一个注册表，以及注册表里现在有什么。

插件模块里的 `import "react"`、`import "@moonan_ai/sdk/web"` 由 `index.html` 的 import map 解析到 `/runtime/*.js`。**这就是为什么插件不需要打包**：它的依赖由外壳预先提供，而且只有一份。多一份 React 会让 hooks 报错，多一份 Chord 会把两个协议与对象身份世界放进同一个页面——两种失败都表现为「面板没出现」，而不是一条报错。

## 统一数据

```text
ai-gateway 服务端切面
  │ self.get(DataStore, {}) + uses: [DataStore]
  ▼
DataStore（local, lifetime: "host"）
  resource: DataFile（~/.moonan/data.json）
  storage cell / revision cell
  read / update / write / remove / reload / exportAll / importAll
  │ DataCodecs.table(ctx)
  ▼
ai-gateway/config  dataset { value, version }
  dataCodec: migrate / export / import
```

- `DataStore` 是权威；插件自己的 Chord cell 是投影，初始化时读 `read`，导入/外部 reload 后通过 `data.revision` listener 重新加载。
- `read` 返回 `{ value, version }`，不查 codec：插件可能在 codec 注册发布前就执行 `config` 的 `init`，所以由插件自己校验/迁移第一个值。
- `update` 在 `DataFile` 的串行队列里完成读改写；`importAll` 也走同一个队列，所以导入和插件写不会交错。
- `write` 是整值替换；`update` 才是推荐的读改写入口。
- `exportAll` 只导出有 codec 的 dataset；没有 codec 的 namespace 放进 `skipped`。`importAll` 要求每个 dataset 都有 codec，任一失败都不写文件。
- `includeSecrets` 默认 `false`。ai-gateway 的 codec 默认删掉 `apiKey`/`keyUpdatedAt`，导入时再按 provider id 从当前数据里补回；显式 `?includeSecrets=1` 才导出明文。
- 文件损坏时先试 `.bak`；再不行把主文件保留为 `.corrupt-<timestamp>.json`，从空数据开始；`notice` 会显示在 ai-gateway 的存储信息里。

## 插件注册表

```text
~/.moonan/plugins.json
  { format: 1, plugins: [{ ref, enabled }] }
        │ 启动前读取
        ▼
条目合并（+ 官方默认 + --plugin/scan）→ 解析 → host.load
        ▲
        │ 管理 mutation 成功后原子写回
插件管理面板 / CLI
```

- **为什么不放进统一数据文件**：启动顺序（建宿主之前就要知道加载谁）与安全边界（导入数据不能改变加载哪些插件）。代价是“备份”分两处：`data.json` 管插件数据，`plugins.json` 管插件选择；导出/导入只覆盖前者。
- `builtin`/`locked` 是派生值，不落盘；官方插件清单在平台 `package.json`。
- 文件损坏 → `.bak` → `.corrupt-*` + 官方默认；恢复提示通过 `/api/v1/plugins.warning` 显示在管理页。
- 两个 Moonan 实例共享同一文件时没有跨进程锁，按原子写“最后写入者胜”；这是单进程本地工具的已知边界。

## 运行时开关与安全边界

- `--dev`：让 chord 校验每次 cell 写入与暴露状态（`createHost({ dev: true })`）。默认关闭，与 chord 的默认一致；`pnpm dev` 会显式打开。
- `--allow-origin <origin>`：除同源外精确放行一个浏览器 origin（可重复）。WebSocket 与内建 `POST /api/plugins/reload`、`/api/data/*` 都校验 `Origin`；`/api/plugins/reload` 与 `/api/v1/plugins*` 还先受管理开关限制。无 `Origin` 的客户端（curl、测试）不受影响，`Origin: null` 与畸形值被拒绝。
- 插件 HTTP 路由拒绝浏览器跨站请求：命中的插件路由在调用前检查 `Sec-Fetch-Site`，浏览器的 `cross-site` 请求（第三方页面里的 `<img>`、`<form>`、iframe，以及从其它站点进入的顶层导航）得到 `403`，包括有副作用的 GET。非浏览器客户端不发送该头，接口调用不受影响。这是平台级拒绝，插件无法放行；显式 `--allow-origin` 放行的 origin 例外（与其他内建端点的信任一致），插件仍可自行校验自己接受的 `Origin`/cookie。这是平台策略，不是 chord 规定。
- `--max-calls <n>`：把 chord 的 `maxCalls` 接到每条 WebSocket 链路上；默认不设上限（chord 默认）。超过上限的调用得到 `unavailable/too_many_calls`，不可重试。
- `--data-file <path>`：统一数据文件路径；也可用 `MOONAN_DATA_FILE`，默认 `~/.moonan/data.json`。
- `--plugins-file <path>`：插件注册表路径；也可用 `MOONAN_PLUGINS_FILE`，默认 `~/.moonan/plugins.json`。
- `--allow-management`：非回环绑定时默认关闭 `/api/v1/plugins*`（403 `management_disabled`）；显式开启后仍校验同源/跨站。管理接口能改变进程加载的代码，等价于本机代码执行入口。
- 启动降级与 `--safe-mode`：见「一次装载」。
- 平台没有账号鉴权：同源/白名单只是拒绝跨源浏览器，不是安全边界。绑定非回环地址时，能访问端口的人仍可直接驱动所有插件，也能导出/导入数据。
- 插件路由的可重试错误：`upgrade_conflict`/`superseded` 在幂等方法上自动以新根重试一次；非幂等请求得到 `503` + `Retry-After`，由客户端决定是否重试。这是 HTTP 策略，不是 chord 规定；GET/HEAD 处理函数应按 HTTP 语义保持无副作用。

## 设计取舍

**单宿主，启动失败先降级再退出。** 所有服务端切面都装在同一个 chord 宿主里，共享一个代码版本。Chord 的 `install` 不是回滚事务：一个切面在 `api.serve` 之后抛错，它的服务已经留在宿主里。所以启动阶段有两种诚实的结果——全部成功，或关闭宿主后以「只加载锁定官方插件」再试一次；仍失败才退出。隔离粒度的上限是“隔离所有非锁定条目”，不是进程级隔离（那要连带 cluster reload、relay 授权、跨宿主契约）。

**插件注册表独立于统一数据。** 注册表是引擎配置：启动前就要读、不能由数据导入改变。代价是用户要备份两份文件，且 `plugins.json` 没有跨进程锁。把选择放进 `moonan:data` 会让启动变成两阶段（先建宿主才能读数据），破坏插件在激活期就能 `self.get(DataStore)` / `self.get(WebFacetCatalog)` 的保证。

**管理接口是 HTTP，不是 Chord 对象。** 启停要提交 reload，reload 会等待根结束（gate/retire 各有默认 5 秒期限）。超期时 Chord abort 的是**这次 reload**（`aborted/gate_deadline`，错误里列出阻塞的根），retire 超期则 abort 旧代码版本的根（`superseded`）；驱动 reload 的那次调用属于旧版本，会随之中断并以失败告终，但不会永久自锁。控制面留在 HTTP 处理路径，数据面（浏览器切面）继续走 `WebFacetCatalog`。

**WebFacetCatalog 不提供旧契约的兼容适配。** 这是一次重命名后的新契约（`moonan.web-facets` v1），不写 `accepts`。旧外壳看不懂新契约，整页刷新才是诚实的补救；`accepts` 适合「新旧消费者并存于同一套外壳」，而这里外壳本身就随服务端一起部署。

**平台只提供统一数据，不提供功能语义。** `moonan:data` 只存 namespace + version + JSON，不校验插件 schema；schema/version/migrate/脱敏由 `DataCodec` 负责。这样平台仍然不知道对话、模型或面板是什么，同时导出/导入有一个统一的原子边界。

**卸载插件不会自动删除数据。** 统一数据文件里的 namespace 会保留；导出时没有 codec 的 dataset 会进入 `skipped`。需要清理时用 `DataStore.remove`（目前没有 UI），或手动编辑/重建数据文件。
