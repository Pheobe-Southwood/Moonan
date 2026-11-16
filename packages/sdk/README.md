# @moonan_ai/sdk

Moonan 插件 SDK：契约、主体（principal）辅助函数、注册表与浏览器钩子。写 Moonan 插件只需要这一个包——Chord 的原语
（`remote`、`local`、`method`、`hostNamed`、`defineFacet`、`defineRegistry`）由它再导出。

Moonan 是一个本地运行、需要登录的插件工作台：平台只提供宿主、端口、插件发现、切面装载、账户与会话，
所有功能——包括 AI 对话——都是插件。

```bash
npm i @moonan_ai/sdk
```

## 两个入口

| 入口 | 给谁用 |
|---|---|
| `@moonan_ai/sdk` | 服务端切面、以及需要契约/注册表/主体辅助的浏览器代码 |
| `@moonan_ai/sdk/web` | 浏览器切面：`Panels`、`useRemote`、`useReadable`、`useRefStatus`、`isFatalContractError` |

浏览器切面不要自行打包 React、Chord 或本包：外壳的 import map 已经提供了它们，而且只有一份。

## 服务端切面

```js
import { defineFacet, hostNamed, method, num, obj, remote } from "@moonan_ai/sdk";

const Counter = remote("example.counter", {
	version: 1,
	input: obj({}, { open: true }),
	host: hostNamed("moonan"),
	variants: { v1: { state: { n: num() }, methods: { bump: method() } } },
});

export default defineFacet((api) => {
	api.serve(Counter, (_input, _principal, self) => {
		const n = self.state("n", num(), 0);
		return { variant: "v1", n, bump: (ctx) => n.change(ctx, (value) => value + 1) };
	});
});
```

`serve` 的工厂签名是 `(input, principal, self)`。默认对象按主体各建一份；`{ lifetime: "host" }` 的宿主级对象
拿到的是 `{ kind: "host" }`，它才可以贡献 `Routes`、`Panels`、`DataCodecs`、`ModelProviders`。

## 浏览器切面

```js
import { Panels } from "@moonan_ai/sdk/web";
import { defineFacet, local, method, obj } from "@moonan_ai/sdk";
import { createElement as h } from "react";

const Root = local("example.counter.web", { version: 1, input: obj({}, { open: true }), members: { noop: method() } });

export default defineFacet((api) => {
	api.serve(Root, (_input, _p, self) => {
		self.register(Panels, {
			counter: { id: "counter", title: "Counter", order: 10, component: () => h("div") },
			// 只给管理员渲染；接口仍须在服务端用 requireAdmin 再校验。
			users: { id: "users", title: "用户", order: 100, adminOnly: true, component: () => h("div") },
		});
		return { noop: () => undefined };
	}, { lifetime: "host" });
});
```

## 主体与账户

平台要求登录。Chord 的 principal 由服务端认证器从会话 cookie 推出，客户端不能自报：

| 形状 | 何时出现 |
|---|---|
| `{ kind: "host" }` | 平台自身代码、宿主级对象的工厂与调用 |
| `{ kind: "browser" }` | 浏览器宿主自身代码（服务端见不到） |
| `{ kind: "user", id, username, role, session }` | 已登录账户；`role` 是 `"admin"` 或 `"user"` |

辅助函数都在根入口：

```js
import {
	dataOwner, requireAdmin, requireUser, isUserPrincipal, isAdminPrincipal,
	principalKey, userDataOwner, HOST_DATA_OWNER, HOST_PRINCIPAL, BROWSER_PRINCIPAL,
} from "@moonan_ai/sdk";
```

- `isUserPrincipal(value)` / `isAdminPrincipal(value)`：类型收窄判断。
- `requireUser(principal)`：不是登录用户就抛 Chord 的 `forbidden`，返回 `UserPrincipal`。
- `requireAdmin(principal)`：非管理员抛 `forbidden`，返回 `UserPrincipal`。管理接口必须在服务端用它，不能只靠面板隐藏。
- `dataOwner(principal)` → `"user:<id>"`；`userDataOwner(id)` 是同一规则的直接形式；`HOST_DATA_OWNER`（`"host"`）
  只给平台记账用，不是共享用户桶。
- `principalKey(principal)`：Chord 的对象键；登录用户形如 `user:<id>:session:<session>`——重新登录会得到新的对象集合。

HTTP 插件路由以登录用户身份运行：`ctx.principal` 是 `UserPrincipal`，持久化时用 `dataOwner(ctx.principal)` 作为
`DataStore` 的 owner。管理动作见 [docs/plugins.md](https://github.com/Pheobe-Southwood/Moonan/blob/main/docs/plugins.md)。

## 约定

- 契约在两端**各写一份**：Chord 认指纹（名字、版本、成员、类型住在哪个宿主），不认模块实例。
- 注册表贡献（`Routes`、`Panels`、`DataCodecs`、`ModelProviders`）必须来自 `{ lifetime: "host" }` 的对象。
- 功能专属注册表由对应的插件包定义，例如 ai-gateway 的 `ModelProviders`；SDK 只提供通用的 `defineRegistry`。
- 需要统一导出/导入的数据放 `DataStore`，并注册 `DataCodecs`；功能能力（如模型）由对应插件包自己定义注册表。
- 服务端宿主名固定为 `"moonan"`；写别的名字，`api.serve` 会当场拒绝。
- 浏览器切面是**单个 ESM 文件**：浏览器没有模块 hook，重载只换入口。
- 面板的 `adminOnly` 只是外壳的展示过滤；对应接口要在服务端校验角色。

## 统一数据

```js
import { DataCodecs, DataStore, dataOwner } from "@moonan_ai/sdk";
```

- `DataStore` 是平台唯一的插件数据服务（local、host-lifetime，落盘为一个内嵌 SQLite 数据库）。数据集按
  **owner + namespace** 分区：owner 是 `dataOwner(principal)`（登录账户）或 `HOST_DATA_OWNER`（平台记账）。
- `read`/`write`/`update`/`remove`/`removeOwner`/`exportAll`/`importAll` 的**每个调用都显式带 owner**；
  `DataStore` 是 local 对象，平台不会从调用里推导当前用户。`read` 是异步的，返回 `{ value, version }`；
  `update` 是事务化的串行读改写，回调里不要再调 `DataStore`。
- `DataCodecs` 是插件贡献的导出/导入 codec 注册表；没有 codec 的 namespace 不会进入统一导出。导出/导入属于一个
  owner：`/api/data/*` 只作用于当前登录账户，管理员也不能读别人的数据。
- 契约版本是 3（数据库 schema 2）；旧版数据不迁移。

## 插件管理 API 类型

平台把 `/api/v1/plugins` 的 JSON 形状放在根入口，供「插件」页与 CLI 共用：

```ts
import type { PluginAdminEntry, PluginAdminSnapshot, PluginAdminMutation } from "@moonan_ai/sdk";
import { PLUGIN_ADMIN_API } from "@moonan_ai/sdk";
```

`PluginAdminSnapshot` 里的 `id` 是插件的 `ref`（包名或目录），不是运行时身份；运行时身份仍是切面
模块 URL。`PLUGIN_ADMIN_API` 现在是 `2`：`management` 字段已删除（不再有只读/关闭管理的降级），`paths`
里新增了账户数据库 `authDb`。所有 `/api/v1/plugins*` 接口都要求管理员会话。

## 账户管理 API 类型

管理员账户接口 `/api/v1/users*` 的形状也在根入口：

```ts
import {
	USER_ADMIN_API, USER_ADMIN_PATHS, MOONAN_ROLES,
	type UserAdminUser, type UserAdminSnapshot, type UserAdminMutation, type UserAdminError,
	type MoonanRole, type MoonanUser,
} from "@moonan_ai/sdk";
```

`USER_ADMIN_API` 是 `1`；`UserAdminSnapshot` 带 `users` 与 `currentUserId`，`UserAdminUser` 含 `createdAt`/
`updatedAt`，密码散列永远不过这条边界。`UserAdminError.code` 可能是 `unauthorized`、`admin_required`、
`username_taken`、`last_admin`、`unknown_user` 等。

## 功能注册表

功能专属的注册表不属于 SDK。例如模型能力由 ai-gateway 自己定义并导出：

```js
import { ModelProviders } from "@moonan_ai/ai-gateway/model-provider";
```

`ModelProvider.list(principal)` 与 `runtime(principal)` 都是异步的、按传入账户读该账户的配置；消费方按 id
查找后把当前主体传进去。平台和 SDK 不需要认识 `ModelInfo`。后续的图像、语音等能力也应各自定义自己的注册表。

完整写法：<https://github.com/Pheobe-Southwood/Moonan/blob/main/docs/plugins.md> ·
词汇表：<https://github.com/Pheobe-Southwood/Moonan/blob/main/CONTEXT.md>

## 许可

MIT
