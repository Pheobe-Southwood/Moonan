# Moonan

一个本地运行的 AI 角色扮演工作台。用户描述一个角色，模型替这个角色说话，中间发生的一切都留在用户自己的机器上。

## 语言

**Agent**
一个可运行的角色实例：系统提示词、变量、模型、工具的组合。角色是内容，Agent 是执行它的东西。
_Avoid_: bot, 机器人, 实例

**角色（Character）**
用户想扮演对象的名字与人设。它在界面上是「你的角色」，在 Agent 里是几个变量。
_Avoid_: persona, 人设文件

**主 Agent（main agent）**
唯一的内置 Agent。对话窗、MCP 工具和用户昵称只作用于它。
_Avoid_: 默认 Agent, default bot

**变量（Variable）**
提示词里的具名占位符，例如 `{{botname}}`。每个变量有标签、类型、默认值和「是否全局」。
_Avoid_: 参数, 字段, placeholder

**全局变量（Global variable）**
所有 Agent 共用的变量。用户昵称也是其中一种。
_Avoid_: 共享变量

**回合（Turn）**
从用户消息交给模型，到 Agent 重新空闲的一次完整处理。一个回合里可能有多次模型调用和工具调用。回合跑在一个 **root** 里：`send` 只把消息放进队列就返回，root 在后台把它跑完。
_Avoid_: 轮次, 对话, session

**批次（Batch）**
一个合批窗口内收到的全部用户消息。它们作为一条带时间戳的说明交给模型。
_Avoid_: 打包, 合并消息

**气泡（Bubble）**
对话窗里的一行，属于用户或角色。
_Avoid_: 消息（消息是模型视角的东西，见「日志」）

**send_message**
角色对外说话的唯一动作。模型调用 `send_message` 工具，气泡才会出现；打开界面本身不会触发回合。
_Avoid_: act, reply, 回复

**内心独白（Inner monologue）**
模型输出但用户看不到的文本与推理过程，只存在于日志里。
_Avoid_: 草稿, 中间输出

**日志（Transcript）**
模型看到与说出的全部内容，包括系统提示词、批次说明、思考、工具调用与工具结果。它归内核所有（Agent 的记忆）；「日志面板」只是通过 `TranscriptAdmin` 读取它。
_Avoid_: 聊天记录, history

**提供商（Provider）**
提供模型的服务。内置提供商来自 `pi-ai`，也可以自定义一个兼容 OpenAI 的端点。
_Avoid_: 渠道, 供应商, API 源

**MCP 服务（MCP server）**
外部工具服务，通过 stdio 或 HTTP 接入，工具可以逐个开关。
_Avoid_: 插件（插件是 Moonan 的扩展单元）

**内核（Kernel）**
与插件相对的那一半：存储、模型网关、Agent 运行时、能力契约与 chord 宿主。它提供注册表与能力，但不认识任何具体面板。
_Avoid_: 核心, core, 服务端

**插件（Plugin）**
给 Moonan 增加 facet、注册表贡献与面板的扩展单元。五个内置面板本身就是插件；内置与磁盘插件走同一条加载路径。
_Avoid_: 模块, 扩展点

**注册表（Registry）**
插件向内核**贡献**东西的唯一声明式通道：Agent 定义、工具、工具组、面板。整表替换，随代码版本切换。
_Avoid_: 钩子, 回调, 事件总线

**能力契约（Capability contract）**
内核向插件**提供**能力的进程内契约：路径、投递消息、读转录、模型与密钥、应用设置。与注册表方向相反。
_Avoid_: 服务, API, 桥

**插件数据库（Plugin database）**
插件自己的 SQLite 文件，位于 `plugins-data/<id>.db`，由插件用 `self.resource` 打开与迁移。对话气泡、MCP 配置都在这里。
_Avoid_: 私有表, 共享库

**面板（Panel）**
浏览器里的一个顶层页面：对话、日志、Agent、提供商、MCP。由 `panels` 注册表声明，前端按 `id` 找组件。
_Avoid_: 页面, 标签页
