import type { Cell, Ctx } from "@earendil-works/chord";
import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type { UserMessage } from "@earendil-works/pi-ai";
import type { AgentConfig, AgentConfigPatch, AgentStatus, LiveMessage, SendMode, Variable } from "@moonan/contracts";
import type { AgentDefinition } from "@moonan/plugin-sdk";
import type { ModelRegistry } from "../models.js";
import type { Store } from "../storage/store.js";
import { renderTemplate, type Logger } from "../util.js";

export interface AgentCells {
	config: Cell<AgentConfig>;
	phase: Cell<AgentStatus>;
	live: Cell<LiveMessage>;
}

export interface AgentInstanceDeps {
	store: Store;
	models: ModelRegistry;
	logger: Logger;
	run<T>(fn: (ctx: Ctx) => T | Promise<T>): Promise<T>;
	variablesFor(agentId: string): Record<string, string>;
	onStatusChange?: (agentId: string, status: AgentStatus) => void;
}

const FLUSH_INTERVAL_MS = 50;

function emptyLive(): LiveMessage {
	return { turn: 0, text: "", thinking: "", tools: [] };
}

export class AgentInstance {
	private agent: Agent | undefined;
	private unsubscribe: (() => void) | undefined;
	private running = false;
	private persisted = 0;
	private live: LiveMessage = emptyLive();
	private flushHandle: ReturnType<typeof setTimeout> | undefined;
	private rebuildQueued = false;
	private readonly tools = new Map<string, AgentTool>();

	constructor(
		readonly id: string,
		readonly definition: AgentDefinition,
		readonly pluginId: string,
		private readonly cells: AgentCells,
		private readonly deps: AgentInstanceDeps,
	) {}

	get status(): AgentStatus {
		return this.cells.phase.value;
	}

	configSnapshot(): AgentConfig {
		return this.cells.config.value;
	}

	start(): void {
		if (this.agent) return;
		this.build();
	}

	private build(): void {
		this.unsubscribe?.();
		const config = this.cells.config.value;
		const model = config.model ? this.deps.models.resolve(config.model) : undefined;
		const rendered = renderTemplate(this.definition.systemPrompt, this.deps.variablesFor(this.id));
		if (rendered.missing.length > 0) {
			this.deps.logger.warn(`agent "${this.id}" has unresolved variables: ${rendered.missing.join(", ")}`);
		}
		const stored = this.deps.store.allMessages(this.id);
		const restored = stored[0]?.role === "system" ? stored.slice(1) : stored;
		this.persisted = restored.length;
		this.live = emptyLive();
		const agent = new Agent({
			initialState: {
				systemPrompt: rendered.text,
				...(model ? { model } : {}),
				messages: restored as AgentMessage[],
				tools: [...this.tools.values()],
			},
			streamFn: this.deps.models.streamFn,
		});
		this.agent = agent;
		this.unsubscribe = agent.subscribe((event) => this.onEvent(event));
	}

	private onEvent(event: AgentEvent): void {
		switch (event.type) {
			case "agent_start": {
				this.running = true;
				this.setStatus("streaming");
				break;
			}
			case "message_start": {
				if (event.message.role === "assistant") {
					this.live = { turn: this.live.turn + 1, text: "", thinking: "", tools: [] };
					this.scheduleFlush();
				}
				break;
			}
			case "message_update": {
				const update = event.assistantMessageEvent;
				if (update.type === "text_delta") {
					this.live.text += update.delta;
					this.scheduleFlush();
				} else if (update.type === "thinking_delta") {
					this.live.thinking += update.delta;
					this.scheduleFlush();
				} else if (update.type === "toolcall_end") {
					this.live.tools.push({
						id: update.toolCall.id,
						name: update.toolCall.name,
						args: JSON.stringify(update.toolCall.arguments ?? {}),
						state: "running",
					});
					this.flushLive();
				}
				break;
			}
			case "tool_execution_end": {
				const tool = this.live.tools.find((candidate) => candidate.id === event.toolCallId);
				if (tool) {
					tool.state = event.isError ? "error" : "done";
					tool.result = summarizeResult(event.result);
					this.flushLive();
				}
				break;
			}
			case "message_end": {
				this.persistNew();
				break;
			}
			case "turn_end": {
				this.persistNew();
				break;
			}
			case "agent_end": {
				this.running = false;
				this.persistNew();
				this.setStatus(this.cells.phase.value === "error" ? "error" : "idle");
				this.flushLive();
				if (this.rebuildQueued) {
					this.rebuildQueued = false;
					this.build();
				}
				break;
			}
			default:
				break;
		}
	}

	private persistNew(): void {
		const agent = this.agent;
		if (!agent) return;
		const messages = agent.state.messages;
		const conversation = messages[0]?.role === "system" ? messages.slice(1) : messages;
		for (let index = this.persisted; index < conversation.length; index += 1) {
			const message = conversation[index];
			if (!message) continue;
			this.deps.store.appendMessage(this.id, message);
		}
		this.persisted = conversation.length;
	}

	private scheduleFlush(): void {
		if (this.flushHandle) return;
		this.flushHandle = setTimeout(() => {
			this.flushHandle = undefined;
			this.flushLive();
		}, FLUSH_INTERVAL_MS);
		if (typeof this.flushHandle === "object" && "unref" in this.flushHandle) this.flushHandle.unref();
	}

	private flushLive(): void {
		const snapshot = this.live;
		void this.mutateLive((draft) => {
			draft.turn = snapshot.turn;
			draft.text = snapshot.text;
			draft.thinking = snapshot.thinking;
			draft.tools = snapshot.tools.map((tool) => ({ ...tool }));
			if (draft.error === undefined && this.status === "error") draft.error = "see logs";
		});
	}

	private setStatus(status: AgentStatus): void {
		if (this.cells.phase.value === status) return;
		void this.withCtx((ctx) => {
			this.cells.phase.change(ctx, () => status);
		});
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

	private mutateLive(fn: (draft: LiveMessage) => void): Promise<void> {
		return this.withCtx((ctx) => {
			this.cells.live.change(ctx, fn);
		}).then(() => undefined);
	}

	// --- commands -------------------------------------------------------

	async send(text: string, mode: SendMode = "steer"): Promise<void> {
		const config: AgentConfig = this.cells.config.value;
		if (!config.model) throw new Error(`agent "${this.id}" has no model yet; pick one in Agent 管理`);
		if (!this.agent) this.build();
		const agent = this.agent;
		if (!agent) throw new Error(`agent "${this.id}" failed to start`);
		const message: UserMessage = { role: "user", content: text, timestamp: Date.now() };
		if (!this.running) {
			this.running = true;
			this.setStatus("queued");
			void agent.prompt(message).catch((error: unknown) => {
				this.running = false;
				this.setStatus("error");
				this.deps.logger.error(`agent "${this.id}" failed to run`, error);
			});
			return;
		}
		if (mode === "followUp") agent.followUp(message);
		else agent.steer(message);
	}

	interrupt(): void {
		this.agent?.abort();
	}

	updateConfig(patch: AgentConfigPatch): AgentConfig {
		const next: AgentConfig = { ...this.cells.config.value, ...patch };
		void this.withCtx((ctx) => {
			this.cells.config.change(ctx, (draft) => {
				draft.name = next.name;
				draft.description = next.description;
				draft.systemPrompt = next.systemPrompt;
				draft.variables = next.variables.map((variable) => ({ ...variable }));
				draft.model = next.model ? { ...next.model } : null;
			});
		});
		this.deps.store.saveAgent(this.id, this.pluginId, next);
		if (this.running) this.rebuildQueued = true;
		else this.build();
		return next;
	}

	addTool(tool: AgentTool): void {
		this.tools.set(tool.name, tool);
		if (this.agent) this.agent.state.tools = [...this.tools.values()];
	}

	removeTool(name: string): void {
		this.tools.delete(name);
		if (this.agent) this.agent.state.tools = [...this.tools.values()];
	}

	hasTool(name: string): boolean {
		return this.tools.has(name);
	}

	toolNames(): string[] {
		return [...this.tools.keys()];
	}

	dispose(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		if (this.flushHandle) clearTimeout(this.flushHandle);
		this.agent?.abort();
		this.agent = undefined;
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
