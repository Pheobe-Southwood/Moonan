# 一次请求、一次装载、一次重载

这篇只讲路径：一个字节从哪进、经过谁、到哪出。概念的释义在 [CONTEXT.md](../CONTEXT.md)。

## 进程里有什么

```text
node packages/platform/bin/moonan.js
  │
  ├── Chord 宿主 "moonan"            ← 服务端宿主，名字必须和契约里的 hostNamed("moonan") 一致
  │     ├── 插件 A 的服务端切面
  │     ├── 插件 B 的服务端切面
  │     └── moonan:manifest 切面      ← 平台唯一自己装的切面
  │
  └── HTTP + WebSocket 服务（一个端口）
```

**只有一个进程，一个端口。** 没有独立的 UI 服务、没有反向代理、没有数据库进程。插件需要持久化就自己开自己的 SQLite 文件——平台不知道它开在哪。

## 一次装载

启动顺序是刻意的，顺序错了浏览器会拿到过期的清单：

```text
1. 收集插件引用
     --plugin <包名|目录>  ＋  plugins-dir 下的每个含切面入口的子目录
2. 逐个解析成切面模块 URL
     目录 → server.mjs / server.js 与 web.js / web.mjs（各自可选）
     包   → exports["."] 与 exports["./web"]（各自可选）
     失败 → 记在记录的 error 上，不抛出
3. 建宿主
4. 一次 host.load([...全部服务端切面 URL, manifest 切面])：
     先装完所有切面，再统一激活宿主对象
     manifest 切面同时提供 host-lifetime 的 ManifestStore 与远程 Manifest 视图
     成功 → 服务端切面 serverInstalled = true
     失败 → 关闭宿主，启动失败（不继续跑半装状态）
5. host.get(ManifestStore, {})：平台持有唯一的 store 引用，用于后续发布
6. host.get(Manifest, {}) 激活一次后立即 release；失败则启动失败
7. 开端口
```

manifest 切面与插件切面在**同一个** `host.load` 批次里：Chord 会先装完所有切面，再激活宿主对象，所以插件的 host-lifetime 对象可以在工厂里 `self.get(Manifest, {})`，不会因为清单“晚装一步”而得到 `unknown_type`。

第 4 步失败时**不**逐个 `host.reload` 去归因。Chord 的 `install` 不是回滚事务：一个 `setup` 在 `api.serve` 之后抛错，服务已经留在宿主里；继续运行会让平台看起来“其他插件正常”，实际上一个失败的插件仍在提供类型。Chord 的规矩是放弃启动时关闭宿主，平台照做。

## 一次请求

```text
浏览器 / curl
  │
  ├── /ws                     → WebSocket 升级 → chord 协议（对象调用走这里）
  ├── /api/plugins            → 内建：清单的 HTTP 视图
  ├── /api/plugins/reload     → 内建：POST 触发全量重载
  ├── /facets/<hash>/<file>   → 浏览器切面与其同目录资源（越界即 403）
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

## 一次重载

```text
POST /api/plugins/reload        ← 无 body；没有“按插件 ID”这回事
  │
  ├── 重新解析 refs       → 删除/改名的入口变成 remove 的 facet；web 内容 hash 重算
  ├── 全部服务端切面     → host.reload([...serverFacetUrls], { remove })；仅纯 web 变化（无服务端切面、无待移除切面）才跳过
  ├── chord 内部         → prepare → gate → commit → retire
  ├── 提交成功           → chord 的 code version +1，平台直接读 host.codeVersion
  ├── 应用新解析结果     → 原地更新 name / version / server / web / error
  ├── 等待新宿主对象     → host.ready()；激活失败在这里 reject（提交已经生效）
  ├── 发布快照           → store.update({ version, facets, revision })
  └── 响应 { ok, reloadBrowser, revision, report? }
```

`revision` 取自 **chord 的 code version**（`host.codeVersion`）：启动时是 1，每次提交 +1。它是 Moonan 的应用状态（spec §6 把 server `Manifest` 点名为浏览器了解变化的通道），不是 chord 被移除的 `Shape.codeVersion`，也不能当协议字段用。

`reloadBrowser` 说的是「浏览器切面集合或其内容变了」，不是「服务端 code version 变了」。它比较 reload 前后的 `webSignature`（每个 web facet 的 `url#hash`）：
- 只 reload 服务端切面：hash 不变 → `false`，浏览器不重载；
- 改了 web.js / 增删 web 切面：hash 变 → `true`；
- 纯前端插件没有服务端切面：`host.reload` 跳过，但仍发布新 hash，所以也能通过同一个 POST 更新。

### 官方信号 vs 平台信号

| 信号 | 谁裁决 | 动作 |
|---|---|---|
| 协议版本失配 | chord 链接层 | **整页刷新**（guide 的协议失配条款） |
| 插件契约失配 / `upgrade_required` | chord | **重载 web 切面**（官方补救就是 “reload its web facets”）。外壳在 Manifest 报告 web 切面变化时做；若没有任何切面变化，重载同一文件无意义——这是插件自身 web 代码与契约不同步 |
| 平台 Manifest 契约失配 | Moonan 例外 | **整页刷新**：外壳不是可重载切面，只有新壳能理解新 Manifest 契约 |
| web 模块内容变化（hash） | Moonan（内容层） | 触发 client-local `host.reload`；hash **不判断契约兼容**，那始终由 chord 裁决 |

chord 支持 `kind: "client"` 的宿主本地 reload 自己的切面（client-local code version 不跨父链接），浏览器不参与 cluster 重载协调。`host.reload` 在 prepare 阶段是事务性的：prepare 失败时旧代码保留、旧 `plugins` 列表也保留，下一次 Manifest 发布仍会重试。提交成功但 `host.ready()` 失败时，代码已经提交：平台照常发布清单，但把这次请求报成失败（400），不让“激活失败”伪装成“没重载”。

移除一个切面同样是一次 chord 提交（`host.reload([], { remove })`）：被移除类型的引用变 `gone`，`ReloadReport.removed` 给出类型名。移除 provider 不会让 prepare 失败——chord 对已移除的 service 跳过 `uses` 检查；消费方的引用会随之下线。

旧代码的根还在跑时，旧实现继续为它服务；根结束后，那一版才退休。这是 chord 自带的事务语义，平台没有额外做什么。

## 一次广播

`Manifest` 是远程对象，chord 按 principal 建实例：**宿主自己的一个，以及所有浏览器共用的一个**（`acceptWebSockets` 给每个连接同一个 principal——官方 WebSocket 测试也给所有已认证客户端同一个常量 principal；按连接区分是应用选择，不是 chord 要求）。所有实例共享同一个权威状态，平台不遍历、不复制：

```text
ManifestStore（local, lifetime: "host"）
  snapshot cell = { version, facets, revision }
        │  derive
        ├── version
        ├── facets
        └── revision
              ▲
              │ self.get(ManifestStore, {})
Manifest（remote, per principal）
  return { variant: "v1", version: store.version, facets: store.facets, revision: store.revision }
```

`publishManifest()` 只做一次 `store.update(...)`；Chord 负责把 store 的派生 state 以 snapshot/delta 推给每个 Manifest 引用。没有 `replicatedState`，没有每实例 `self.on`，也没有第二份 cell。

投递走 chord 的发布队列，**是异步的**：`POST /api/plugins/reload` 的 `revision` 直接取 `host.codeVersion`，不从 cell 读；也不要假定 `reload()` 返回时页面上的 cell 已经更新。

## 一次面板出现

```text
浏览器外壳启动
  │
  ├── 先建 link，再等 socket open（服务端的 hello 在 Connection 构造时就发出一次，link 建晚了就可能错过它——是顺序问题，不是网络问题）
  ├── 连 /ws，建 kind:"client" 宿主（整页只建一次）
  ├── host.hold(Manifest) → 引用立刻返回，可能仍是 loading
  ├── 一次 host.load([...web 切面 URL], { awaitHostObjects: false })
  │     ├── 装完记下签名（安装不是回滚事务）
  │     ├── host.ready() 等宿主对象激活
  │     └── 插件切面把自己注册进 Panels 注册表
  ├── 外壳订阅 Panels，按 order 排序渲染标签页
  └── Manifest.facets[].web.hash 变化 → host.reload(同批 URL, { remove })
        ├── resolve = 已提交 → 立即记下新签名
        └── host.ready() 失败只报横幅，不回滚（提交已是既成事实）
```

浏览器只比较 `web.url#hash`。服务端只改了服务端代码、web 文件没变时，hash 不变，浏览器不重载；改了 `web.js` 才会换。Manifest 的 `revision` 仍发布，但只作为诊断字段，不驱动重载。若 Manifest 本身因契约升级无法绑定，`useRemote` 会把它报成 fatal，外壳刷新页面——旧壳无法在不刷新页面的情况下理解新契约。插件面板不应该使用 `isFatalContractError` 把插件契约失配升级成整页刷新：官方补救是重载 web 切面，外壳会在 Manifest 报告切面变化时做；若切面没变而错误持续，那是插件的 web 代码与契约不同步，重载同一文件或整页刷新都修不了。

第一条值得单独说：**建 link 要在 socket `open` 之前**。服务端在 `Connection` 构造时就发 `hello`，晚挂的监听能不能看到它取决于运行时的事件循环——是竞态，不是保证；收不到 `hello` 的客户端不知道对端会 ack，于是自己从不发 ack，服务端的流控窗口再也不排空，表现为「状态不再到达」，而不是一条报错。提前建 link 是安全顺序，也没有代价：`webSocketLink` 在 open 前缓存出站帧，而帧要到达也总得先有它落脚的 link。

断线不重建宿主：`host.connect` 换掉 link，Chord 会把每个远程引用重新 hold，值在重新水合前保持可读（状态 `loading`）。浏览器切面与 `Panels` 注册表留在原地。

外壳从头到尾不知道任何一个具体面板是什么，也没导入过任何插件。它只知道有一个注册表，以及注册表里现在有什么。

插件模块里的 `import "react"`、`import "@moonan_ai/sdk/web"` 由 `index.html` 的 import map 解析到 `/runtime/*.js`。**这就是为什么插件不需要打包**：它的依赖由外壳预先提供，而且只有一份。多一份 React 会让 hooks 报错，多一份 Chord 会把两个协议与对象身份世界放进同一个页面——两种失败都表现为「面板没出现」，而不是一条报错。

## 运行时开关与安全边界

- `--dev`：让 chord 校验每次 cell 写入与暴露状态（`createHost({ dev: true })`）。默认关闭，与 chord 的默认一致；`pnpm dev` 会显式打开。
- `--allow-origin <origin>`：除同源外精确放行一个浏览器 origin（可重复）。WebSocket 与内建 `POST /api/plugins/reload` 都校验 `Origin`；无 `Origin` 的客户端（curl、测试、chord 官方 WebSocket 测试）不受影响，`Origin: null` 与畸形值被拒绝。
- `--max-calls <n>`：把 chord 的 `maxCalls` 接到每条 WebSocket 链路上；默认不设上限（chord 默认）。超过上限的调用得到 `unavailable/too_many_calls`，不可重试。
- 平台没有账号鉴权：同源/白名单只是拒绝跨源浏览器，不是安全边界。绑定非回环地址时，能访问端口的人仍可直接驱动所有插件。
- 插件路由的可重试错误：`upgrade_conflict`/`superseded` 在幂等方法上自动以新根重试一次；非幂等请求得到 `503` + `Retry-After`，由客户端决定是否重试。这是 HTTP 策略，不是 chord 规定；GET/HEAD 处理函数应按 HTTP 语义保持无副作用。
- 反向代理改写 `Host` 的部署不在同源校验支持范围内；用 `--allow-origin` 显式放行。
- 其余 chord 调参（`linger`、`readyTimeout`、`taskStopDeadline`、`window`/`pendingCap`）保持官方默认，平台不擅自改。chord 的 hold `origin` 是 wire 上的客户端连接 id，不是 HTTP `Origin`；当前常量 principal 不需要它。

## 零数据落在哪里

平台在运行时没有任何一行写磁盘的代码。没有 `moonan.db`，没有配置文件，没有 `.moonan/state.json`。`--plugins-dir` 是**只读**的扫描目录。

结果：卸载一个插件 = 删掉它的包和它自己的数据文件，平台侧没有残留需要清理。升级平台不会碰你的数据。把仓库整个删掉，除了插件自己的数据，什么都不会丢。

## 设计取舍

**单宿主，启动失败即退出。** 所有服务端切面都装在同一个 chord 宿主里，共享一个代码版本。Chord 的 `install` 不是回滚事务：一个切面在 `api.serve` 之后抛错，它的服务已经留在宿主里。所以启动阶段只有两种诚实的结果——全部成功，或关闭宿主退出；按插件隔离进程是另一个量级的改动（要连带 cluster reload、relay 授权、跨宿主契约），不在当前范围内。

**清单不提供旧契约的兼容适配。** `Manifest` 从 v2 升到 v3（`web` 从字符串变成 `{ url, hash }`）时没有写 `accepts` 适配器。旧外壳看不懂新契约，整页刷新才是诚实的补救；`accepts` 适合「新旧消费者并存于同一套外壳」，而这里外壳本身就随服务端一起部署。

**平台不提供持久化与鉴权。** 插件自己决定存什么、存在哪；端口就是信任边界，同源校验只挡跨源浏览器，不是账号体系。
