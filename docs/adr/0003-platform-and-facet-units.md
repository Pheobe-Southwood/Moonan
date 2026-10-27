# 平台，不是基座；切面，不是插件 ID

**Status:** accepted

Moonan 原来的“基座（substrate）”把自己放在 Chord 的 host 之下，但 Chord 的 host 才是对象/状态/重载的运行时；Moonan 实际是它上面的应用层。与此同时，`plugin.json` 与插件 ID 让 Moonan 把“插件”当成了热重载与生命周期单位，而 Chord 的单位是切面（facet）的模块 URL。前者造成层级误称，后者造成了 per-plugin reload 与 Chord 批量契约检查、`host.ready()` 的冲突。

我们决定：

- 把这个应用层改称 **平台（Platform）**；代码用 `Platform`、`createPlatform`、`packages/platform`，发布包名 `@moonan_ai/moonan` 与 `moonan` 命令保持不变。
- 删除 `plugin.json` 与插件 ID。插件是目录/包这一层**分发与显示**分组；运行时身份是切面模块 URL。
- 服务端切面始终一次 `host.load`；需要 chord 提交时，重载始终一次 `host.reload` 全部服务端切面（纯 web 变化不产生提交；移除切面是一次 `host.reload([], { remove })`），并 `await host.ready()`；不提供 per-plugin reload。
- 启动时服务端切面装载失败即关闭宿主并退出，不继续运行半装状态。
- 浏览器清单发布 `facets`（显示名、版本、web URL、错误），不再发布插件 ID。

**Considered Options**

1. 保留“基座/substrate”命名。被否掉：它持续暗示 Moonan 是 Chord 之下的运行时，导致“平台策略”被误读成“Chord 的基座能力”。
2. 保留 `plugin.json`/插件 ID，但把 reload 改成批量。被否掉：ID 会让下一次改动再次把插件当成生命周期单位；而 Chord 没有插件 ID，身份应直接是切面 URL。
3. 立即为每个插件建 child host，保留 per-plugin 隔离。被否掉（本轮）：这是更大的架构改动；在单宿主下，Chord 的 `install` 不是回滚事务，fail-fast 是唯一诚实的策略。

**Consequences**

- 破坏性变更：`plugin.json`、插件 ID、`/plugins/<id>/...`、`Manifest.plugins` 都不再存在；`Manifest` 契约升到 v2（后续 v3 见 [0004](0004-manifest-store-and-web-hash.md)）。
- 一个坏的服务端切面会阻止启动，而不是让其他插件继续跑；真正的隔离留给未来的 child-host 工作。
- 纯前端插件（只有 `web.js`，或包只导出 `./web`）现在可以启动并被浏览器加载。
- 旧的 `0001`、`0002` ADR 已删除；它们的内容与命名不再适用，git 历史保留。
