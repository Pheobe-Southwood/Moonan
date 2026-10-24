# 变更日志 · Changelog

## 0.0.1-alpha5

这一版把「插件」这件事推到 chord 的官方形态：插件是**独立包**，服务端与浏览器各有一个 facet。alpha4 里那两个半成品——内置插件住在主包里、面板清单由服务端维护——都消失了。

### 破坏性变更

- **面板不再属于内核**：`Panels` 注册表与 `PanelContribution` 移到新包 `@moonan_ai/web-api`，落在浏览器宿主上。`AppContract` 升到 **v2**，`panels` 字段删除；`PluginInfo` 增加了可选的 `web`（浏览器模块 URL）。任何读过 `app.panels` 的客户端都要改。
- **插件契约搬家**：`ChatContract`、`McpContract`、`LogsContract` 分别移到 `@moonan_ai/plugin-chat`、`-mcp`、`-logs` 的 `./contract` 入口。`ProvidersContract` 留在 `@moonan_ai/contracts`（它描述内核的模型数据），`@moonan_ai/plugin-providers` 仍然 re-export。
- **五个内置插件成为独立包**：`@moonan_ai/plugin-{agents,providers,chat,mcp,logs}`，全部公开发布，`@moonan_ai/moonan` 硬依赖它们。每个包导出 `.`（服务端 facet）、`./contract`、`./web`（浏览器 facet）。
- **开发环境单端口**：删掉 Vite dev server 与 21316 端口，`pnpm dev` 改成「一次完整构建 + 三个 watcher」，页面由 Node 在 21315 直接服务。没有 HMR。
- **内置插件清单 API 变了**：`builtinPlugins` 从常量数组变成函数，`BuiltinPlugin.module` 改名为 `server`，新增 `web`。`moonan/src/plugins/module-url.ts` 删除。

### 新增

- **`@moonan_ai/web-api`**：`Panels`、`PanelProps`（`{ host, user, locale }`）、`useRemote(host, contract, input)` / `useReadable` / `useAction`、`useT(messages)` 与一组共享组件。插件自己带文案，回退到 shell 的字典。
- **浏览器 facet 运行时加载（实验性）**：`index.html` 里的 import map 把 React、Chord、TypeBox、contracts、web-api 指到 `/runtime/*.js`（`scripts/build-runtime.mjs` 用 esbuild 生成），`packages/web/src/chord/facet-loader.ts` 自己实现 chord 的 `FacetLoader`。`GET /api/plugins` 返回 `experimental: true`，`POST /api/plugins/reload` 返回 `reloadBrowser: true`。
- **插件可以依赖插件**：facet 声明 `uses`，消费方 `self.get(OtherContract, {})`。`createMoonan({ sharedModules })` 把已安装插件包及其 `./contract` 子路径接进模块钩子。示例见 `examples/clock-plugin` 与 `examples/greeter-plugin`。
- **协议不匹配**：客户端装了 `onProtocolMismatch`，先整页刷新一次；10 秒内再次失败就显示横幅，不再刷新循环。
- **`examples/panel-plugin`**：没有构建步骤的第三方面板，证明 `web.js` 只要 import 共享运行时就能工作。

### 内部

- 内核的 `appFacet` 不再订阅 `Panels`，`core/src/facets.ts` 与 `core/src/server.ts` 里没有任何面板概念。
- 新增架构测试：`packages/moonan/test/layering.test.ts`（内核/契约/shell 不得 import 插件包、不得出现 `Panels`）与 `packages/moonan/test/cross-plugin.test.ts`（两个示例插件互相调用）。
- e2e 增加一个第三方面板：安装 `examples/panel-plugin`，断言标签页出现且渲染成功。

## 0.0.1-alpha4

这次是破坏性重构：内核不再认识「对话」「MCP」「日志」，它们都成了普通插件。

- **插件 API 重写**：删除 `@moonan_ai/plugin-sdk`、`defineServerPlugin` 与整个 `ServerHost`。插件导出 `defineFacet(...)`，用注册表贡献 Agent、工具、工具组与面板，用能力契约（`HostPaths`、`AgentAdmin`、`TranscriptAdmin`、`ModelAdmin`、`AppAdmin`）使用内核能力。
- **数据归属**：对话气泡搬到 `plugins-data/chat.db`，MCP 配置搬到 `plugins-data/mcp.db`，各自由插件用 `self.resource` 打开与迁移；内核库只保留设置、人设、转录与凭据。
- **破坏性迁移**：`chat_messages`、`mcp_servers`、`mcp_tools`、`plugin_state` 四张旧表被删除，**旧对话与 MCP 配置不迁移、不可恢复**。升级前请备份 `~/.moonan`。
- **回合语义**：`AgentContract.send` 不再等待整个回合，只入队并立即返回；回合跑在 `api.root` 里，重载时使用旧代码跑完。`self.task` 只保留可重启的后台活（对话合批）。
- **流式更新**：手写的 50 ms 定时器换成 `@earendil-works/chord/output` 的 `Progress`。
- **插件热重载**：新增 `POST /api/plugins/reload`，可带 `{"id":"chat"}`；状态、进行中的回合与插件数据库连接都会保留。
- **面板**：前端导航改由服务端 `panels` 注册表驱动；未知面板显示占位而不是崩掉。
- **内置插件加载**：内置与磁盘插件走同一条 `nodeLoader` 模块路径。
- **MCP 去内核化**：`McpService` 与 `@earendil-works/pi-mcp` 依赖从 `@moonan_ai/core` 移到内置 `mcp` 插件。

## 0.0.1-alpha3

- 对话工具 `act` 更名为 `send_message`：它向 WebUI 的对话窗口发送一条气泡，模型其余文本仍然是内心独白。
- 打开或切回 WebUI 对话面板不再向 Agent 发送「打开了窗口」的提示，也不会创建回合；只有用户输入才会触发模型。
- 升级时会把内置主 Agent 已保存的系统提示词里常见的 `act` 写法迁移为 `send_message`。如果你自定义过系统提示词且仍提到 `act`，请手动改成 `send_message`。
- `ChatContract` 移除 `enter` 方法；WebUI 与服务端需要使用同一个版本。

## 0.0.1-alpha2

- 默认监听 `0.0.0.0`，启动时打印局域网地址，方便通过 Tailscale 访问；同时提示界面没有鉴权。
- `--hostname 127.0.0.1` 仍然可以退回仅本机。
- 消息在回合结束的瞬间到达时不再丢失（改为排队，等 Agent 空闲后作为下一轮处理）。
- 磁盘插件必须是 ESM：`server.mjs`，或在插件目录放 `{"type": "module"}`；不符合时会被跳过并说明原因。
- 帮助文本不再硬编码版本号。

## 0.0.1-alpha1

第一个可用版本。

### 新增

- 对话：消息 2 秒合批、`act` 工具产出气泡、流式增量刷新。
- 日志：模型视角的完整记录，含思考、工具调用与工具结果，可展开。
- Agent：主 Agent 的名字、描述、人设变量、模型选择，保存即生效。
- 提供商：`pi-ai` 的内置提供商列表、自定义 OpenAI 兼容端点、明文本地密钥。
- MCP：stdio 与 Streamable HTTP 服务，工具逐个开关，只作用于主 Agent。
- 插件：五个面板本身即插件；`~/.moonan/plugins` 下的磁盘插件可注册 Agent 与 facet。
- CLI：`moonan --port --hostname --data-dir`。
- 中英双语界面，瑞士风格排版，端口 21315。

### 已知限制

- 没有停止按钮（契约中的 `interrupt` 已就绪，界面下个版本跟进）。
- OAuth 登录尚未实现，只支持 API 密钥。
- 磁盘插件的 `web.js` 会被提供，但外壳还没有面板位。
- 只有主 Agent 参与对话，多 Agent 界面推后。
