# 数据

## 位置

```
~/.moonan/            # 默认，可用 --data-dir 改
├── moonan.db         # SQLite，WAL 模式
├── moonan.db-wal
├── moonan.db-shm
└── plugins/          # 磁盘插件
```

所有结构化字段都是 JSON 文本列。**没有任何加密**——密钥是明文，人设是明文，对话也是明文。这既是设计选择（见 [ADR-0004](adr/0004-plaintext-local-storage.md)），也意味着这个文件等同于你的全部使用记录，别再发给别人。

## 表

| 表 | 内容 |
|---|---|
| `settings` | `key` / `value`：用户昵称、语言等 |
| `agents` | `id` / `plugin_id` / `config`（JSON）/ `updated_at` |
| `agent_messages` | 模型视角的一条消息：`agent_id` / `role` / `message`（JSON）/ `created_at` |
| `chat_messages` | 对话窗的一个气泡：`agent_id` / `direction`（`in` \| `out`）/ `text` / `created_at` |
| `credentials` | 每个提供商的凭据：`provider_id` / `type` / `payload`（JSON，明文密钥） |
| `custom_providers` | 自定义提供商定义：`id` / `payload`（JSON） |
| `mcp_servers` | MCP 服务：`id` / `payload`（JSON，含命令或 URL）/ `enabled` |
| `mcp_tools` | 工具开关：`server_id` / `tool_name` / `enabled` |
| `plugin_state` | 插件私有键值：`plugin_id` / `key` / `value`（JSON） |

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
sqlite3 ~/.moonan/moonan.db "select direction, text from chat_messages order by seq desc limit 5"
sqlite3 ~/.moonan/moonan.db "select json_extract(config, '$.model') from agents"
```

## 迁移

建表语句是一个按顺序执行的字符串数组（`packages/core/src/storage/db.ts`）。加表就往后追加一条，不要改已经发布过的那几条——用户手里的库已经执行过它们了。
