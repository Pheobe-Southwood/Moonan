# 0001：单进程 + 自写 WebSocket，不实现 unix socket

- 状态：接受
- 日期：rc1

## 背景

参考实现（pi）的形态是「server 进程 + 每个 Session 一个 worker 进程」，客户端与 worker 之间用 pi-protocol
的 CBOR 帧走 **unix socket**，Chord 的远端服务绑定跨越那个边界。但 `pi-server` 只带了一个**测试用**客户端，
没有生产级 client；而且它明确说明「生命周期管理在公共协议之外」，即拆进程要靠应用自己编排。

## 决定

rc1 采用**单 Node 进程**：

- 数据面**复用 `pi-server` 与 `pi-protocol`**：自写一个最小的 RFC 6455 服务端，把每条 WebSocket 连接包成
  `ByteConnection` 交给 `pi-server.Server.accept()`。路由、握手、取消、订阅状态编码全部由 pi-server 处理。
- WebSocket 服务端自己实现，不引第三方库（`ws`）：只需要二进制帧、掩码、分片、ping/pong、close。
- **不创建 unix socket**。`pi-server/unix` 只作为参考保留在依赖里。

## 理由

- 判据是「pi-server 是否真的在用」：它在用（路由与订阅），只是传输换成了 WebSocket。这与"自己写一套应用协议"有本质区别。
- 浏览器无法直接开 unix socket，因此要在浏览器与 worker 之间通信，最终一定要有一个 HTTP/WS 层；再叠一层 socket 只是增加一次序列化。
- rc1 的目标是"可运行的插件系统"，不是"可水平扩展的进程模型"。

## 后果

- 好：一个进程、一条链路，调试成本低；插件与 Agent 运行时共享内存，插件可以直接拿到运行中的对象。
- 差：插件里的死循环会拖住整个应用；没有进程隔离。
- 迁移路径（rc2 可选）：`ServerHost` 的实现已经按"应用提供 serverServices / resolveSession / openSession"写，
  把 `openSession` 换成"起 worker 进程 + unix socket + chord 远端绑定"即可，路由以上不动。
