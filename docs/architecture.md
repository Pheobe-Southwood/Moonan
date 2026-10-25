# 一次请求、一次装载、一次重载

这篇只讲路径：一个字节从哪进、经过谁、到哪出。概念的释义在 [CONTEXT.md](../CONTEXT.md)。

## 进程里有什么

```text
node packages/substrate/bin/moonan.js
  │
  ├── Chord 宿主 "moonan"            ← 服务端宿主，名字必须和契约里的 hostNamed("moonan") 一致
  │     ├── 插件 A 的服务端切面
  │     ├── 插件 B 的服务端切面
  │     └── moonan:manifest 切面      ← 基座唯一自己装的切面
  │
  └── HTTP + WebSocket 服务（一个端口）
```

**只有一个进程，一个端口。** 没有独立的 UI 服务、没有反向代理、没有数据库进程。插件需要持久化就自己开自己的 SQLite 文件——基座不知道它开在哪。

## 一次装载

启动顺序是刻意的，顺序错了浏览器会拿到过期的清单：

```text
1. 收集插件引用
     --plugin <包名|目录>  ＋  plugins-dir 下的每个子目录
2. 逐个解析成模块 URL
     目录 → plugin.json 的 server 字段（或 server.mjs / server.js）
     包   → import.meta.resolve(包名)，由包自己的 exports 决定
     失败 → 记在记录的 error 上，不抛出
3. 建宿主
4. 一次 host.load(全部 URL)：先装完所有切面，再统一激活宿主对象
     成功 → 全部 loaded = true
     失败 → 逐个 host.load 只为定位是哪一个，记 error，序列继续
5. 装 manifest 切面，把最终的插件列表写进它的 state
6. host.get(Manifest, {}) 拿到引用并一直持有
7. 开端口
```

第 5 步在第 4 步之后，不是疏忽：清单的内容就是第 4 步的结果。第 6 步的持有也不是疏忽——远程对象是按引用计数的，没有引用就会被回收，而浏览器每次重连都要重新拿一次。

## 一次请求

```text
浏览器 / curl
  │
  ├── /ws                     → WebSocket 升级 → chord 协议（对象调用走这里）
  ├── /api/plugins            → 内建：清单的 HTTP 视图
  ├── /api/plugins/reload     → 内建：POST 触发重载
  ├── /plugins/<id>/<file>    → 插件的浏览器切面与其资源（越界即 403）
  ├── 其它                     → Routes 注册表："GET /path" 优先，其次 "/path"
  └── 仍未命中                → 外壳静态文件；不是文件就回 index.html（前端路由）
```

`Routes` 的查找发生在 `host.root()` 里：

```ts
await host.root(async (ctx) => {
	const view = host.registry(Routes);
	const handler = view.get(`${method} ${pathname}`, ctx) ?? view.get(pathname, ctx);
	if (!handler) return false;
	await handler(request, response, ctx);
	return true;
});
```

绑定到一个根，意味着这次请求看到的是**一个特定代码版本**的注册表。重载期间进来的请求要么用旧版跑完，要么用新版——不会看到半新半旧的表。

## 一次重载

```text
POST /api/plugins/reload  { "id": "clock" }   ← id 省略则全部
  │
  ├── 从未加载成功的插件 → host.load()         （重载无法修复「没装上」）
  ├── 已加载的插件       → host.reload([url])  （prepare → gate → commit → retire）
  ├── 提交成功           → chord 的 code version +1，基座直接读 host.codeVersion
  ├── 广播一份快照       → 每个活着的 Manifest 实例在自己的 root 里写自己的 cell
  └── 响应 { ok, reloadBrowser: true, revision, reloaded }
```

`revision` 就是 **chord 的 code version**（`host.codeVersion`）：启动时是 1，每次提交 +1。基座不再自己数一个整数——那份信息 chord 本来就有，而且 `ReloadReport.codeVersion` 已经在响应里。一次「恢复加载」（启动时失败的插件被 `host.load` 装上）不改变 code version，因为那不算一次提交；这时变的是 `plugins` 数组，浏览器照样会换切面。

`reloadBrowser: true` 说的是「浏览器切面过期了」，不是「整页刷新」。浏览器不参与 chord 的 **cluster** 重载协调，但 `kind: "client"` 的宿主可以本地 reload 自己的切面（代码版本不跨连接传播）——chord 对过期契约的补救也正是「reload its web facets」。整页刷新只留给协议版本失配。

旧代码的根还在跑时，旧实现继续为它服务；根结束后，那一版才退休。这是 Chord 自带的事务语义，基座没有额外做什么。

## 一次广播

`Manifest` 是远程对象，chord 按 principal 建实例：**宿主自己的一个，以及所有浏览器共用的一个**（`acceptWebSockets` 给每个连接同一个 principal）。基座不遍历这些实例：

```text
reload 提交
  │
  ├── publishManifest()：manifestChanges.replace(BACKGROUND_CONTEXT, { revision: host.codeVersion, plugins })
  │        └── 一个 Subscribable，只保存当前值并通知订阅者
  └── 每个 Manifest 实例在自己工厂里声明的 self.on("manifest", …)
           └── chord 在自己的 root 里把新值写进那个实例的 cell
```

对象随浏览器断开被回收时，监听器随对象一起消失——不需要谁去修剪一本「还活着哪些实例」的账。新实例的初值取自 `manifestChanges.value`，所以它不会从 0 开始，也不会漏掉广播期间发生的变化。

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
  └── Manifest.revision 变化 → host.reload(同批 URL, { remove })
```

第一条值得单独说：**建 link 必须在 socket `open` 之前**。服务端在 `Connection` 构造时就发 `hello`，客户端晚一步订阅就永远收不到；收不到 `hello` 的客户端不知道对端会 ack，于是自己从不发 ack，服务端的流控窗口再也不排空——表现为「状态不再到达」，而不是一条报错。`webSocketLink` 会在 open 前缓存出站帧，所以提前建 link 没有代价。

断线不重建宿主：`host.connect` 换掉 link，Chord 会把每个远程引用重新 hold，值在重新水合前保持可读（状态 `loading`）。浏览器切面与 `Panels` 注册表留在原地。

外壳从头到尾不知道「时钟」是什么，也没导入过它。它只知道有一个注册表，以及注册表里现在有什么。

插件模块里的 `import "react"`、`import "@moonan_ai/sdk/web"` 由 `index.html` 的 import map 解析到 `/runtime/*.js`。**这就是为什么插件不需要打包**：它的依赖由外壳预先提供，而且只有一份。多一份 React 会让 hooks 报错，多一份 Chord 会把两个协议与对象身份世界放进同一个页面——两种失败都表现为「面板没出现」，而不是一条报错。

## 零数据落在哪里

基座没有任何一行写磁盘的代码。没有 `moonan.db`，没有配置文件，没有 `.moonan/state.json`。`--plugins-dir` 是**只读**的扫描目录。

结果：卸载一个插件 = 删掉它的包和它自己的数据文件，基座侧没有残留需要清理。升级基座不会碰你的数据。把仓库整个删掉，除了插件自己的数据，什么都不会丢。
