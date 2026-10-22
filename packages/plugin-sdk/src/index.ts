import { defineFacet, type FacetApi, type FacetDefinition } from "@earendil-works/chord";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type {
	ChatMessage,
	CustomProviderInput,
	McpServerInput,
	McpServerState,
	ModelInfo,
	ProviderInfo,
	SendMode,
	TranscriptEntry,
	Variable,
} from "@moonan/contracts";

/** How a plugin declares the agent it contributes. One definition = one agent instance in alpha1. */
export interface AgentDefinition {
	/** Unique across all plugins. */
	id: string;
	/** Display name template; may reference {{variables}}. */
	name: string;
	/** One-line description template. */
	description: string;
	/** System prompt template; may reference {{variables}}. */
	systemPrompt: string;
	/** Variables this agent owns. `global: true` makes them visible to every agent's template. */
	variables: AgentVariable[];
	/** Tools the agent starts with. The chat plugin adds `act` at install time. */
	tools?: AgentTool[];
	/** Default model (`provider/id`), if the plugin has an opinion. */
	defaultModel?: { provider: string; id: string };
}

export type AgentVariable = Omit<Variable, "value"> & { value?: string };

export interface AgentBridge {
	register(definition: AgentDefinition): void;
	registerTool(agentId: string, tool: AgentTool): void;
	removeTool(agentId: string, toolName: string): void;
	/** Queue a user message. Never interrupts an in-flight turn. */
	send(agentId: string, text: string, mode?: SendMode): void;
	/** False while the agent has no model, in which case `send` would only log an error. */
	canSend(agentId: string): boolean;
	interrupt(agentId: string): void;
	toolsOf(agentId: string): string[];
}

export interface ChatBridge {
	append(agentId: string, direction: "in" | "out", text: string): ChatMessage;
	page(agentId: string, options: { before?: number; limit: number }): ChatMessage[];
}

export interface LogBridge {
	page(agentId: string, options: { before?: number; limit: number }): TranscriptEntry[];
}

export interface ModelBridge {
	providers(): ProviderInfo[];
	models(providerId: string): ModelInfo[];
	setKey(providerId: string, key: string): Promise<void>;
	clearKey(providerId: string): Promise<void>;
	addCustom(input: CustomProviderInput): ProviderInfo;
	removeCustom(id: string): void;
	refresh(providerId?: string): Promise<void>;
	/** alpha1 placeholder; always rejects. */
	beginOauth(providerId: string): Promise<never>;
	readonly oauthNotice: string;
}

export interface McpBridge {
	list(): McpServerState[];
	add(input: McpServerInput): Promise<McpServerState>;
	remove(id: string): void;
	reconnect(id: string): Promise<void>;
	setToolEnabled(serverId: string, toolName: string, enabled: boolean): void;
	subscribe(listener: () => void): () => void;
}

export interface AppBridge {
	get(): { user: string; locale: string; version: string };
	update(patch: { user?: string; locale?: string }): void;
}

export interface PluginStorage {
	get<T>(key: string): Promise<T | undefined>;
	set(key: string, value: unknown): Promise<void>;
}

/** Everything a server-side plugin may touch. Cross-process data goes through `chord` contracts. */
export interface ServerHost {
	/** The plugin's own chord facet api: `serve`, `root`, `registry`, `signal`. */
	readonly chord: FacetApi<unknown>;
	readonly pluginId: string;
	readonly agents: AgentBridge;
	readonly chat: ChatBridge;
	readonly logs: LogBridge;
	readonly models: ModelBridge;
	readonly mcp: McpBridge;
	readonly app: AppBridge;
	readonly storage: PluginStorage;
	readonly log: {
		info(message: string, ...args: unknown[]): void;
		warn(message: string, ...args: unknown[]): void;
		error(message: string, ...args: unknown[]): void;
	};
}

export type ServerPluginSetup = (host: ServerHost) => void | Promise<void>;

type HostFactory = (api: FacetApi<unknown>, pluginId: string) => ServerHost;

let hostFactory: HostFactory | undefined;

/**
 * Called once by `@moonan/core` before any plugin is installed. Plugin code must
 * never call this; it exists so the SDK stays independent of the runtime.
 */
export function setServerHostFactory(factory: HostFactory): void {
	hostFactory = factory;
}

/**
 * Define a server-side plugin. The result is a plain chord `FacetDefinition`, so
 * `host.install()` and chord's `nodeLoader` accept it unchanged.
 */
export function defineServerPlugin(pluginId: string, setup: ServerPluginSetup): FacetDefinition<unknown> {
	return defineFacet<unknown>((api) => {
		if (!hostFactory) {
			throw new Error(
				`moonan plugin "${pluginId}" was installed before the Moonan host was ready (setServerHostFactory was never called)`,
			);
		}
		const host = hostFactory(api, pluginId);
		const fail = (error: unknown) => {
			console.error(`[moonan] plugin "${pluginId}" failed to set up`, error);
		};
		try {
			const result = setup(host);
			if (result && typeof (result as Promise<void>).then === "function") {
				(result as Promise<void>).catch(fail);
			}
		} catch (error) {
			fail(error);
		}
	});
}

export type { AgentTool };
