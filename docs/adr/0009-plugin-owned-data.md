# 数据归插件所有，转录归内核

alpha3 把对话气泡、MCP 配置和模型转录都放在 `moonan.db` 里，靠 `plugin_id`/`agent_id` 划分命名空间。命名空间只是约定：任何插件都能读写任何一张表，内核也不知道「对话」是什么，却要替它写 SQL。

alpha4 按「这份数据是谁的记忆」来分：

- **转录（`agent_messages`）归内核**。它是 Agent 的记忆：运行时启动时要读它、回合结束要写它、重载后要用它校准水位。把它挪进插件，内核就得反过来通过契约去读自己的运行时状态。
- **对话气泡、MCP 配置归插件**：各自一个 `plugins-data/<id>.db`，由插件用 `self.resource` 打开，用 chord 的 `applySqliteMigrations` 迁移。内核只给一个 `HostPaths.dataDir`，不碰表结构。

**Considered Options**: 继续用单文件加表前缀、由内核提供 `storage.query(prefix, …)`。被否掉的原因是前缀无法强制：同一进程里的插件仍可直接打开数据库；而且这等于把 SQL 方言暴露成内核 API。另一个选项是事件溯源——从转录实时重组对话窗——但合批不可逆、2 秒延迟和解析脆弱都让它不成立。

**Consequences**: 升级到 alpha4 会直接 `DROP` 三张旧表，旧对话与 MCP 配置不迁移（破坏性变更，见 `docs/data.md`）。备份单位从「一个文件」变成「一个目录」。
