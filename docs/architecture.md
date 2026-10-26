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
  ├── 全部服务端切面     → host.reload([...serverFacetUrls])（没有服务端切面则跳过）
  ├── chord 内部         → prepare → gate → commit → retire
  ├── 提交成功           → chord 的 code version +1，平台直接读 host.codeVersion
  ├── 等待新宿主对象     → host.ready()；激活失败在这里 reject
  ├── 重算 web hash      → refreshWebHashes(plugins)
  ├── 发布快照           → store.update({ version, facets, revision })
  └── 响应 { ok, reloadBrowser, revision, report? }
```

`revision` 就是 **chord 的 code version**（`host.codeVersion`）：启动时是 1，每次提交 +1。平台不自己数一个整数——那份信息 chord 本来就有，而且 `ReloadReport.codeVersion` 已经在响应里。

`reloadBrowser` 说的是「浏览器切面集合或其内容变了」，不是「服务端 code version 变了」。它比较 reload 前后的 `webSignature`（每个 web facet 的 `url#hash`）：
- 只 reload 服务端切面：hash 不变 → `false`，浏览器不重载；
- 改了 web.js / 增删 web 切面：hash 变 → `true`；
- 纯前端插件没有服务端切面：`host.reload` 跳过，但仍重算 hash 并发布，所以也能通过同一个 POST 更新。

浏览器不参与 chord 的 **cluster** 重载协调，但 `kind: "client"` 的宿主可以本地 reload 自己的切面（代码版本不跨连接传播）——chord 对过期契约的补救也正是「reload its web facets」。整页刷新只留给协议版本失配和 Manifest 契约不匹配。

`host.reload` 在 prepare 阶段是事务性的：如果 provider 与 consumer 的契约对不上，且 consumer 不在这一批里，reload 会被拒绝，旧代码保留。平台总是把全部服务端切面放进同一批，所以 breaking contract 的 provider 和 consumer 不会分开。提交失败时不刷新 web hash，也不发布新 revision。

旧代码的根还在跑时，旧实现继续为它服务；根结束后，那一版才退休。这是 Chord 自带的事务语义，平台没有额外做什么。

## 一次广播

`Manifest` 是远程对象，chord 按 principal 建实例：**宿主自己的一个，以及所有浏览器共用的一个**（`acceptWebSockets` 给每个连接同一个 principal）。但所有实例共享同一个权威状态，平台不遍历、不复制：

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
  ├── 先建 link，再等 socket open（服务端的 hello 在建连时就发出，晚订阅就永远收不到）
  ├── 连 /ws，建 kind:"client" 宿主（整页只建一次）
  ├── host.hold(Manifest) → 引用立刻返回，可能仍是 loading
  ├── 一次 host.load([...web 切面 URL])：整批装完再激活
  │     └── 插件切面把自己注册进 Panels 注册表
  ├── 外壳订阅 Panels，按 order 排序渲染标签页
  └── Manifest.facets[].web.hash 变化 → host.reload(同批 URL, { remove }) → host.ready()
```

浏览器只比较 `web.url#hash`。服务端只改了服务端代码、web 文件没变时，hash 不变，浏览器不重载；改了 `web.js` 才会换。Manifest 的 `revision` 仍发布，但只作为诊断字段，不驱动重载。若 Manifest 本身因契约升级无法绑定，`useRemote` 会把它报成 fatal，外壳刷新页面——旧壳无法在不刷新页面的情况下理解新契约。

第一条值得单独说：**建 link 要在 socket `open` 之前**。服务端在 `Connection` 构造时就发 `hello`，晚挂的监听能不能看到它取决于运行时的事件循环——是竞态，不是保证；收不到 `hello` 的客户端不知道对端会 ack，于是自己从不发 ack，服务端的流控窗口再也不排空，表现为「状态不再到达」，而不是一条报错。提前建 link 是安全顺序，也没有代价：`webSocketLink` 在 open 前缓存出站帧，而帧要到达也总得先有它落脚的 link。

断线不重建宿主：`host.connect` 换掉 link，Chord 会把每个远程引用重新 hold，值在重新水合前保持可读（状态 `loading`）。浏览器切面与 `Panels` 注册表留在原地。

外壳从头到尾不知道「时钟」是什么，也没导入过它。它只知道有一个注册表，以及注册表里现在有什么。

插件模块里的 `import "react"`、`import "@moonan_ai/sdk/web"` 由 `index.html` 的 import map 解析到 `/runtime/*.js`。**这就是为什么插件不需要打包**：它的依赖由外壳预先提供，而且只有一份。多一份 React 会让 hooks 报错，多一份 Chord 会把两个协议与对象身份世界放进同一个页面——两种失败都表现为「面板没出现」，而不是一条报错。

## 零数据落在哪里

平台没有任何一行写磁盘的代码。没有 `moonan.db`，没有配置文件，没有 `.moonan/state.json`。`--plugins-dir` 是**只读**的扫描目录。

结果：卸载一个插件 = 删掉它的包和它自己的数据文件，平台侧没有残留需要清理。升级平台不会碰你的数据。把仓库整个删掉，除了插件自己的数据，什么都不会丢。
