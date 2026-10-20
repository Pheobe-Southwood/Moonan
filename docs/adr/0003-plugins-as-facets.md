# 0003：官方插件是真独立包（facet），但 rc1 静态装配

- 状态：接受
- 日期：rc1

## 背景

"支持灵活的插件系统"有两种落地方式：

1. 插件是**目录约定**（`src/plugins/*`），编译进同一个包；
2. 插件是**独立包 + facet bundle**（Chord 的 bundler 把每个插件打成一个内容寻址的 `.cjs`，
   启动时用 `createFacetBundleLoader` 加载，可校验 SHA-256、可热替换）。

## 决定

采用 (2) 的**包结构**与 (1) 的**装配方式**：

- 五个官方插件各自是一个 workspace 包（`packages/plugins/*`），有自己的 `package.json`、`tsconfig`、依赖与构建；
- 宿主把它们当普通依赖 import，并用 `createPluginFacet` 把每个插件的 `setup` 包成一个 facet——
  每个插件**一个 facet**，因此 Chord 会校验整张依赖图（缺服务在启动时报错，而不是运行时炸）；
- rc1 **不**走 bundler + VM 加载：宿主与插件同源同版本，多一层打包只会让调试变难。

## 理由

- 判据是"删掉一个插件包，应用是否还能启动"。(2) 的包结构让这件事在 rc1 就成立，且不需要额外机制。
- 每个插件一个 facet 让 Chord 的依赖图校验有用武之地；这也是"插件只能通过服务拿东西"这条边界的实际执行者
  （日志窗只依赖 `moonan.transcripts`，不直接读数据库）。

## 后果

- 好：插件的边界是真的；装第三方插件时替换的是 `apps/moonan/src/plugins.ts` 这份清单。
- 差：插件与宿主在同一个 node_modules 树里，版本错配不会被发现。rc2 引入 bundle 加载时才有隔离与完整性校验。
- 已知缺口：插件的 **UI** 还没有对应的加载机制，见 ADR 0007。
