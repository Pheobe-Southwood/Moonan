import { McpClient, StdioTransport, StreamableHttpTransport, toLlmContent, type Tool } from "@earendil-works/pi-mcp";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { SqliteDatabase } from "@earendil-works/chord/sqlite";
import type { McpServerInput, McpServerState } from "@moonan_ai/contracts";
import { Type } from "typebox";

/** MCP tools attach to the main agent only. */
export const MCP_AGENT_ID = "main";
const VERSION = "0.0.1-alpha4";

interface ServerRuntime {
	id: string;
	input: McpServerInput;
	client?: McpClient;
	status: McpServerState["status"];
	error?: string;
	tools: Tool[];
	agentTools: Map<string, AgentTool>;
	enabled: Map<string, boolean>;
}

function toolName(serverId: string, name: string): string {
	return `mcp__${serverId}__${name}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

function targetOf(input: McpServerInput): string {
	if (input.transport === "http") return input.url ?? "";
	return [input.command, ...(input.args ?? [])].filter(Boolean).join(" ");
}

/**
 * MCP servers, owned by the plugin: its own SQLite file, its own connection pool.
 * Tools are exposed to the kernel through a tool group, so a server that connects
 * after the plugin loaded still reaches the next turn.
 */
export class McpService {
	private readonly servers = new Map<string, ServerRuntime>();
	private readonly listeners = new Set<() => void>();
	private disposed = false;
	private restored = false;

	constructor(private readonly db: SqliteDatabase) {}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(): void {
		if (this.disposed) return;
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				// ignore
			}
		}
	}

	list(): McpServerState[] {
		return [...this.servers.values()].map((server) => this.describe(server));
	}

	private describe(server: ServerRuntime): McpServerState {
		return {
			id: server.id,
			name: server.input.name,
			transport: server.input.transport,
			target: targetOf(server.input),
			status: server.status,
			...(server.error ? { error: server.error } : {}),
			tools: server.tools.map((tool) => ({
				name: tool.name,
				description: tool.description ?? tool.name,
				enabled: server.enabled.get(tool.name) ?? true,
			})),
		};
	}

	/** Tools the model may call right now: connected servers, enabled tools only. */
	currentTools(): AgentTool[] {
		const tools: AgentTool[] = [];
		for (const server of this.servers.values()) {
			for (const [name, tool] of server.agentTools) {
				if (server.enabled.get(name) ?? true) tools.push(tool);
			}
		}
		return tools;
	}

	async restore(): Promise<void> {
		if (this.restored) return;
		this.restored = true;
		const rows = await this.db.all<{ id: string; payload: string; enabled: number }>(
			"SELECT id, payload, enabled FROM servers ORDER BY rowid",
		);
		for (const row of rows) {
			const input = JSON.parse(row.payload) as McpServerInput;
			if (!row.enabled) continue;
			this.servers.set(row.id, {
				id: row.id,
				input,
				status: "idle",
				tools: [],
				agentTools: new Map(),
				enabled: await this.overrides(row.id),
			});
		}
		await Promise.all([...this.servers.keys()].map((id) => this.connect(id)));
	}

	private async overrides(serverId: string): Promise<Map<string, boolean>> {
		const rows = await this.db.all<{ tool_name: string; enabled: number }>(
			"SELECT tool_name, enabled FROM tools WHERE server_id = ?",
			serverId,
		);
		return new Map(rows.map((row) => [row.tool_name, Number(row.enabled) === 1] as const));
	}

	async add(input: McpServerInput): Promise<McpServerState> {
		const id = `mcp-${Date.now().toString(36)}`;
		const server: ServerRuntime = { id, input, status: "idle", tools: [], agentTools: new Map(), enabled: new Map() };
		this.servers.set(id, server);
		await this.db.run(
			"INSERT INTO servers (id, payload, enabled, updated_at) VALUES (?, ?, 1, ?)",
			id,
			JSON.stringify(input),
			Date.now(),
		);
		await this.connect(id);
		return this.describe(server);
	}

	async remove(id: string): Promise<void> {
		const server = this.servers.get(id);
		if (server) {
			await server.client?.close().catch(() => undefined);
			this.servers.delete(id);
		}
		await this.db.run("DELETE FROM servers WHERE id = ?", id);
		await this.db.run("DELETE FROM tools WHERE server_id = ?", id);
		this.emit();
	}

	async reconnect(id: string): Promise<void> {
		await this.connect(id);
	}

	async setToolEnabled(serverId: string, name: string, enabled: boolean): Promise<void> {
		const server = this.servers.get(serverId);
		if (!server) throw new Error(`unknown MCP server "${serverId}"`);
		server.enabled.set(name, enabled);
		await this.db.run(
			`INSERT INTO tools (server_id, tool_name, enabled) VALUES (?, ?, ?)
			 ON CONFLICT(server_id, tool_name) DO UPDATE SET enabled = excluded.enabled`,
			serverId,
			name,
			enabled ? 1 : 0,
		);
		this.emit();
	}

	async connect(id: string): Promise<void> {
		const server = this.servers.get(id);
		if (!server) return;
		await server.client?.close().catch(() => undefined);
		server.client = undefined;
		server.agentTools.clear();
		server.tools = [];
		server.status = "connecting";
		server.error = undefined;
		this.emit();
		try {
			const client = new McpClient({ name: "moonan", version: VERSION });
			const transport =
				server.input.transport === "stdio"
					? new StdioTransport({
							command: server.input.command ?? "",
							args: server.input.args ?? [],
							...(server.input.env ? { env: server.input.env } : {}),
							stderr: "pipe",
							onStderr: (chunk: string) => console.warn(`[${server.input.name}] ${chunk.trim()}`),
						})
					: new StreamableHttpTransport({
							url: server.input.url ?? "",
							...(server.input.headers ? { headers: server.input.headers } : {}),
						});
			await client.connect(transport);
			server.client = client;
			client.onClose(() => {
				server.status = "error";
				server.error = "connection closed";
				this.emit();
			});
			client.onNotification("notifications/tools/list_changed", () => {
				void this.refreshTools(server);
			});
			await this.refreshTools(server);
			server.status = "connected";
			server.error = undefined;
			console.info(`MCP server "${server.input.name}" connected with ${server.tools.length} tools`);
		} catch (error) {
			server.status = "error";
			server.error = error instanceof Error ? error.message : String(error);
			console.error(`MCP server "${server.input.name}" failed`, error);
		}
		this.emit();
	}

	private async refreshTools(server: ServerRuntime): Promise<void> {
		const client = server.client;
		if (!client) return;
		const tools = await client.listTools();
		server.tools = tools;
		server.agentTools.clear();
		for (const tool of tools) {
			const name = toolName(server.id, tool.name);
			server.agentTools.set(tool.name, {
				name,
				label: tool.title ?? tool.name,
				description: tool.description ?? tool.name,
				parameters: Type.Unsafe<Record<string, unknown>>({
					...tool.inputSchema,
					type: "object",
					properties: tool.inputSchema.properties ?? {},
				}),
				execute: async (_toolCallId, params, signal) => {
					const result = await client.callTool(tool.name, params as Record<string, unknown>, { signal });
					return {
						content: toLlmContent(result) as unknown as AgentToolResult["content"],
						details: undefined,
						isError: result.isError === true,
					};
				},
			});
		}
		this.emit();
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		await Promise.all([...this.servers.values()].map((server) => server.client?.close().catch(() => undefined)));
		this.servers.clear();
	}
}
