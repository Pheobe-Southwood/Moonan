# hello-plugin

最小的磁盘插件：通过注册表贡献第二个 Agent，不碰界面。

```bash
mkdir -p ~/.moonan/plugins
cp -r examples/hello-plugin ~/.moonan/plugins/hello
```

重启 `moonan` 之后，Agent 面板里会多出一个 **Helen**。它在服务端做了两件事：

- 起一个 `lifetime: "host"` 的根对象（注册表的硬性要求）；
- 用 `self.register(AgentDefinitions, …)` 声明这个 Agent 与它的两个变量。

入口是 `server.mjs` 而不是 `server.js`——目录里没有 `package.json` 时，Node 会把 `.js` 当 CommonJS。插件也不需要安装依赖：`@moonan_ai/contracts`、`@earendil-works/chord`、`typebox` 由宿主解析到它自己的那一份。

改完文件不用重启进程：

```bash
curl -X POST http://127.0.0.1:21315/api/plugins/reload -d '{"id":"hello"}'
```

想让它有界面，见 [插件文档](../../docs/plugins.md)。
