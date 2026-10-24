# 面板属于浏览器，内核不再知道面板存在

alpha4 里 `Panels` 是一个**服务端**注册表：插件在 `api.serve(...)` 的工厂里 `self.register(Panels, {id, titleKey, order})`，内核把它抄进 `AppContract.panels`，前端再按 `id` 去 `COMPONENTS` 表里找组件。于是有三处必须同时改才加得上面板：插件的服务端、契约的 schema、以及前端那张 `COMPONENTS` 表。磁盘插件的 `web.js` 永远进不来——`COMPONENTS` 是编译进去的。

alpha5 把面板整个搬进浏览器：

- `Panels` 现在是 `@moonan_ai/web-api` 导出的注册表，落在**浏览器宿主**上（chord 的注册表本来就是 per-host）。
- 每个插件的浏览器半边是一个 facet（`web.tsx` → `web.js`），它 `self.register(Panels, { id, order, title, component })`。`title` 是数据（`{zh, en}`），不是 shell 的 i18n key；`component` 是函数，本来也不可能序列化。
- shell 不 import 任何面板：它订阅自己的 `Panels`、按 `order` 排序、用 `panel.component` 渲染。`AppContract` 升到 v2，`panels` 字段删除。

**Considered Options**:

1. 内核继续持有面板清单，只把组件改成运行时加载。被否掉：面板清单仍然是内核知识，而且四份清单（注册表、契约、shell、插件）会继续不同步。
2. 用 chord 的 `remote()` 把注册表镜像到浏览器。被否掉：chord 的注册表没有 wire 复制，一个 host 的注册表无法出现在另一个 host 上。

**Consequences**: 浏览器成了唯一的注册者，所以「面板是否出现」只取决于它的 web facet 有没有加载成功——这也让 [ADR-0013](0013-experimental-browser-facet-loader.md) 里的运行时加载成为必需，而不是可选。代价是：一个只用服务端的客户端（脚本、TUI）看不到面板清单，它本来也不需要。
