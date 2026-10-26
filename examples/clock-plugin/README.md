# Clock plugin

一个最小的、没有任何 AI 概念的 Moonan 插件。它存在的意义是证明平台是真的空的：一个时钟和一个 HTTP 端点，走的路径与将来任何插件完全相同。

A minimal Moonan plugin with no AI in it. It exists to show the platform is genuinely empty: a clock and one HTTP endpoint, loaded exactly the way any other plugin will be.

```bash
node packages/platform/bin/moonan.js --plugin ./examples/clock-plugin
# http://127.0.0.1:21315
```

## 它做了什么

| 文件 | 内容 |
|---|---|
| `package.json` | 依赖声明；目录名 `clock-plugin` 是显示名 |
| `server.mjs` | 一个 `moonan.clock` 远程对象（state `at`，方法 `tick`），外加一条 `GET /api/clock` 路由 |
| `web.js` | 同一个契约写第二遍，注册一个 `Panels` 面板 |

三个地方值得注意：

1. **没有构建步骤。** 两个切面都是纯 ESM，浏览器那份靠外壳的 import map 解析 `react` 和 `@moonan_ai/sdk/web`。
2. **契约写了两遍。** Chord 认指纹不认模块实例，所以两份独立的 `remote("moonan.clock", …)` 能对上。
3. **没有 `plugin.json`，也没有插件 ID。** 平台按目录里的 `server.mjs` / `web.js` 找到切面；切面的模块 URL 才是运行时的身份。

## 试一下

- 时钟每秒跳一次：服务端的 `self.task` 在改 state。
- 点「调用 tick()」：一次 Chord 方法调用，往返。
- 点「GET /api/clock」：同一条端口上的普通 HTTP 路由，由 `Routes` 注册表提供。
- 服务端热重载不会刷新页面：浏览器不参与 chord 的 cluster 重载协调，但它会在自己的宿主里本地 reload 切面——`Manifest.facets[].web.hash` 一变就换：

```bash
curl -X POST http://127.0.0.1:21315/api/plugins/reload
```
