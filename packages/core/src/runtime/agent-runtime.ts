import type { Ctx } from "@earendil-works/chord";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AgentConfig, AgentStatus, AgentSummary, AgentToolContribution, AgentToolGroup } from "@moonan_ai/contracts";
import type { AgentDefinition } from "@moonan_ai/contracts";
import type { ModelRegistry } from "../models.js";
import type { Store } from "../storage/store.js";
import { renderTemplate, type Logger } from "../util.js";
import { AgentInstance, defaultConfig, type AgentCells } from "./agent-instance.js";

export interface AgentRuntimeDeps {
	store: Store;
	models: ModelRegistry;
	logger: Logger;
	/** Variables every agent can reference, owned by app settings rather than a plugin. */
	sceneVariables?: () => Record<string, string>;
}

/**
 * Owns every agent the registry declares.
 *
 * Definitions and tools come from Chord registries (`setDefinitions` / `setTools` are
 * called by the host's subscriptions), so this class never learns which plugin
 * contributed an agent. Instances are bound when an agent object's listener starts —
 * that is, at commit — so a reload that prepares and aborts leaves no trace here.
 */
export class AgentRuntime {
	private definitions = new Map<string, AgentDefinition>();
	private instances = new Map<string, AgentInstance>();
	private zombies = new Set<AgentInstance>();
	private toolTable: ReadonlyMap<string, AgentToolContribution> = new Map();
	private groupTable: ReadonlyMap<string, AgentToolGroup> = new Map();
	private readonly listeners = new Set<() => void>();
	private runFn: (<T>(fn: (ctx: Ctx) => T | Promise<T>) => Promise<T>) | undefined;
	private startRootFn: ((fn: (ctx: Ctx) => Promise<void>) => void) | undefined;

	constructor(private readonly deps: AgentRuntimeDeps) {}

	/** Called once per agent facet, from its setup: both keep the facet's host. */
	setRunner(
		run: <T>(fn: (ctx: Ctx) => T | Promise<T>) => Promise<T>,
		startRoot: (fn: (ctx: Ctx) => Promise<void>) => void,
	): void {
		this.runFn = run;
		this.startRootFn = startRoot;
	}

	/** Internal fan-out for status changes; not a plugin-facing API. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

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

	// --- registry inputs ------------------------------------------------

	setDefinitions(table: ReadonlyMap<string, AgentDefinition>): void {
		const next = new Map(table);
		for (const id of [...this.instances.keys()]) {
			if (!next.has(id)) this.retireAgent(id);
		}
		this.definitions = next;
		this.notify();
	}

	setTools(table: ReadonlyMap<string, AgentToolContribution>): void {
		this.toolTable = new Map(table);
		for (const [id, instance] of this.instances) {
			instance.setTools(this.toolsFor(id));
		}
	}

	setToolGroups(table: ReadonlyMap<string, AgentToolGroup>): void {
		this.groupTable = new Map(table);
		for (const [id, instance] of this.instances) {
			instance.setTools(this.toolsFor(id));
		}
	}

	/** Static contributions plus the groups evaluated now (a turn calls this again). */
	private toolsFor(id: string): AgentTool[] {
		const tools: AgentTool[] = [];
		for (const contribution of this.toolTable.values()) {
			if (contribution.agents && !contribution.agents.includes(id)) continue;
			tools.push(contribution.tool);
		}
		for (const group of this.groupTable.values()) {
			if (group.agents && !group.agents.includes(id)) continue;
			tools.push(...group.tools());
		}
		return tools;
	}

	// --- agents ---------------------------------------------------------

	has(id: string): boolean {
		return this.definitions.has(id);
	}

	definitionOf(id: string): AgentDefinition {
		const definition = this.definitions.get(id);
		if (!definition) throw new Error(`unknown agent "${id}"`);
		return definition;
	}

	ids(): string[] {
		return [...this.definitions.keys()];
	}

	initialConfig(id: string): AgentConfig {
		return defaultConfig(id, this.definitionOf(id), this.deps.store.getAgent(id)?.config);
	}

	/**
	 * Bind this agent object's cells to a runtime instance. Called from the facet's
	 * inbox listener, which starts at commit, so prepare never touches this map.
	 */
	bind(id: string, cells: AgentCells): AgentInstance {
		const existing = this.instances.get(id);
		if (existing && existing.cells === cells) return existing;
		if (!this.runFn || !this.startRootFn) throw new Error("agent runtime has no chord runner; the agent facet must be served first");
		const run = this.runFn;
		const startRoot = this.startRootFn;
		const instance = new AgentInstance(id, this.definitionOf(id), cells, {
			store: this.deps.store,
			models: this.deps.models,
			logger: this.deps.logger,
			run,
			startRoot,
			toolsFor: (agentId) => this.toolsFor(agentId),
			variablesFor: (agentId) => this.variablesFor(agentId),
			onStatusChange: () => this.notify(),
		});
		instance.setTools(this.toolsFor(id));
		this.instances.set(id, instance);
		if (existing) {
			this.zombies.add(existing);
			void existing.retire().finally(() => this.zombies.delete(existing));
		}
		this.notify();
		return instance;
	}

	private retireAgent(id: string): void {
		const instance = this.instances.get(id);
		if (!instance) return;
		this.instances.delete(id);
		this.zombies.add(instance);
		void instance.retire().finally(() => this.zombies.delete(instance));
	}

	statusOf(id: string): AgentStatus {
		return this.instances.get(id)?.status ?? "idle";
	}

	list(): AgentSummary[] {
		return [...this.definitions.entries()]
			.map(([id, definition]) => {
				const config = this.instances.get(id)?.config ?? this.initialConfig(id);
				const rendered = renderTemplate(config.name, this.variablesFor(id)).text.trim();
				return {
					id,
					pluginId: definition.pluginId,
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
		for (const [id, definition] of this.definitions) {
			const config = this.configOf(id);
			for (const variable of definition.variables) {
				if (!variable.global) continue;
				const value = config.variables.find((candidate) => candidate.key === variable.key)?.value;
				if (value !== undefined) variables[variable.key] = value;
			}
		}
		const own = this.definitions.get(agentId);
		if (own) {
			const config = this.configOf(agentId);
			for (const variable of own.variables) {
				const value = config.variables.find((candidate) => candidate.key === variable.key)?.value;
				if (value !== undefined) variables[variable.key] = value;
			}
		}
		return variables;
	}

	private configOf(id: string): AgentConfig {
		return this.instances.get(id)?.config ?? this.initialConfig(id);
	}

	/** Plugins use this to stay quiet until the user has picked a model. */
	canSend(id: string): boolean {
		if (!this.definitions.has(id)) return false;
		return this.configOf(id).model !== null;
	}

	/** Queue a user message and return: the turn runs in a root of its own. */
	async send(id: string, text: string): Promise<void> {
		if (!this.canSend(id)) throw new Error(`agent "${id}" has no model yet; pick one in Agent 管理`);
		const instance = this.instances.get(id);
		if (!instance) throw new Error(`agent "${id}" is not running yet`);
		await instance.enqueue(text);
	}

	interrupt(id: string): void {
		this.instances.get(id)?.interrupt();
	}

	async dispose(): Promise<void> {
		const all = [...this.instances.values(), ...this.zombies];
		this.instances.clear();
		this.zombies.clear();
		await Promise.all(all.map((instance) => instance.dispose()));
	}
}
