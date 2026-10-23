import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Every column that holds structured data stores JSON text, and nothing is
 * encrypted. The database is meant to be opened with any SQLite client.
 */
const MIGRATIONS: readonly string[] = [
	`
	CREATE TABLE settings (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL
	);
	CREATE TABLE agents (
		id TEXT PRIMARY KEY,
		plugin_id TEXT NOT NULL,
		config TEXT NOT NULL,
		updated_at INTEGER NOT NULL
	);
	CREATE TABLE agent_messages (
		seq INTEGER PRIMARY KEY AUTOINCREMENT,
		agent_id TEXT NOT NULL,
		role TEXT NOT NULL,
		message TEXT NOT NULL,
		created_at INTEGER NOT NULL
	);
	CREATE INDEX agent_messages_by_agent ON agent_messages (agent_id, seq);
	CREATE TABLE chat_messages (
		seq INTEGER PRIMARY KEY AUTOINCREMENT,
		agent_id TEXT NOT NULL,
		direction TEXT NOT NULL,
		text TEXT NOT NULL,
		created_at INTEGER NOT NULL
	);
	CREATE INDEX chat_messages_by_agent ON chat_messages (agent_id, seq);
	CREATE TABLE credentials (
		provider_id TEXT PRIMARY KEY,
		type TEXT NOT NULL,
		payload TEXT NOT NULL,
		updated_at INTEGER NOT NULL
	);
	CREATE TABLE custom_providers (
		id TEXT PRIMARY KEY,
		payload TEXT NOT NULL,
		updated_at INTEGER NOT NULL
	);
	CREATE TABLE mcp_servers (
		id TEXT PRIMARY KEY,
		payload TEXT NOT NULL,
		enabled INTEGER NOT NULL DEFAULT 1,
		updated_at INTEGER NOT NULL
	);
	CREATE TABLE mcp_tools (
		server_id TEXT NOT NULL,
		tool_name TEXT NOT NULL,
		enabled INTEGER NOT NULL DEFAULT 1,
		PRIMARY KEY (server_id, tool_name)
	);
	CREATE TABLE plugin_state (
		plugin_id TEXT NOT NULL,
		key TEXT NOT NULL,
		value TEXT NOT NULL,
		PRIMARY KEY (plugin_id, key)
	);
	`,
	// alpha2 saved the chat tool name inside agent configs; rename it in place so
	// an upgraded install keeps speaking through the current tool.
	`
	UPDATE agents
	SET config = replace(
		replace(
			replace(
				replace(config, '使用act控制其行为', '使用send_message控制其行为'),
				'\`act\`', '\`send_message\`'
			),
			'act 工具', 'send_message 工具'
		),
		'act工具', 'send_message工具'
	)
	WHERE id = 'main' AND plugin_id = 'agents' AND instr(config, 'act') > 0;
	`,
	// alpha4 moves chat and MCP data to their plugins' own databases and drops the
	// unused plugin KV table. No data is migrated: the old rows are discarded.
	`
	DROP TABLE IF EXISTS chat_messages;
	DROP TABLE IF EXISTS mcp_servers;
	DROP TABLE IF EXISTS mcp_tools;
	DROP TABLE IF EXISTS plugin_state;
	`,
];

export type Db = DatabaseSync;

export function databasePath(dataDir: string): string {
	return join(dataDir, "moonan.db");
}

export function openDatabase(dataDir: string): DatabaseSync {
	mkdirSync(dataDir, { recursive: true });
	const db = new DatabaseSync(databasePath(dataDir));
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA foreign_keys = ON");
	db.exec("PRAGMA busy_timeout = 5000");
	db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
	const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number | null } | undefined;
	const current = row?.version ?? 0;
	for (let index = current; index < MIGRATIONS.length; index += 1) {
		db.exec("BEGIN");
		try {
			db.exec(MIGRATIONS[index] as string);
			db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(index + 1, Date.now());
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	}
	return db;
}
