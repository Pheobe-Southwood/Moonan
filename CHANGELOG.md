# 更新日志

本项目的所有重要变更都记在这里。版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.0.1-rc.1] — 首个候选版本

从零实现的可运行骨架：单进程 WebUI + 真正的插件系统。

### 新增

**运行时**
- 单 Node 进程：HTTP + 自写 WebSocket（RFC 6455）服务 `127.0.0.1:21315`
- 数据面复用 `@earendil-works/pi-server`：每条连接包成 `ByteConnection`，路由/握手/取消/订阅全由它处理
- 组合层用 `@earendil-works/chord`：服务 token、facet、replicated state（含增量投递）
- Agent 循环用 `@earendil-works/pi-agent-core` 的 `runAgentLoop`，直接驱动，不经过 `Agent` 类
- `ActBlock`：本轮最后一条 tool result 末尾挂"下一步可用的 actions"，每次请求前先摘后挂，任意时刻一份，且不落库
- 三种入站消息语义：`steer`（回合结束后注入，不打断输出）/ `followUp`（停机前继续）/ `write`（只写历史）
- 每个 Agent 独立的对话历史，可并发运行

**持久化**
- `node:sqlite`（WAL），`~/.moonan/moonan.db`，`PRAGMA user_version` 驱动的迁移
- 明文凭据存储（实现 pi-ai 的 `CredentialStore`），保存后即时生效，无需重启
- 入站消息队列落库，进程重启不丢

**WebUI（React + Vite，瑞士风格）**
- 提供商：pi-ai 内置 provider 列表、API Key 配置、自定义 OpenAI 兼容 provider、OAuth 占位
- Agent：列表、名字/说明、`{{botname}}`/`{{soul}}` 变量、折叠的高级 SYSTEM PROMPT、模型与思考等级
- 对话：每个 Agent 一个入口；2 秒静默合并用户消息；打开窗口发排队通知；角色消息走 `write` 不触发生成
- 日志：任意 Agent 的完整原始上下文，role 标注、思维链与工具详情折叠、实时流式、虚拟滚动 + 分页

**插件（各自独立成包，每个一个 facet）**
- `@moonan/plugin-provider-panel`、`@moonan/plugin-agent-manager`、`@moonan/plugin-act`、
  `@moonan/plugin-conversation`、`@moonan/plugin-log-window`
- `@moonan/plugin-sdk`：服务契约、客户端 token、`definePlugin` / `onReady` 生命周期
- WebUI 的 Tab 组件（提供商 / Agent / 对话 / 日志）与宿主 shell 在 `@moonan/ui`；插件包目前只提供 node 侧 facet
  （原因见 ADR 0007）

**文档**
- `README.md`（含快速开始、架构、插件开发、已知限制）
- `CONTEXT.md`（术语表：Agent / SOUL / ActBlock / steer-followUp-write …）
- ADR 0001–0008，其中 0008 记录 Chord 的三个硬约束与两个引擎行为

**安装**
- `pnpm install:global`（= `pnpm build` + `cd apps/moonan && npm link`）：装好后 `moonan` 在任意目录可用
- 构建时给 `dist/cli.js` 补上可执行位；CLI 的 shebang 带上 `--disable-warning=ExperimentalWarning`，盖掉 `node:sqlite` 的启动噪音

### 已知问题

- OAuth 登录未实现（按钮禁用并标注）
- 插件 UI 是宿主约定，不是运行时可装载的 bundle（见 ADR 0007）
- 长会话没有压缩；`node:sqlite` 在 Node 22 会打印实验特性警告
- 日志窗展开后的行高是估算值，滚动位置的精度依赖它
