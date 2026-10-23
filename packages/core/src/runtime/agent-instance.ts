import type { Cell, Ctx } from "@earendil-works/chord";
import { Progress, utf8ByteLength } from "@earendil-works/chord/output";
import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type {
	AgentConfig,
	AgentConfigPatch,
	AgentDefinition,
	AgentStatus,
	LiveMessage,
	LiveTool,
	Variable,
} from "@moonan_ai/contracts";
import type { ModelRegistry } from "../models.js";
import type { Store } from "../storage/store.js";
import { renderTemplate, type Logger } from "../util.js";

/** One user message waiting for its turn. */
export interface InboxItem {
	text: string;
	at: number;
}

/** The cells an agent object owns. Shared across a reload, so the values survive it. */
export interface AgentCells {
	config: Cell<AgentConfig>;
	phase: Cell<AgentStatus>;
	live: Cell<LiveMessage>;
	inbox: Cell<InboxItem[]>;
	turnActive: Cell<boolean>;
}

export interface AgentInstanceDeps {
	store: Store;
	models: ModelRegistry;
	logger: Logger;
	/** Run a short cell update in a fresh root (`api.root`). */
	run<T>(fn: (ctx: Ctx) => T | Promise<T>): Promise<T>;
	/** Start a long-lived root and return immediately (`void api.root(...)`). */
	startRoot(fn: (ctx: Ctx) => Promise<void>): void;
	/** Tools to attach for the next turn, re-read every time (groups change at runtime). */
	toolsFor(agentId: string): AgentTool[];
	/** Merge the definition's variables with the values saved for this agent. */
	variablesFor(agentId: string): Record<string, string>;
	onStatusChange?: (agentId: string, status: AgentStatus) => void;
}

/**
 * One agent: its pi `Agent`, its transcript watermark and its turn loop.
 *
 * The constructor is free of side effects — a reload may construct this object while
 * preparing new code and then abort. The pi `Agent` is built lazily, at the first turn,
 * and rebuilt only between turns.
 */
export class AgentInstance {
	private agent: Agent | undefined;
	private unsubscribe: (() => void) | undefined;
	private persisted = 0;
	private lastSeq = 0;
	private running = false;
	private retired = false;
	private rebuildQueued = false;
	private tools: AgentTool[] = [];
	private live: LiveMessage = { turn: 0, text: "", thinking: "", tools: [] };
	private readonly progress: Progress;

	constructor(
		readonly id: string,
		readonly definition: AgentDefinition,
		readonly cells: AgentCells,
		private readonly deps: AgentInstanceDeps,
	) {
		this.progress = new Progress(
			this.flushLive,
			(error) => this.deps.logger.warn(`live update failed for "${this.id}"`, error),
			50,
		);
	}

	get config(): AgentConfig {
		return this.cells.config.value;
	}

	get status(): AgentStatus {
		return this.cells.phase.value;
	}

	isRunning(): boolean {
		return this.running;
	}

	/** Queue words for the next turn and return immediately. The inbox listener starts the root. */
	async enqueue(text: string): Promise<void> {
		await this.withCtx((ctx) => {
			this.cells.inbox.change(ctx, (draft) => {
				draft.push({ text, at: Date.now() });
			});
		});
		this.pump();
	}

	/** Start a turn if one is not already in flight. Safe to call from any listener or method. */
	pump(): void {
		if (this.retired) return;
		if (this.running) return;
		if (this.cells.turnActive.value) return;
		if (this.cells.inbox.value.length === 0) return;
		this.deps.startRoot((ctx) => this.runTurn(ctx));
	}

	private async runTurn(ctx: Ctx): Promise<void> {
		if (this.running) return;
		const item = this.cells.inbox.value[0];
		if (!item) return;
		this.running = true;
		this.cells.turnActive.change(ctx, () => true);
		this.setPhase(ctx, "streaming");
		try {
			// One message per turn: a second `send` during this turn becomes the next turn,
			// not an extra user message inside this one.
			this.cells.inbox.change(ctx, (draft) => {
				draft.shift();
			});
			this.setTools(this.deps.toolsFor(this.id));
			const agent = this.ensureAgent();
			this.syncTranscript();
			const messages: AgentMessage[] = [{ role: "user", content: item.text, timestamp: item.at }];
			await agent.prompt(messages);
			await this.progress.markAndWait();
		} catch (error) {
			this.deps.logger.error(`agent "${this.id}" failed to run`, error);
			this.setPhase(ctx, "error");
		} finally {
			this.persistNew();
			this.running = false;
			this.cells.turnActive.change(ctx, () => false);
			if (this.cells.phase.value !== "error") {
				this.setPhase(ctx, this.cells.inbox.value.length > 0 ? "queued" : "idle");
			}
			if (this.rebuildQueued && !this.running) {
				this.rebuildQueued = false;
				void this.withCtx((later) => {
					this.build();
					this.setPhase(later, "idle");
				});
			}
			if (this.retired) {
				void this.dispose();
				return;
			}
			this.pump();
		}
	}

	interrupt(): void {
		this.agent?.abort();
	}

	async updateConfig(patch: AgentConfigPatch): Promise<AgentConfig> {
		const next: AgentConfig = { ...this.cells.config.value, ...patch };
		// Wait for the cell before rebuilding: `build()` reads `cells.config.value`.
		await this.withCtx((ctx) => {
			this.cells.config.change(ctx, (draft) => {
				draft.name = next.name;
				draft.description = next.description;
				draft.systemPrompt = next.systemPrompt;
				draft.variables = next.variables.map((variable) => ({ ...variable }));
				draft.model = next.model ? { ...next.model } : null;
			});
		});
		this.deps.store.saveAgent(this.id, this.definition.pluginId, next);
		if (this.running) {
			this.rebuildQueued = true;
		} else {
			try {
				this.build();
			} catch (error) {
				// No model yet is a valid state: the next turn reports it with context.
				this.deps.logger.warn(`agent "${this.id}" is not runnable yet`, error);
			}
		}
		return next;
	}

	/** Tools are owned by the registry; a change reaches a live agent without a rebuild. */
	setTools(tools: AgentTool[]): void {
		this.tools = tools;
		if (this.agent) this.agent.state.tools = tools;
	}

	/**
	 * A reload replaced this instance. Stop taking new turns; a turn already running
	 * keeps its code (grandfathered) and disposes the instance when it settles.
	 */
	async retire(): Promise<void> {
		this.retired = true;
		if (!this.running) await this.dispose();
	}

	async dispose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		const waiters = await this.progress.stop().catch(() => []);
		for (const waiter of waiters) waiter.resolve();
		this.agent?.abort();
		this.agent = undefined;
	}

	// --- building -------------------------------------------------------

	private ensureAgent(): Agent {
		if (this.agent && !this.rebuildQueued) return this.agent;
		this.rebuildQueued = false;
		this.build();
		if (!this.agent) throw new Error(`agent "${this.id}" failed to start`);
		return this.agent;
	}

	private build(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.agent?.abort();
		this.agent = undefined;

		const config = this.cells.config.value;
		if (!config.model) throw new Error(`agent "${this.id}" has no model yet; pick one in Agent 管理`);
		const model = this.deps.models.resolve(config.model);
		if (!model) throw new Error(`unknown model "${config.model.provider}/${config.model.id}"`);
		const rendered = renderTemplate(config.systemPrompt, this.deps.variablesFor(this.id));
		const stored = this.deps.store.allMessages(this.id);
		this.lastSeq = this.deps.store.lastSeq(this.id);
		const restored = stored[0]?.role === "system" ? stored.slice(1) : stored;
		this.persisted = restored.length;
		this.live = { turn: 0, text: "", thinking: "", tools: [] };

		const agent = new Agent({
			initialState: {
				systemPrompt: rendered.text,
				model,
				messages: restored,
				tools: this.tools,
			},
			streamFn: this.deps.models.streamFn,
		});
		this.unsubscribe = agent.subscribe((event) => this.onEvent(event));
		this.agent = agent;
	}

	/** Pick up rows another code version appended (a turn that outlived a reload). */
	private syncTranscript(): void {
		const agent = this.agent;
		if (!agent) return;
		const fresh = this.deps.store.messagesAfter(this.id, this.lastSeq);
		if (fresh.length === 0) return;
		agent.state.messages = [...agent.state.messages, ...fresh];
		this.lastSeq = this.deps.store.lastSeq(this.id);
		this.persisted = this.conversation().length;
	}

	private conversation(): AgentMessage[] {
		const messages = this.agent?.state.messages ?? [];
		return messages[0]?.role === "system" ? messages.slice(1) : messages;
	}

	private persistNew(): void {
		const conversation = this.conversation();
		if (conversation.length <= this.persisted) return;
		try {
			// Advance per row: a write that fails halfway must not re-append what landed.
			for (let index = this.persisted; index < conversation.length; index += 1) {
				const message = conversation[index];
				if (!message) break;
				this.deps.store.appendMessage(this.id, message as Message);
				this.persisted = index + 1;
			}
			this.lastSeq = this.deps.store.lastSeq(this.id);
		} catch (error) {
			// A failing write must not kill the event loop; the watermark stays behind,
			// so a later turn retries the same rows instead of losing them.
			this.deps.logger.warn(`could not persist the transcript of "${this.id}"`, error);
		}
	}

	// --- events ---------------------------------------------------------

	private onEvent(event: AgentEvent): void {
		switch (event.type) {
			case "agent_start": {
				this.setStatus("streaming");
				break;
			}
			case "message_start": {
				if (event.message.role === "assistant") {
					this.live = { turn: this.live.turn + 1, text: "", thinking: "", tools: [] };
					this.progress.mark();
				}
				break;
			}
			case "message_update": {
				const update = event.assistantMessageEvent;
				if (update.type === "text_delta") {
					this.live.text += update.delta;
					this.progress.mark();
				} else if (update.type === "thinking_delta") {
					this.live.thinking += update.delta;
					this.progress.mark();
				} else if (update.type === "toolcall_end") {
					const tool: LiveTool = {
						id: update.toolCall.id,
						name: update.toolCall.name,
						args: JSON.stringify(update.toolCall.arguments ?? {}),
						state: "running",
					};
					this.live.tools.push(tool);
					this.progress.mark();
				}
				break;
			}
			case "tool_execution_end": {
				const tool = this.live.tools.find((candidate) => candidate.id === event.toolCallId);
				if (tool) {
					tool.state = event.isError ? "error" : "done";
					tool.result = summarizeResult(event.result);
					this.progress.mark();
				}
				break;
			}
			case "message_end":
			case "turn_end": {
				this.persistNew();
				break;
			}
			case "agent_end": {
				this.persistNew();
				this.progress.mark();
				break;
			}
			default:
				break;
		}
	}

	/** `Progress` commit: one root per paced flush instead of one root per token. */
	private flushLive = async (): Promise<number> => {
		const snapshot = this.live;
		await this.withCtx((ctx) => {
			this.cells.live.change(ctx, (draft) => {
				draft.turn = snapshot.turn;
				draft.text = snapshot.text;
				draft.thinking = snapshot.thinking;
				draft.tools = snapshot.tools.map((tool) => ({ ...tool }));
			});
		});
		return utf8ByteLength(snapshot.text) + utf8ByteLength(snapshot.thinking);
	};

	private setStatus(status: AgentStatus): void {
		if (this.cells.phase.value === status) return;
		void this.withCtx((ctx) => {
			this.cells.phase.change(ctx, () => status);
		});
		this.deps.onStatusChange?.(this.id, status);
	}

	private setPhase(ctx: Ctx, status: AgentStatus): void {
		if (this.cells.phase.value === status) return;
		this.cells.phase.change(ctx, () => status);
		this.deps.onStatusChange?.(this.id, status);
	}

	private async withCtx<T>(fn: (ctx: Ctx) => T): Promise<T | undefined> {
		try {
			return await this.deps.run(fn);
		} catch (error) {
			this.deps.logger.warn(`cell update failed for agent "${this.id}"`, error);
			return undefined;
		}
	}
}

function summarizeResult(result: unknown): string {
	try {
		const content = (result as { content?: unknown }).content;
		if (Array.isArray(content)) {
			const text = content
				.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : ""))
				.join("\n")
				.trim();
			if (text) return text.length > 400 ? `${text.slice(0, 400)}…` : text;
		}
	} catch {
		// fall through
	}
	return "";
}

export function mergeVariables(definition: AgentDefinition, stored: AgentConfig | undefined): Variable[] {
	const storedByKey = new Map((stored?.variables ?? []).map((variable) => [variable.key, variable]));
	return definition.variables.map((variable) => {
		const previous = storedByKey.get(variable.key);
		// Cells are strict JSON: an own property holding `undefined` is rejected, so omit them.
		const merged: Variable = {
			key: variable.key,
			label: variable.label,
			type: variable.type,
			value: previous?.value ?? variable.value ?? "",
		};
		if (variable.global !== undefined) merged.global = variable.global;
		if (variable.placeholder !== undefined) merged.placeholder = variable.placeholder;
		return merged;
	});
}

export function defaultConfig(id: string, definition: AgentDefinition, stored: AgentConfig | undefined): AgentConfig {
	return {
		name: stored?.name ?? definition.name,
		description: stored?.description ?? definition.description,
		systemPrompt: stored?.systemPrompt ?? definition.systemPrompt,
		variables: mergeVariables(definition, stored),
		model: stored?.model ?? definition.defaultModel ?? null,
	};
}
