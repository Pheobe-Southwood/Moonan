# 插件可以依赖插件

alpha4 的五个内置插件住在 `packages/moonan/src/plugins/*`，共享宿主进程的模块图。想复用别人提供的能力，只能 `import` 对方文件——也就是「插件之间互相 import 源码」，这与「插件是独立单元」直接矛盾。第三方插件更糟：它没有地方放依赖。

alpha5 把插件拆成可以独立发布的包，并且明确**插件之间可以通过契约互相调用**：

- 发布形态统一为三个入口：`.`（服务端 facet）、`./contract`（这个插件导出的 `local()` 契约）、`./web`（浏览器 facet）。
- 消费方 `self.get(OtherContract, {})`；facet 声明 `uses: [OtherContract]`，热重载重新提供该契约时 chord 会把消费方重新绑定。
- 磁盘插件不需要 `node_modules`：契约的指纹由「名字 + 版本 + 输入 schema + 成员」算出，所以在自己文件里写出逐字相同的定义，就是同一个契约。例子见 `examples/clock-plugin`（提供）与 `examples/greeter-plugin`（消费）。
- `createMoonan({ sharedModules })` 会把已安装的插件包及其 `./contract` 子路径也注册进模块钩子，所以磁盘插件可以 `import "@moonan_ai/plugin-chat/contract"`。

这一版**内置插件之间仍然零依赖**，只有两个例子插件演示机制。原因是内置插件若互相依赖，`@moonan_ai/moonan` 的依赖图会立刻把「哪些能力属于内核」搅浑；先让机制在外部可验证，再决定内置插件要不要用。

有一处例外要写进契约里：`ProvidersContract`（模型目录与密钥）留在 `@moonan_ai/contracts`，因为它描述的是**内核的数据**，providers 插件只是它的面板；Agent 面板需要按提供商列出模型，如果契约属于 providers 包，agents 包就得依赖 providers 包。`@moonan_ai/plugin-providers` 仍然 re-export 这个契约，写插件时看不出差别。

**Considered Options**: 只允许插件依赖内核（否：等于禁止插件复用，而 MCP、日志这类面板之间的复用是真实需求）；给每个插件一个带 `node_modules` 的安装目录（否：pnpm/npm 的解析规则会把同一份 chord 装成两份，注册表与契约都会对不上）。

**Consequences**: 契约是公开 API，改它的 schema 必须升 `version`，否则 reload 会以 `contract_mismatch` 拒绝。`uses` 只在 reload 时校验、不在 load 时校验，所以「依赖的插件没装」表现为 `self.get` 失败；文档里要写清加载顺序（提供方先加载）。
