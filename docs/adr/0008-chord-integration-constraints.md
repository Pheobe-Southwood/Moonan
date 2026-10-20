# 0008：Chord 集成的三个硬约束

- 状态：接受
- 日期：rc1

## 背景

把 Chord 1.1.0 当成应用组合层用，踩到了三个不在文档正文里、但会在运行时直接报错的约束。
它们不是"我们的选择"，而是"必须遵守的事实"；记下来是为了不再重新发现一遍。

## 约束一：服务句柄在**属性访问时**就做阶段校验

`FacetLifecycle.assertServiceAccess()` 在每次 `env.use()` 得到的服务句柄**取成员**时检查阶段。
因此：

- `setup` 阶段（宿主 facet 尚未激活）访问 `services.agents.list(...)` 会抛
  `service handles cannot be used while setting_up`；
- 连 `services.log.info(...)` 都不行——`log` 也是别人的服务。

**做法**：SDK 只给 `setup` 暴露 `log`（getter，实际访问延迟到调用时）/ `define` / `onReady`。
插件的所有跨服务工作放进 `services.onReady(async (ctx) => …)`，回调在**本 facet 激活时**运行。

例外：**注册**（`env.provide`、`env.onDeactivate`、`env.use` 本身声明依赖）必须在 `setup` 里完成。
所以 `createPluginFacet` 在 `setup` 里先 `env.use(HostFacilityToken)` 拿到句柄、登记 `onReady` 回调，
真正取成员留到回调里。

## 约束二：`defineService` 的"远端可暴露"校验会拒绝客户端契约

`RemoteServiceContract<T>` 要求每个方法形如 `(...args, Context) => Promise<Json|void>`。
浏览器侧的服务契约刻意**少**一个 `Context` 参数（远端绑定负责补），因此用 `defineService` 定义客户端 token
会落到"必须 `{ local: true }`"的分支。而 `local` 的服务在远端绑定里会被拒：
`Service moonan.host-state is process-local`。

**做法**：客户端 token 在 `@moonan/plugin-sdk` 里按 `{ id, local: false }` 的形状直接构造
（`clientService<T>(id)`），不做重载校验；服务实现里的方法签名则**保留**末尾的 `Context`，
即使实现不读它——这是远端调用能工作的前提。

## 约束三：严格 JSON 不接受 symbol key、原型、函数

`copyJson()`（replicated state 的写路径）要求值是可枚举的纯数据：
symbol key 直接抛 `Value contains a symbol key and is not strict JSON`，
非 `Object.prototype`/`null` 原型抛 `Value must contain strict JSON plain objects or arrays`。

**做法**：一切要写进 replicated state 的插件数据（action 列表、provider 列表、日志事件、
TypeBox schema）都先过 `toPlainJson()`（JSON 往返）。`parseClientFrame` 这类边界也据此改写错误信息，
不用 `instanceof` 判型。

## 附带发现：两个必须知道的行为

### 引擎会"替换"流式消息，不能按条数记账

`runAgentLoop` 在 `message_start` 时把 partial 消息 push 进上下文，流结束时用**等长的最终消息替换**
`context.messages[len-1]`。因此按"已持久化条数"推进会**静默丢掉真实消息**。
做法：给每条消息打一个非枚举的 `Symbol` id（`Object.defineProperty`，`JSON.stringify` 看不到），
用 Set 按身份记账（`AgentInstance.#persistedIds`）。

### `prepareRequest` 返回的 context 会让引擎重绑上下文

一旦 `prepareRequest` 返回 `{ context }`，引擎把 `currentContext` 换成新对象，
而 `emit` 携带的仍是最初那个对象。因此**不能**在事件回调里读 `context.messages` 来同步状态，
要在 `prepareRequest` 里记下引擎真正在用的那个 context（`AgentInstance.#live`）。

## 后果

- 这些约束被固化在三处：`packages/plugin-sdk/src/plugin.ts` 的注释、`createPluginFacet` 的实现、
  以及本 ADR。新增插件时只要照着 SDK 的形状写，就不会再撞上。
- 升级 Chord 时要重新验证的正是这三条——它们都不在公开的类型签名里。
