# 不复用 pi-server 与 pi-protocol

Moonan 建在 `pi-ai`、`pi-agent-core`、chord 之上，但服务器外壳是自己写的。`pi-server` 与 `pi-protocol` 依赖了 chord 已经移除的导出（`RemoteServiceError` 等），在这个版本上根本无法启动；即便能跑，它们假设的是「一个会话一个连接」，而 Moonan 需要的是「多个浏览器同时看同一批常驻对象」。

`pi` 的 Unix socket 传输和 `pi-durable` 是本项目明确参考过、但没有采用的设计：前者面向单机 CLI 与后台进程通信，Moonan 的客户端是浏览器；后者解决的是进程重启后的会话恢复，而 Moonan 的做法更简单——把状态写进 SQLite，重连时重新取快照。

**Consequences**: 服务器胶水（HTTP、静态文件、WebSocket 升级、插件模块解析）由 `@moonan/core` 自己维护，升级 chord 时要自己跟进。
