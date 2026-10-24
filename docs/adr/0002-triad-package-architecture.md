# 三个包：宿主、SDK、外壳

旧仓库有七个包（`contracts`、`web-api`、`core`、`web`、`moonan`，加测试与示例），它们之间的边界是按「历史上谁先被拆出来」划的，不是按职责划的：`core` 与 `moonan` 都在做服务端启动，`contracts` 与 `web-api` 都在给插件作者提供东西，一个插件作者要装两个包才知道自己能用什么。

基座重做时按职责重新划分，只留三个：

| 包 | 职责 | 面向谁 |
|---|---|---|
| `@moonan_ai/sdk` | 契约、注册表、浏览器钩子。根入口给两端与服务端用，`./web` 子路径给浏览器切面用。 | 插件作者 |
| `@moonan_ai/web` | 浏览器外壳与共享运行时打包器（`private`，不发布）。 | 基座自己 |
| `@moonan_ai/moonan` | 服务端宿主、单端口网关、插件装载与 CLI。 | 使用者 |

关键在于 `sdk` 用**子路径导出**而不是拆包：Chord 自己就是这么做的（`.`、`/node`、`/output`、`/sqlite`…）。一个插件作者的 `package.json` 只需要两行依赖——`@moonan_ai/sdk` 与 `@earendil-works/chord`——就能写完服务端切面和浏览器切面。

**Considered Options**

1. 继续拆成 `contracts` + `web-api`。被否掉：两者都是插件作者的单向依赖，拆开只是让作者多写一行 `import`，并且制造了「契约属于谁」的伪问题。
2. 把 `core` 与 `moonan` 合成一个包之后仍命名为 `core`。被否掉：`moonan` 已经是对外发布的二进制名，`npx @moonan_ai/moonan` 是用户的入口；保留发布包名、把源码目录叫 `substrate`，可以让「可发布的包」与「它在这台机器上扮演的角色」各自说清楚。

**Consequences**

- 插件作者不必知道 `sdk` 内部怎么分包；`./web` 子路径是他们唯一需要记住的第二入口。
- 基座少一个包，就少一次版本联动、少一处循环依赖的可能。
- `packages/substrate` 的目录名与包名 `@moonan_ai/moonan` 不同，是刻意的：目录说角色，包名说发布身份。
