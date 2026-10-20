# 0007：WebUI 用 React + Vite；插件 UI 目前是宿主约定

- 状态：接受
- 日期：rc1

## 背景

插件要能"自己写 UI"（例如 Agent 页里每个 Agent 的界面都不一样）。Chord 的 facet 设计本身就支持
把插件拆成 node 面与 browser 面，两端分别打包、分别加载。

但浏览器侧的 facet 加载需要应用自己解决两件事：把多个 bundle 送到浏览器，以及提供一个能被插件依赖的 UI 运行时
（组件库、状态订阅）。

## 决定

- WebUI 用 **React + Vite**，产物是纯客户端 SPA，由 `apps/moonan` 的 HTTP 服务托管在 21315。
- rc1 的插件 UI 走**宿主约定**：插件包导出 UI 组件，宿主 shell 在构建期引用它们，并把自己拼成一份 bundle。
- 插件与宿主之间仍然走**服务**：UI 通过 WebSocket 上的 chord 远端服务绑定拿到与 node 侧同 id 的服务，
  方法签名少一个 `Context` 参数。因此数据访问代码在两侧可以共用。
- 服务 token 定义在 `@moonan/plugin-sdk`（纯数据），不定义在 UI 包里——这样非 React 的客户端与测试都能引用。

## 理由

- React 是实现"每个 Agent 一个自定义面板"最省事的工具，且与瑞士风格的手写 CSS 不冲突（不需要组件库）。
- 真正重要的是**契约**（服务 id、方法签名、状态形状）而不是加载机制：契约先稳定下来，加载方式可以后换。

## 后果

- 好：rc1 能用一份 bundle 跑起来，插件 UI 与宿主共享组件与样式。
- 差：插件 UI 必须用 React，且必须与宿主一起构建——不是运行时可装载的。
- 迁移路径（rc2）：用 chord bundler 的 `platform: "browser"` 把插件 UI 打成独立 bundle，
  宿主提供一份"UI 运行时"（chord 的 browser facet 环境 + 组件库），再用 `createFacetBundleLoader` 的浏览器等价物加载。
