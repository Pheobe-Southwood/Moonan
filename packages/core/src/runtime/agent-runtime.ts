import type { Ctx } from "@earendil-works/chord";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AgentConfig, AgentStatus, AgentSummary, SendMode } from "@moonan_ai/contracts";
import type { AgentDefinition } from "@moonan_ai/plugin-sdk";
import type { ModelRegistry } from "../models.js";
import type { Store } from "../storage/store.js";
import { renderTemplate, type Logger } from "../util.js";
import { AgentInstance, defaultConfig, type AgentCells } from "./agent-instance.js";

interface DefinitionEntry {
	definition: AgentDefinition;
	pluginId: string;
}

export interface AgentRuntimeDeps {
	store: Store;
	models: ModelRegistry;
	logger: Logger;
	/** Variables every agent can reference, owned by app settings rather than a plugin. */
	sceneVariables?: () => Record<string, string>;
}

/**
 * Owns every registered agent: definitions from plugins, live pi-agent-core
 * instances created lazily when their chord object is first referenced.
 */
export class AgentRuntime {
	private readonly definitions = new Map<string, DefinitionEntry>();
	private readonly instances = new Map<string, AgentInstance>();
	private readonly pendingTools = new Map<string, AgentTool[]>();
	private readonly listeners = new Set<() => void>();
	private runFn: (<T>(fn: (ctx: Ctx) => T | Promise<T>) => Promise<T>) | undefined;

	constructor(private readonly deps: AgentRuntimeDeps) {}

	setRunner(run: <T>(fn: (ctx: Ctx) => T | Promise<T>) => Promise<T>): void {
		this.runFn = run;
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Re-publish index state after a change that did not go through `register`. */
	refresh(): void {
		this.notify();
	}

	private notify(): void {
		for (const listener of this.listeners) {
			try {
				listener();
			} catch (error) {
				this.deps.logger.warn("agent runtime listener failed", error);
			}
		}
	}

	register(definition: AgentDefinition, pluginId: string): void {
		if (this.definitions.has(definition.id)) {
			throw new Error(`agent "${definition.id}" is already registered`);
		}
		this.definitions.set(definition.id, { definition, pluginId });
		this.deps.logger.info(`registered agent "${definition.id}" from plugin "${pluginId}"`);
		this.notify();
	}

	has(id: string): boolean {
		return this.definitions.has(id);
	}

	definitionOf(id: string): AgentDefinition {
		const entry = this.definitions.get(id);
		if (!entry) throw new Error(`unknown agent "${id}"`);
		return entry.definition;
	}

	pluginOf(id: string): string {
		return this.definitions.get(id)?.pluginId ?? "unknown";
	}

	ids(): string[] {
		return [...this.definitions.keys()];
	}

	initialConfig(id: string): AgentConfig {
		return defaultConfig(id, this.definitionOf(id), this.deps.store.getAgent(id)?.config);
	}

	/** Called from the chord factory, once per agent object. */
	ensureInstance(id: string, cells: AgentCells): AgentInstance {
		const definition = this.definitionOf(id);
		const existing = this.instances.get(id);
		if (existing) {
			existing.dispose();
			this.instances.delete(id);
		}
		if (!this.runFn) throw new Error("agent runtime has no chord runner; the agent facet must be served first");
		const instance = new AgentInstance(id, definition, this.pluginOf(id), cells, {
			store: this.deps.store,
			models: this.deps.models,
			logger: this.deps.logger,
			run: this.runFn,
			variablesFor: (agentId) => this.variablesFor(agentId),
			onStatusChange: (agentId, status) => this.notifyStatus(agentId, status),
		});
		this.instances.set(id, instance);
		for (const tool of this.pendingTools.get(id) ?? []) instance.addTool(tool);
		this.pendingTools.delete(id);
		instance.start();
		this.notify();
		return instance;
	}

	private notifyStatus(agentId: string, status: AgentStatus): void {
		void agentId;
		void status;
		this.notify();
	}

	instanceOf(id: string): AgentInstance {
		const instance = this.instances.get(id);
		if (!instance) throw new Error(`agent "${id}" is not running yet`);
		return instance;
	}

	statusOf(id: string): AgentStatus {
		return this.instances.get(id)?.status ?? "idle";
	}

	list(): AgentSummary[] {
		return [...this.definitions.entries()]
			.map(([id, entry]) => {
				const config = this.instances.get(id)?.configSnapshot() ?? this.initialConfig(id);
				const rendered = renderTemplate(config.name, this.variablesFor(id)).text.trim();
				return {
					id,
					pluginId: entry.pluginId,
					name: rendered || id,
					description: config.description,
					model: config.model,
					status: this.statusOf(id),
					needsModel: config.model === null,
				} satisfies AgentSummary;
			})
			.sort((left, right) => left.id.localeCompare(right.id));
	}

	variablesFor(agentId: string): Record<string, string> {
		const variables: Record<string, string> = this.deps.sceneVariables?.() ?? {};
		for (const [id] of this.definitions) {
			const entry = this.definitions.get(id);
			if (!entry) continue;
			const config = this.configOf(id);
			for (const variable of entry.definition.variables) {
				if (!variable.global) continue;
				const value = config.variables.find((candidate) => candidate.key === variable.key)?.value;
				if (value !== undefined) variables[variable.key] = value;
			}
		}
		const own = this.definitions.get(agentId);
		if (own) {
			const config = this.configOf(agentId);
			for (const variable of own.definition.variables) {
				const value = config.variables.find((candidate) => candidate.key === variable.key)?.value;
				if (value !== undefined) variables[variable.key] = value;
			}
		}
		return variables;
	}

	private configOf(id: string): AgentConfig {
		const instance = this.instances.get(id);
		if (instance) return instance.configSnapshot();
		return this.initialConfig(id);
	}

	/** Plugins use this to stay quiet until the user has picked a model. */
	canSend(id: string): boolean {
		const entry = this.definitions.get(id);
		if (!entry) return false;
		return this.configOf(id).model !== null;
	}

	async send(id: string, text: string, mode: SendMode = "steer"): Promise<void> {
		await this.instanceOf(id).send(text, mode);
	}

	interrupt(id: string): void {
		this.instanceOf(id).interrupt();
	}

	registerTool(id: string, tool: AgentTool): void {
		const instance = this.instances.get(id);
		if (instance) {
			if (tool.name) {
				const previous = instance.toolNames();
				instance.addTool(tool);
				if (!previous.includes(tool.name)) this.notify();
			}
			return;
		}
		const pending = this.pendingTools.get(id) ?? [];
		pending.push(tool);
		this.pendingTools.set(id, pending);
	}

	removeTool(id: string, toolName: string): void {
		const instance = this.instances.get(id);
		if (instance) {
			instance.removeTool(toolName);
			this.notify();
		}
	}

	toolNames(id: string): string[] {
		return this.instances.get(id)?.toolNames() ?? (this.pendingTools.get(id) ?? []).map((tool) => tool.name);
	}

	dispose(): void {
		for (const instance of this.instances.values()) instance.dispose();
		this.instances.clear();
	}
}
