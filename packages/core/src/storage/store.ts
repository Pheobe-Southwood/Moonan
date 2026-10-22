import type { ChatMessage, AgentConfig, CustomProviderInput, McpServerInput, TranscriptEntry } from "@moonan/contracts";
import type { Credential, CredentialInfo } from "@earendil-works/pi-ai";
import type { Message } from "@earendil-works/pi-ai";
import type { Db } from "./db.js";

export interface AgentRow {
	id: string;
	pluginId: string;
	config: AgentConfig;
}

export interface StoredMessage {
	seq: number;
	agentId: string;
	role: string;
	message: Message;
	createdAt: number;
}

export interface McpServerRow {
	id: string;
	input: McpServerInput;
	enabled: boolean;
}

type Raw = Record<string, unknown>;

function parseJson<T>(value: unknown, fallback: T): T {
	if (typeof value !== "string") return fallback;
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

export class Store {
	constructor(readonly db: Db) {}

	// --- settings -------------------------------------------------------

	getSetting(key: string): string | undefined {
		const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as Raw | undefined;
		return typeof row?.value === "string" ? row.value : undefined;
	}

	setSetting(key: string, value: string): void {
		this.db
			.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
			.run(key, value);
	}

	// --- agents ---------------------------------------------------------

	getAgent(id: string): AgentRow | undefined {
		const row = this.db.prepare("SELECT id, plugin_id, config FROM agents WHERE id = ?").get(id) as Raw | undefined;
		if (!row) return undefined;
		return {
			id: String(row.id),
			pluginId: String(row.plugin_id),
			config: parseJson<AgentConfig>(row.config, {
				name: id,
				description: "",
				systemPrompt: "",
				variables: [],
				model: null,
			}),
		};
	}

	saveAgent(id: string, pluginId: string, config: AgentConfig): void {
		this.db
			.prepare(
				`INSERT INTO agents (id, plugin_id, config, updated_at) VALUES (?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET plugin_id = excluded.plugin_id, config = excluded.config, updated_at = excluded.updated_at`,
			)
			.run(id, pluginId, JSON.stringify(config), Date.now());
	}

	// --- transcript -----------------------------------------------------

	appendMessage(agentId: string, message: Message): TranscriptEntry {
		const createdAt = Date.now();
		const info = this.db
			.prepare("INSERT INTO agent_messages (agent_id, role, message, created_at) VALUES (?, ?, ?, ?)")
			.run(agentId, message.role, JSON.stringify(message), createdAt);
		return {
			seq: Number(info.lastInsertRowid),
			role: message.role as TranscriptEntry["role"],
			message,
			createdAt,
		};
	}

	countMessages(agentId: string): number {
		const row = this.db.prepare("SELECT COUNT(*) AS count FROM agent_messages WHERE agent_id = ?").get(agentId) as Raw | undefined;
		return Number(row?.count ?? 0);
	}

	/** Newest-first page, returned oldest-first so the caller can just append it. */
	pageMessages(agentId: string, options: { before?: number; limit: number }): TranscriptEntry[] {
		const limit = Math.max(1, Math.min(options.limit, 500));
		const rows = (
			options.before === undefined
				? this.db
						.prepare("SELECT seq, role, message, created_at FROM agent_messages WHERE agent_id = ? ORDER BY seq DESC LIMIT ?")
						.all(agentId, limit)
				: this.db
						.prepare(
							"SELECT seq, role, message, created_at FROM agent_messages WHERE agent_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?",
						)
						.all(agentId, options.before, limit)
		) as Raw[];
		return rows
			.map((row) => ({
				seq: Number(row.seq),
				role: String(row.role) as TranscriptEntry["role"],
				message: parseJson<Message>(row.message, { role: "user", content: "", timestamp: 0 } as Message),
				createdAt: Number(row.created_at),
			}))
			.reverse();
	}

	allMessages(agentId: string): Message[] {
		const rows = this.db
			.prepare("SELECT message FROM agent_messages WHERE agent_id = ? ORDER BY seq ASC")
			.all(agentId) as Raw[];
		return rows.map((row) => parseJson<Message>(row.message, { role: "user", content: "", timestamp: 0 } as Message));
	}

	// --- chat -----------------------------------------------------------

	appendChat(agentId: string, direction: ChatMessage["direction"], text: string): ChatMessage {
		const createdAt = Date.now();
		const info = this.db
			.prepare("INSERT INTO chat_messages (agent_id, direction, text, created_at) VALUES (?, ?, ?, ?)")
			.run(agentId, direction, text, createdAt);
		return { seq: Number(info.lastInsertRowid), direction, text, createdAt };
	}

	pageChat(agentId: string, options: { before?: number; limit: number }): ChatMessage[] {
		const limit = Math.max(1, Math.min(options.limit, 500));
		const rows = (
			options.before === undefined
				? this.db
						.prepare("SELECT seq, direction, text, created_at FROM chat_messages WHERE agent_id = ? ORDER BY seq DESC LIMIT ?")
						.all(agentId, limit)
				: this.db
						.prepare(
							"SELECT seq, direction, text, created_at FROM chat_messages WHERE agent_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?",
						)
						.all(agentId, options.before, limit)
		) as Raw[];
		return rows
			.map((row) => ({
				seq: Number(row.seq),
				direction: String(row.direction) as ChatMessage["direction"],
				text: String(row.text),
				createdAt: Number(row.created_at),
			}))
			.reverse();
	}

	// --- credentials ----------------------------------------------------

	getCredential(providerId: string): Credential | undefined {
		const row = this.db.prepare("SELECT payload FROM credentials WHERE provider_id = ?").get(providerId) as Raw | undefined;
		if (!row) return undefined;
		return parseJson<Credential | undefined>(row.payload, undefined);
	}

	listCredentialInfos(): CredentialInfo[] {
		const rows = this.db.prepare("SELECT provider_id, type FROM credentials ORDER BY provider_id").all() as Raw[];
		return rows.map((row) => ({
			providerId: String(row.provider_id),
			type: String(row.type) as CredentialInfo["type"],
		}));
	}

	putCredential(providerId: string, credential: Credential): void {
		this.db
			.prepare(
				`INSERT INTO credentials (provider_id, type, payload, updated_at) VALUES (?, ?, ?, ?)
				 ON CONFLICT(provider_id) DO UPDATE SET type = excluded.type, payload = excluded.payload, updated_at = excluded.updated_at`,
			)
			.run(providerId, credential.type, JSON.stringify(credential), Date.now());
	}

	deleteCredential(providerId: string): void {
		this.db.prepare("DELETE FROM credentials WHERE provider_id = ?").run(providerId);
	}

	// --- custom providers -----------------------------------------------

	listCustomProviders(): CustomProviderInput[] {
		const rows = this.db.prepare("SELECT payload FROM custom_providers ORDER BY id").all() as Raw[];
		return rows.map((row) => parseJson<CustomProviderInput>(row.payload, { id: "", name: "", baseUrl: "", api: "", models: [] }));
	}

	saveCustomProvider(input: CustomProviderInput): void {
		this.db
			.prepare(
				`INSERT INTO custom_providers (id, payload, updated_at) VALUES (?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
			)
			.run(input.id, JSON.stringify(input), Date.now());
	}

	deleteCustomProvider(id: string): void {
		this.db.prepare("DELETE FROM custom_providers WHERE id = ?").run(id);
		this.db.prepare("DELETE FROM credentials WHERE provider_id = ?").run(id);
	}

	// --- mcp ------------------------------------------------------------

	listMcpServers(): McpServerRow[] {
		const rows = this.db.prepare("SELECT id, payload, enabled FROM mcp_servers ORDER BY rowid").all() as Raw[];
		return rows.map((row) => ({
			id: String(row.id),
			input: parseJson<McpServerInput>(row.payload, { name: "", transport: "stdio" }),
			enabled: Number(row.enabled) === 1,
		}));
	}

	saveMcpServer(id: string, input: McpServerInput): void {
		this.db
			.prepare(
				`INSERT INTO mcp_servers (id, payload, updated_at) VALUES (?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
			)
			.run(id, JSON.stringify(input), Date.now());
	}

	deleteMcpServer(id: string): void {
		this.db.prepare("DELETE FROM mcp_servers WHERE id = ?").run(id);
		this.db.prepare("DELETE FROM mcp_tools WHERE server_id = ?").run(id);
	}

	listToolOverrides(serverId: string): Map<string, boolean> {
		const rows = this.db.prepare("SELECT tool_name, enabled FROM mcp_tools WHERE server_id = ?").all(serverId) as Raw[];
		return new Map(rows.map((row) => [String(row.tool_name), Number(row.enabled) === 1] as const));
	}

	setToolEnabled(serverId: string, toolName: string, enabled: boolean): void {
		this.db
			.prepare(
				`INSERT INTO mcp_tools (server_id, tool_name, enabled) VALUES (?, ?, ?)
				 ON CONFLICT(server_id, tool_name) DO UPDATE SET enabled = excluded.enabled`,
			)
			.run(serverId, toolName, enabled ? 1 : 0);
	}

	// --- plugin state ---------------------------------------------------

	getPluginState<T>(pluginId: string, key: string): T | undefined {
		const row = this.db
			.prepare("SELECT value FROM plugin_state WHERE plugin_id = ? AND key = ?")
			.get(pluginId, key) as Raw | undefined;
		return parseJson<T | undefined>(row?.value, undefined);
	}

	setPluginState(pluginId: string, key: string, value: unknown): void {
		this.db
			.prepare(
				`INSERT INTO plugin_state (plugin_id, key, value) VALUES (?, ?, ?)
				 ON CONFLICT(plugin_id, key) DO UPDATE SET value = excluded.value`,
			)
			.run(pluginId, key, JSON.stringify(value));
	}
}
