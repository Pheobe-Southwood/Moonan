# chord 作为插件底座

每个面板、每个跨进程对象都是一个 chord facet。插件拿到的是一个 `FacetApi`：`serve(contract, factory)` 注册对象，`root(fn)` 在调用之外改状态，`signal` 随插件卸载一起中止。

选 chord 是因为它同时解决了三件事：契约即类型（TypeBox 生成的 JSON 结构两边共用）、状态增量同步（`Cell` 变化自动推到浏览器）、以及卸载语义（引用释放、信号中止）。插件因此不需要自己写路由、序列化或订阅管理。

代价是约束很强，且多数约束不写在文档里：成员名不能叫 `status`，单元格不能含 `undefined`，对象必须声明 `hostNamed("moonan")`，客户端 host 必须声明 `kind: "client"`。这些都在实现时踩过，写在这里免得下一个人重踩。

**Considered Options**: 自己写一套基于 WebSocket 的 RPC + 事件订阅。被否掉的原因是插件作者要同时维护服务端和浏览器两侧的序列化约定，而这正是 chord 已经做对的部分。
