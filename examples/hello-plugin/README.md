# hello-plugin

最小的磁盘插件：注册第二个 Agent，不碰界面。

```bash
mkdir -p ~/.moonan/plugins
cp -r examples/hello-plugin ~/.moonan/plugins/hello
```

重启 `moonan` 之后，Agent 面板里会多出一个 **Helen**。它在服务端注册了：

- 一个 Agent（`id: "hello"`），带两个自己的变量；
- 一条写入 `plugin_state` 的记录；
- 一行日志，出现在启动输出里。

入口是 `server.mjs` 而不是 `server.js`——目录里没有 `package.json` 时，Node 会把 `.js` 当 CommonJS。插件也不需要安装依赖：`@moonan_ai/plugin-sdk`、`@moonan_ai/contracts`、`@earendil-works/chord`、`typebox` 由宿主解析到它自己的那一份。

想让它有界面，见 [插件文档](../../docs/plugins.md)。
