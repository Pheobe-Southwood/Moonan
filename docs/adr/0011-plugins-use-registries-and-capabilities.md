# 插件只通过注册表与能力契约访问内核

alpha3 的 `@moonan_ai/plugin-sdk` 把内核的七个部分包成一个 `ServerHost`：`agents`、`chat`、`logs`、`models`、`mcp`、`app`、`storage`。插件写一句 `host.chat.append(...)` 就能直接改内核的表。这让内核必须知道对话和 MCP 的存在，也让「插件能做什么」没法在类型之外被约束。

alpha4 删掉 `ServerHost` 与整个 SDK 包，改成两条方向相反的通道：

- **注册表（`self.register`）**：插件贡献 Agent 定义、工具、工具组、面板。声明式、整表替换、随代码版本切换；内核只按名字读取，不知道谁注册的（所以 `AgentDefinition` 里要自报 `pluginId`）。
- **能力契约（`self.get`）**：内核提供 `HostPaths`、`AgentAdmin`、`TranscriptAdmin`、`ModelAdmin`、`AppAdmin` 五个 `local()` 契约，全部 `{ lifetime: "host" }`。进程内直接调用，不过 wire，所以可以传原生值。

有一条例外值得写下来：MCP 的工具集在运行时变化（服务器连上、工具列表变更），而注册表是静态的、`self.register` 在同一个对象上不能重入。为此加了 `AgentToolGroups`：注册值是 `{ tools: () => AgentTool[] }`，内核在**每个回合开始**重读。这样既留在注册表模型里，又允许动态内容。

**Considered Options**: 保留 `ServerHost` 但只删 chat/logs/mcp 三个桥。被否掉的原因是剩下的 `agents`/`storage` 仍然是内核知识，而且一旦保留，第三方插件就有理由要求更多桥，解耦会退回去。

**Consequences**: 第三方插件的服务端 API 是破坏性变更：`defineServerPlugin` 与 `ServerHost` 都不存在了。`plugin_state` 表一并删除，插件改用 `plugins-data/<id>.db`。
