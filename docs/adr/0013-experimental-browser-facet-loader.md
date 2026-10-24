# 浏览器 facet 用运行时加载（实验性）

chord 1.4 只带 `nodeLoader`：浏览器不是 reload 的参与者，官方对「浏览器怎么加载 facet」没有规定。alpha4 的做法是「前端构建时把内置面板打进去」，代价是磁盘插件的 `web.js` 只能当静态资源提供，永远不能注册面板。

alpha5 采用运行时加载，分三块：

1. **共享运行时**。`packages/web/scripts/build-runtime.mjs` 用 esbuild 把 React、`react/jsx-runtime`、`react-dom`、`@earendil-works/chord`、`@earendil-works/chord/output`、`typebox`、`@moonan_ai/contracts`、`@moonan_ai/web-api` 各打成一个自足的 ESM，放在 `/runtime/*.js`。`index.html` 的 import map 把裸标识符指过去；shell 的 Vite 构建把这些标识符全部 `external`。
2. **FacetLoader**。`packages/web/src/chord/facet-loader.ts` 实现 chord 的 `FacetLoader`：`import(url + "?v=<generation>")`，取出默认导出，包成 `{ name, setup, uses }`。query 让每次重连拿到新副本，和 `nodeLoader` 用 `chord2-reload` 的理由一样。
3. **加载时机**。`AppContract.plugins` 里的 `web` 字段给出 URL，shell 拿到后逐个 `host.load([url])`；一个模块失败只记日志并跳过，不影响其他插件。

为什么这是实验性的，而不是「官方形态」：

- import map 是浏览器标准，但「把所有依赖都 external 出去、靠 import map 兜底」是 Moonan 自己的约定；插件作者必须接受「只能 import 共享运行时里的东西」。
- 浏览器没有 reload 参与者，所以 `/api/plugins/reload` 返回 `reloadBrowser: true`；`GET /api/plugins` 带 `experimental: true`。
- 协议不匹配时 chord 给出 `upgrade_required`，客户端唯一的出路是整页刷新；`onProtocolMismatch` 会先刷新一次，10 秒内再次失败就显示横幅，避免刷新循环。

**Considered Options**: 继续构建期打进去（否：第三方面板永远不出现）；用 iframe 隔离每个插件（否：面板要共享同一个 React 树与 chord 引用，iframe 会把它们切断）；自己实现一个 chord 的浏览器协议副本（否：等于分叉）。

**Consequences**: 升级 chord 时要同时检查 `/runtime/chord.js` 的导出是否仍覆盖插件的需要。共享运行时里的模块必须保持单例——插件里出现第二份 React 会让 hooks 直接报错，第二份 chord 会让注册表令牌对不上（contract 指纹能对上，registry 按名字也能对上，所以这两类错误会表现为「面板不出现」而不是崩溃）。
