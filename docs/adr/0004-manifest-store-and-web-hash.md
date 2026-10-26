# Manifest 用一个 store，浏览器按 web hash 重载

**Status:** accepted

平台原先用模块级 `replicatedState` + 每个 `Manifest` 实例的 `self.on` 复制 cell 来广播清单。它工作，但有两份真相、每个 principal 一份重复状态，而且 `self.on` 把 `replicatedState` 当作事件源，并不在官方“state source”语义里。浏览器又在每次服务端 code version 变化时全量 reload web facet，服务端-only 改动也会重置所有面板。

我们决定：

- 用一个 `lifetime: "host"` 的 local `ManifestStore` 持有唯一的 `snapshot` cell；`version/facets/revision` 是它的派生值。
- 每个 remote `Manifest` 用 `self.get(ManifestStore, {})`，直接暴露 store 的 state member。Chord 负责 snapshot/delta，平台不遍历实例、不复制 cell、不写 `self.on`。
- `ManifestStore` 与 `Manifest` 在同一个 `host.load` 批次里安装，插件的 host 对象可以在工厂里消费 `Manifest`。
- 浏览器切面的身份从 `web: string` 改为 `web: { url, hash }`；`hash` 是 web 文件内容的 SHA-256 前缀。`reloadBrowser` 比较 reload 前后的 `url#hash`，不再看 code version。
- 浏览器只在 hash 变化时 `host.reload`；服务端-only 改动不重载 web facet。纯前端插件也能通过 `POST /api/plugins/reload` 更新。
- `Manifest` 契约升到 v3；不提供旧 `web: string` 的 `accepts` 适配。旧客户端得到 `contract_mismatch` 后整页刷新。

**Consequences**

- 清单只有一份权威状态，新增一个 `Manifest` principal 不再复制数组。
- 服务端 reload 与浏览器 reload 解耦；`reloadBrowser` 的表达更准确。
- 浏览器必须能处理 Manifest 契约不匹配：`useRemote` 把 `contract_mismatch`/`upgrade_required` 报成 fatal，外壳刷新页面。
- `/api/plugins` 的 `web` 字段变为 `{ url, hash }`，测试与文档同步。
