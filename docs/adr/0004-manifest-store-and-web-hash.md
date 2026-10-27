# Manifest 用一个 store，浏览器按 web hash 重载

**Status:** accepted

平台原先用模块级 `replicatedState` + 每个 `Manifest` 实例的 `self.on` 复制 cell 来广播清单。它工作，但有两份真相、每个 principal 一份重复状态，而且 `self.on` 把 `replicatedState` 当作事件源，并不在官方“state source”语义里。浏览器又在每次服务端 code version 变化时全量 reload web facet，服务端-only 改动也会重置所有面板。

我们决定：

- 用一个 `lifetime: "host"` 的 local `ManifestStore` 持有唯一的 `snapshot` cell；`version/facets/revision` 是它的派生值。
- 每个 remote `Manifest` 用 `self.get(ManifestStore, {})`，直接暴露 store 的 state member。Chord 负责 snapshot/delta，平台不遍历实例、不复制 cell、不写 `self.on`。
- `ManifestStore` 与 `Manifest` 在同一个 `host.load` 批次里安装，插件的 host 对象可以在工厂里消费 `Manifest`。
- 浏览器切面的身份从 `web: string` 改为 `web: { url, hash }`；`hash` 是 web 文件内容的 SHA-256 前缀。`reloadBrowser` 比较 reload 前后的 `url#hash`，不再看 code version。
- 浏览器只在 hash 变化时 `host.reload`；服务端-only 改动不重载 web facet。纯前端插件也能通过 `POST /api/plugins/reload` 更新。
- `Manifest` 契约升到 v3；不提供旧 `web: string` 的 `accepts` 适配。旧客户端得到 `contract_mismatch`（browser 被 chord 映射成 `upgrade_required`，见下方 Amended）后整页刷新。

**Consequences**

- 清单只有一份权威状态，新增一个 `Manifest` principal 不再复制数组。
- 服务端 reload 与浏览器 reload 解耦；`reloadBrowser` 的表达更准确。
- 浏览器必须能处理 Manifest 契约不匹配：`useRemote` 把 `contract_mismatch`/`upgrade_required` 报成 fatal，外壳刷新页面。
- `/api/plugins` 的 `web` 字段变为 `{ url, hash }`，测试与文档同步。

## Amended 2026-10-27

官方语义复核后的三处澄清（行为不变，措辞与边界更正）：

- **`revision` 是应用状态，不是协议字段。** chord 1.3.0 移除了 `Shape.codeVersion`，但 spec §6 明确把 server `Manifest` 点名为浏览器了解变化的通道。Moonan 把 `host.codeVersion` 作为 `Manifest` 的应用 state 发布，仅用于诊断；浏览器不把它当 code version 用。
- **不提供 v2 `accepts` 适配器是允许的，但结果分类要写准。** browser 的 `contract_mismatch` 会被 chord 映射成 `upgrade_required`（并提示 “reload the web facets”）；非 client 消费者仍然是 `contract_mismatch`。旧壳需要加载新壳，而不是靠适配器长期留在旧契约上。
- **hash 是平台级“web 模块变了”的令牌，不参与契约兼容判断。** 官方补救是重载 web 切面（client-local `host.reload`，chord 支持）；整页刷新只用于协议失配，以及外壳自身 Manifest 契约失配这一 Moonan 例外。`ManifestStore` + 派生 + 远程视图的模型不变。
