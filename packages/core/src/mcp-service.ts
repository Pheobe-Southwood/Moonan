import { McpClient, StdioTransport, StreamableHttpTransport, toLlmContent, type Tool } from "@earendil-works/pi-mcp";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { McpServerInput, McpServerState } from "@moonan/contracts";
import { Type } from "typebox";
import type { AgentRuntime } from "./runtime/agent-runtime.js";
import type { Store } from "./storage/store.js";
import type { Logger } from "./util.js";

/** alpha1 attaches MCP tools to the main agent only. */
export const MCP_AGENT_ID = "main";

interface ServerRuntime {
	id: string;
	input: McpServerInput;
	client?: McpClient;
	status: McpServerState["status"];
	error?: string;
	tools: Tool[];
	agentTools: Map<string, AgentTool>;
}

function toolName(serverId: string, name: string): string {
	return `mcp__${serverId}__${name}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

function targetOf(input: McpServerInput): string {
	if (input.transport === "http") return input.url ?? "";
	return [input.command, ...(input.args ?? [])].filter(Boolean).join(" ");
}

export class McpService {
	private readonly servers = new Map<string, ServerRuntime>();
	private readonly listeners = new Set<() => void>();
	private disposed = false;

	constructor(
		private readonly store: Store,
		private readonly agents: AgentRuntime,
		private readonly logger: Logger,
	) {}

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
		const overrides = this.store.listToolOverrides(server.id);
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
				enabled: overrides.get(tool.name) ?? true,
			})),
		};
	}

	async restore(): Promise<void> {
		for (const row of this.store.listMcpServers()) {
			if (!row.enabled) continue;
			this.servers.set(row.id, {
				id: row.id,
				input: row.input,
				status: "idle",
				tools: [],
				agentTools: new Map(),
			});
		}
		await Promise.all([...this.servers.keys()].map((id) => this.connect(id)));
	}

	async add(input: McpServerInput): Promise<McpServerState> {
		const id = `mcp-${Date.now().toString(36)}`;
		const server: ServerRuntime = { id, input, status: "idle", tools: [], agentTools: new Map() };
		this.servers.set(id, server);
		this.store.saveMcpServer(id, input);
		await this.connect(id);
		return this.describe(server);
	}

	remove(id: string): void {
		const server = this.servers.get(id);
		if (server) {
			for (const name of server.agentTools.keys()) this.agents.removeTool(MCP_AGENT_ID, name);
			void server.client?.close();
			this.servers.delete(id);
		}
		this.store.deleteMcpServer(id);
		this.emit();
	}

	async reconnect(id: string): Promise<void> {
		await this.connect(id);
	}

	setToolEnabled(serverId: string, name: string, enabled: boolean): void {
		const server = this.servers.get(serverId);
		if (!server) throw new Error(`unknown MCP server "${serverId}"`);
		this.store.setToolEnabled(serverId, name, enabled);
		this.syncTools(server);
		this.emit();
	}

	private syncTools(server: ServerRuntime): void {
		const overrides = this.store.listToolOverrides(server.id);
		for (const [name, agentTool] of server.agentTools) {
			const enabled = overrides.get(name) ?? true;
			if (enabled) this.agents.registerTool(MCP_AGENT_ID, agentTool);
			else this.agents.removeTool(MCP_AGENT_ID, agentTool.name);
		}
	}

	async connect(id: string): Promise<void> {
		const server = this.servers.get(id);
		if (!server) return;
		await server.client?.close().catch(() => undefined);
		server.client = undefined;
		server.agentTools.clear();
		for (const tool of server.tools) this.agents.removeTool(MCP_AGENT_ID, toolName(id, tool.name));
		server.tools = [];
		server.status = "connecting";
		server.error = undefined;
		this.emit();
		try {
			const client = new McpClient({ name: "moonan", version: "0.0.1-alpha1" });
			const transport =
				server.input.transport === "stdio"
					? new StdioTransport({
							command: server.input.command ?? "",
							args: server.input.args ?? [],
							...(server.input.env ? { env: server.input.env } : {}),
							stderr: "pipe",
							onStderr: (chunk: string) => this.logger.warn(`[${server.input.name}] ${chunk.trim()}`),
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
			this.logger.info(`MCP server "${server.input.name}" connected with ${server.tools.length} tools`);
		} catch (error) {
			server.status = "error";
			server.error = error instanceof Error ? error.message : String(error);
			this.logger.error(`MCP server "${server.input.name}" failed`, error);
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
			const agentTool: AgentTool = {
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
			};
			server.agentTools.set(tool.name, agentTool);
		}
		this.syncTools(server);
		this.emit();
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		await Promise.all(
			[...this.servers.values()].map(async (server) => {
				await server.client?.close().catch(() => undefined);
			}),
		);
		this.servers.clear();
	}
}
