# 数据

## 位置

```
~/.moonan/                 # 默认，可用 --data-dir 改
├── moonan.db              # 内核库：设置、人设、转录、凭据
├── moonan.db-wal
├── moonan.db-shm
├── plugins-data/          # 每个插件自己的库
│   ├── chat.db            # 对话气泡
│   └── mcp.db             # MCP 服务与工具开关
└── plugins/               # 磁盘插件
```

所有结构化字段都是 JSON 文本列。**没有任何加密**——密钥是明文，人设是明文，对话也是明文。这既是设计选择（见 [ADR-0004](adr/0004-plaintext-local-storage.md)），也意味着这些文件等同于你的全部使用记录，别再发给别人。

## 归属

数据跟着**拥有它的东西**走（[ADR-0009](adr/0009-plugin-owned-data.md)）：

| 文件 | 表 | 谁写 |
|---|---|---|
| `moonan.db` | `settings` | 内核：用户昵称、语言等 |
| `moonan.db` | `agents` | 内核：`id` / `plugin_id` / `config`（JSON）/ `updated_at` |
| `moonan.db` | `agent_messages` | 内核：模型视角的一条消息（转录） |
| `moonan.db` | `credentials` | 内核：每个提供商的凭据（明文密钥） |
| `moonan.db` | `custom_providers` | 内核：自定义提供商定义 |
| `plugins-data/chat.db` | `messages` | chat 插件：`seq` / `agent_id` / `direction`（`in` \| `out`）/ `text` / `created_at` |
| `plugins-data/mcp.db` | `servers`、`tools` | MCP 插件：服务定义与逐个工具的开关 |

`agents.config` 大致长这样：

```json
{
	"name": "{{botname}}",
	"description": "在这里配置角色的人设",
	"model": { "provider": "deepseek", "id": "deepseek-chat" },
	"variables": [
		{ "key": "botname", "label": "角色名字", "type": "text", "value": "月见", "global": true },
		{ "key": "soul", "label": "角色人设", "type": "textarea", "value": "……", "global": true }
	]
}
```

`{{user}}` 不在 `variables` 里：它来自 `settings` 里的昵称，每次对话时作为场景变量注入。

## 自己看一眼

```bash
sqlite3 ~/.moonan/moonan.db ".tables"
sqlite3 ~/.moonan/moonan.db "select role, created_at from agent_messages order by seq desc limit 5"
sqlite3 ~/.moonan/moonan.db "select json_extract(config, '$.model') from agents"
sqlite3 ~/.moonan/plugins-data/chat.db "select direction, text from messages order by seq desc limit 5"
```

备份就是拷贝整个 `~/.moonan`。升级不需要停机；两个库都开了 WAL。

## 迁移

内核库的建表语句是一个按顺序执行的字符串数组（`packages/core/src/storage/db.ts`）。加表就往后追加一条，不要改已经发布过的那几条——用户手里的库已经执行过它们了。

插件库用 chord 的 `applySqliteMigrations`，迁移写在插件自己的模块里，元数据表叫 `schema_migrations`，版本从 1 连续递增。

## alpha3 → alpha4 的破坏性变更

alpha4 把对话与 MCP 数据搬进了插件库，并删除了三张旧表：

```sql
DROP TABLE chat_messages;
DROP TABLE mcp_servers;
DROP TABLE mcp_tools;
DROP TABLE plugin_state;
```

**旧对话与 MCP 配置不会迁移，升级后无法恢复。** `agents`（人设）与 `credentials`（密钥）不受影响。升级前请备份 `~/.moonan`。
