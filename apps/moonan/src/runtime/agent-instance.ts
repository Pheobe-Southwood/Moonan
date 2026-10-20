import {
  runAgentLoop,
  type AgentEvent,
  type AgentLoopConfig,
  type AgentTool,
  type AgentMessage,
} from '@earendil-works/pi-agent-core';
import type { Model, Models, Tool } from '@earendil-works/pi-ai';
import { toToolDeclaration } from '@earendil-works/pi-ai';
import type {
  ActionApi,
  ActionInfo,
  AgentDefinition,
  AgentId,
  AgentRuntimePhase,
  ConversationSidebar,
  MoonanContext,
  PluginTool,
  TranscriptEvent,
  TranscriptMessage,
  StreamingMessage,
  StreamingPart,
} from '@moonan/plugin-sdk';
import type { Store } from '../store/index.js';
import { createLogger } from './logger.js';
import { applyActBlock, renderPrompt, renderActBlock, stripActBlock } from './actblock.js';
import { ACT_TOOL_NAME, buildActTool, buildPluginTool } from './tools.js';

const log = createLogger({ namespace: 'runtime' });

/** 单次运行的护栏：避免 followUp 队列失控导致无限循环。 */
const MAX_RUN_ITERATIONS = 32;

export interface AgentCallbacks {
  /** 取当前可用的 actions（前置条件已求值）。 */
  resolveActions(agentId: AgentId): Promise<readonly ActionInfo[]>;
  /** 取该 Agent 可装载的插件 tools。 */
  resolvePluginTools(agentId: AgentId): Promise<readonly PluginTool[]>;
  /** 执行一个 action。 */
  invokeAction(
    agentId: AgentId,
    actionId: string,
    args: unknown,
    context: MoonanContext,
  ): Promise<{ ok: boolean; text: string; terminate?: boolean; sidebars?: readonly ConversationSidebar[] }>;
  /** 把实况事件推给日志窗。 */
  emitEvent(event: TranscriptEvent): void;
  /** 状态变化（供 AgentRuntimeInfo 用）。 */
  onPhase(agentId: AgentId, phase: AgentRuntimePhase, detail?: string): void;
}

export interface AgentInstanceOptions {
  readonly definition: AgentDefinition;
  readonly models: Models;
  readonly store: Store;
  readonly callbacks: AgentCallbacks;
  /** 额外透传给 `Models.streamSimple` 的请求选项。 */
  readonly streamOptions?: Record<string, unknown>;
  /** 每次渲染出模型视图时回调，用于观察/审计真正发给 provider 的上下文。 */
  readonly onModelView?: (agentId: AgentId, messages: readonly AgentMessage[]) => void;
  /** 工具执行器的 lambda 参数名（不进模型视野，仅用于日志）。 */
  readonly instanceLabel?: string;
}

export interface RunSummary {
  readonly failed: boolean;
  readonly error?: string;
}

/**
 * 一个 Agent 的运行实体。
 *
 * 关键设计（见 docs/adr/0004 / 0008）：
 * - 直接用 `runAgentLoop` 驱动，而不是 `Agent` 类：需要 `transformContext` 来做
 *   ActBlock 的「先摘后挂」，且不想被 `prompt()/continue()` 的尾部断言限制。
 * - 入站消息分三个队列（steer / followUp / write），全部落 SQLite：
 *   steer 在「当前 assistant 回合的 tool 调用跑完之后」注入，不打断进行中的输出；
 *   followUp 让本来要停下的 Agent 再跑一轮；write 只入历史，不触发生成。
 * - 上下文数组由本类持有，每轮循环把新增消息补写进 transcript 表。
 */
export class AgentInstance {
  readonly id: AgentId;
  #definition: AgentDefinition;
  #messages: AgentMessage[] = [];
  /**
   * 已落库的消息标记。
   *
   * 不能用「条数」来记账：引擎在流式结束时会把 `message_start` 推入的 partial 消息
   * **替换**成一个等长的最终消息对象（`context.messages[len-1] = finalMessage`），
   * 按长度推进会导致真实消息被静默丢弃。按身份记账才稳。
   */
  #persistedIds = new Set<number>();
  #nextMessageId = 1;
  #running: Promise<void> | undefined;
  #abortController: AbortController | undefined;
  #phase: AgentRuntimePhase = 'idle';
  #lastError: string | undefined;
  #streaming: StreamingMessage | undefined;
  #currentTools: AgentTool[] = [];
  #started = false;
  /** 本次运行内是否已有回合结束；steer 只在这之后才注入。 */
  #firstTurnClosed = false;
  /**
   * 引擎当前使用的上下文。
   *
   * 必须从 `prepareRequest` 里取：一旦 `prepareRequest` 返回了替换后的 context，
   * 引擎就会把 `currentContext` 重绑到新对象，`emit` 携带的仍是最初那个对象。
   */
  #live: { messages: AgentMessage[]; tools?: AgentTool[] } | undefined;

  constructor(private readonly options: AgentInstanceOptions) {
    this.id = options.definition.id;
    this.#definition = options.definition;
  }

  get definition(): AgentDefinition {
    return this.#definition;
  }

  get phase(): AgentRuntimePhase {
    return this.#phase;
  }

  get lastError(): string | undefined {
    return this.#lastError;
  }

  get messageCount(): number {
    return this.#messages.length;
  }

  get running(): boolean {
    return this.#running !== undefined;
  }

  get queuedCount(): number {
    return this.options.store.transcripts.queueCount(this.conversationId);
  }

  get conversationId(): string {
    return this.id;
  }

  get streaming(): StreamingMessage | undefined {
    return this.#streaming;
  }

  /**
   * 从存储恢复上下文。幂等。
   *
   * 首条 system 消息是**每次请求即时渲染**的（含变量替换与 tool 声明），所以历史表里
   * 不存它；`#persisted` 表示 `#messages` 中已经落库的部分的数量。
   */
  hydrate(): void {
    if (this.#started) return;
    this.#started = true;
    this.options.store.transcripts.ensureConversation(this.id);
    const stored = this.options.store.transcripts.all(this.conversationId);
    this.#messages = stored
      .filter((item) => item.role !== 'system')
      .map((item) => markMessage(item.content as AgentMessage, this.#nextMessageId++));
    this.#persistedIds.clear();
    for (const message of this.#messages) this.#persistedIds.add(messageId(message) ?? 0);
    this.#ensureSystemMessage();
  }

  /** 重新渲染并替换首条 system 消息（变量或提示词变化时调用）。 */
  refreshSystemPrompt(): void {
    this.hydrate();
    this.#ensureSystemMessage(true);
  }

  setDefinition(definition: AgentDefinition): void {
    this.#definition = definition;
    this.refreshSystemPrompt();
  }

  // -- 入站消息 ------------------------------------------------------------

  /** 排队等级：不打断当前 tool 调用与流式输出。 */
  steer(text: string): void {
    this.hydrate();
    this.options.store.transcripts.enqueue(this.conversationId, 'steer', userMessage(text));
  }

  /** Agent 本来要停下时再继续。 */
  followUp(text: string): void {
    this.hydrate();
    this.options.store.transcripts.enqueue(this.conversationId, 'follow_up', userMessage(text));
  }

  /** 只写历史、不触发生成：对话窗左侧的角色消息。 */
  write(sidebar: ConversationSidebar): void {
    this.hydrate();
    this.#messages.push(userMessage(`[${sidebar.kind}] ${sidebar.text}`));
    this.#persistFrom();
  }

  // -- 驱动 ----------------------------------------------------------------

  /** 让队列里的消息真正被处理。已有的运行不会被打断。 */
  async kick(): Promise<void> {
    this.hydrate();
    if (this.#running) return this.#running;
    if (this.queuedCount === 0) return;
    const run = this.#drive().finally(() => {
      this.#running = undefined;
      this.#setPhase('idle');
    });
    this.#running = run;
    return run;
  }

  /** 等当前运行结束。 */
  async waitForIdle(): Promise<void> {
    while (this.#running) {
      await this.#running;
    }
  }

  abort(): void {
    this.#abortController?.abort();
  }

  // -- 内部 ----------------------------------------------------------------

  async #drive(): Promise<void> {
    let iterations = 0;
    while (iterations < MAX_RUN_ITERATIONS) {
      iterations += 1;
      const steer = this.options.store.transcripts.peek(this.conversationId, 'steer', 1);
      const followUp = this.options.store.transcripts.peek(this.conversationId, 'follow_up', 1);
      if (steer.length === 0 && followUp.length === 0) return;
      const summary = await this.#runOnce();
      if (summary?.failed) return;
    }
    log.warn(`agent ${this.id} 连续运行 ${MAX_RUN_ITERATIONS} 次仍未排空队列，已暂停`, {
      queued: this.queuedCount,
    });
  }

  async #runOnce(): Promise<RunSummary | undefined> {
    const model = this.#resolveModel();
    if (!model) {
      const message = `Agent ${this.id} 没有可用的模型；请先在「提供商」里配置 API Key 并选择模型。`;
      this.#lastError = message;
      this.#setPhase('error', message);
      this.options.callbacks.emitEvent({ kind: 'error', agentId: this.id, error: message });
      this.options.store.transcripts.clearQueue(this.conversationId);
      return { failed: true, error: message };
    }

    this.#currentTools = await this.#buildTools();
    this.#firstTurnClosed = false;
    this.#ensureSystemMessage(true);
    this.#abortController = new AbortController();
    const signal = this.#abortController.signal;
    const context = { messages: [...this.#messages], tools: this.#currentTools };
    if (process.env['MOONAN_DEBUG_PERSIST']) {
      console.error('DBG initial context', context.messages.length, JSON.stringify(context.messages.map((m) => m.role)));
    }
    const dropped: AgentMessage[] = [];
    this.#live = context;
    const config = this.#buildConfig(model, dropped);

    this.#lastError = undefined;
    this.#setPhase('streaming');

    try {
      await runAgentLoop([], context, config, async (event) => this.#onEvent(event), signal, (m, ctx, options) =>
        this.options.models.streamSimple(m as Model<never>, ctx, {
          ...this.options.streamOptions,
          ...options,
          signal,
        }),
      );
      this.#syncFromLive();
      this.#persistFrom();
      return { failed: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#lastError = message;
      this.#setPhase('error', message);
      this.options.callbacks.emitEvent({ kind: 'error', agentId: this.id, error: message });
      this.#syncFromLive();
      this.#persistFrom();
      return { failed: true, error: message };
    } finally {
      this.#abortController = undefined;
      this.#streaming = undefined;
      this.#live = undefined;
    }
  }

  #buildConfig(model: Model<never>, dropped: AgentMessage[]): AgentLoopConfig {
    return {
      model: model as Model<never>,
      toolExecution: 'parallel',
      prepareRequest: async (request) => {
        // 引擎在这里交出它真正在用的 context；记下来供事件处理与落库使用。
        this.#live = request.context as { messages: AgentMessage[]; tools?: AgentTool[] };
        return undefined;
      },
      convertToLlm: (messages) => messages.filter((message) =>
        message.role === 'system' ||
        message.role === 'user' ||
        message.role === 'assistant' ||
        message.role === 'toolResult',
      ) as never,
      /**
       * 只在请求**之后**生效的上下文替换；这里用于 ActBlock 的「先摘后挂」与
       * system 提示词刷新。注意 `dropped` 里记录的替换形态不会写回 `#messages`，
       * 因此历史里永远不会留下 ActBlock。
       */
      transformContext: async (messages) => this.#renderModelView(messages, dropped),
      /**
       * 排队等级：steer 只在**回合结束后**注入。
       *
       * 引擎会在第一次请求**之前**也 poll 一次；那个时机注入会打断进行中的输出，
       * 与「不打断主 Agent 当前的工具调用、输出」相悖，所以首个回合完成前一律返回空。
       */
      getSteeringMessages: async () => {
        if (!this.#firstTurnClosed) return [];
        return this.options.store.transcripts
          .drain(this.conversationId, 'steer', 1)
          .map((item) => item.content as AgentMessage);
      },
      getFollowUpMessages: async () =>
        this.options.store.transcripts
          .drain(this.conversationId, 'follow_up', 1)
          .map((item) => item.content as AgentMessage),
      /**
       * 有排队消息就让引擎再跑一轮，否则正常停机。
       *
       * 这一条是必要的：引擎的内层循环只在「本轮有 tool 调用」或「poll 到了 steer」时
       * 继续，而在最后一次 tool 调用**之后**才入队的 steer 既不会被内层循环看到，也不会
       * 被 `getFollowUpMessages` 取到。`{action:'continue'}` 让引擎再走一轮。
       */
      finishTurn: async () => {
        const transcripts = this.options.store.transcripts;
        if (transcripts.peek(this.conversationId, 'steer', 1).length > 0) {
          return { action: 'continue' };
        }
        if (transcripts.peek(this.conversationId, 'follow_up', 1).length > 0) {
          return { action: 'continue' };
        }
        return undefined;
      },
    };
  }

  /** 模型视图：摘掉旧 ActBlock，把新的挂到本轮最后一条 tool result（否则最后一条 user）。 */
  async #renderModelView(messages: AgentMessage[], dropped: AgentMessage[]): Promise<AgentMessage[]> {
    const view = messages.map((message) => ({ ...message }));
    for (const message of view) {
      if (message.role === 'toolResult') {
        message.content = stripActBlock(message.content) as typeof message.content;
      } else if (message.role === 'user') {
        message.content = stripActBlock(message.content) as typeof message.content;
      }
    }
    const actions = await this.options.callbacks.resolveActions(this.id);
    const block = renderActBlock(actions);
    const targetIndex = findActBlockTarget(view);
    const target = targetIndex >= 0 ? view[targetIndex] : undefined;
    if (target && block) {
      if (target.role === 'system') {
        target.content = `${typeof target.content === 'string' ? target.content : ''}\n\n${block}`;
      } else {
        target.content = applyActBlock(target.content, block) as typeof target.content;
      }
    }
    dropped.push(...view);
    this.options.onModelView?.(this.id, view);
    return view;
  }

  async #buildTools(): Promise<AgentTool[]> {
    const tools: AgentTool[] = [];
    const definition = this.#definition;
    const api: ActionApi = {
      agentId: this.id,
      log: (message) => log.debug(`[${this.id}] ${message}`),
      writeSidebar: async (sidebar: ConversationSidebar) => {
        this.write(sidebar);
      },
    };
    if (definition.tools.act) {
      const actions = await this.options.callbacks.resolveActions(this.id);
      tools.push(
        buildActTool(
          this.id,
          actions,
          async (actionId, args, _api, context) => this.#invokeAction(actionId, args, context),
          api,
        ),
      );
    }
    if (definition.tools.pluginTools) {
      for (const pluginTool of await this.options.callbacks.resolvePluginTools(this.id)) {
        if (pluginTool.name === ACT_TOOL_NAME) continue;
        tools.push(buildPluginTool(pluginTool, api));
      }
    }
    return tools;
  }

  async #invokeAction(
    actionId: string,
    args: Record<string, unknown>,
    context: MoonanContext,
  ): Promise<Awaited<ReturnType<PluginTool['execute']>>> {
    const actions = await this.options.callbacks.resolveActions(this.id);
    if (!actions.some((candidate) => candidate.id === actionId)) {
      return { ok: false, text: `action 当前不可用：${actionId}` };
    }
    return this.options.callbacks.invokeAction(this.id, actionId, args, context);
  }

  /** 把引擎当前上下文里的消息同步进 `#messages`。 */
  #syncFromLive(): void {
    if (this.#live) this.#messages = this.#live.messages;
  }

  #onEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'agent_start':
        this.#setPhase('streaming');
        break;
      case 'turn_start':
        break;
      case 'message_start':
        if (event.message.role === 'assistant') {
          this.#streaming = { role: 'assistant', parts: [], startedAt: Date.now() };
        }
        break;
      case 'message_update':
        this.#onMessageUpdate(event.assistantMessageEvent);
        break;
      case 'message_end':
        this.#syncFromLive();
        this.#persistFrom();
        this.#streaming = undefined;
        this.#emitStreaming();
        break;
      case 'tool_execution_start':
        this.#setPhase('tool', event.toolName);
        break;
      case 'tool_execution_end':
        this.#setPhase('streaming');
        break;
      case 'turn_end':
        // 引擎紧接着 turn_end 就会 poll steering；先置位才能让「回合结束后入队」的 steer
        // 在下一次 poll 被取到。
        this.#firstTurnClosed = true;
        this.#syncFromLive();
        this.#persistFrom();
        break;
      case 'agent_end':
        this.#syncFromLive();
        this.#persistFrom();
        this.#streaming = undefined;
        this.#emitStreaming();
        break;
      default:
        break;
    }
  }

  #onMessageUpdate(event: { type: string; delta?: string }): void {
    if (!this.#streaming) return;
    const parts = [...this.#streaming.parts];
    const last = parts.at(-1);
    const appendTo = (kind: StreamingPart['kind']): void => {
      if (last && last.kind === kind) {
        parts[parts.length - 1] = { ...last, text: last.text + (event.delta ?? '') };
      } else {
        parts.push({ kind, text: event.delta ?? '' });
      }
    };
    if (event.type === 'text_delta') appendTo('text');
    else if (event.type === 'thinking_delta') appendTo('thinking');
    else if (event.type === 'toolcall_delta') appendTo('toolcall');
    else return;
    this.#streaming = { ...this.#streaming, parts };
    this.#emitStreaming();
  }

  #emitStreaming(): void {
    this.options.callbacks.emitEvent({
      kind: 'update',
      agentId: this.id,
      ...(this.#streaming ? { streaming: this.#streaming } : {}),
      phase: this.#phase,
    });
  }

  #setPhase(phase: AgentRuntimePhase, detail?: string): void {
    this.#phase = phase;
    this.options.callbacks.onPhase(this.id, phase, detail);
    if (phase !== 'streaming') this.#emitStreaming();
  }

  /** 把 `#messages` 中尚未落库的部分补写进 transcript。 */
  #persistFrom(): void {
    for (const message of this.#messages) {
      if (message.role === 'system') continue;
      const id = ensureMessageId(message, () => this.#nextMessageId++);
      if (this.#persistedIds.has(id)) continue;
      const appended = this.#appendMessage(message);
      this.#persistedIds.add(id);
      if (appended) {
        this.options.callbacks.emitEvent({ kind: 'append', agentId: this.id, appended });
      }
    }
  }

  #appendMessage(message: AgentMessage): TranscriptMessage | undefined {
    const transcripts = this.options.store.transcripts;
    if (message.role === 'assistant') {
      const content = message as { content: unknown; usage?: { input?: number; output?: number }; api?: string };
      return transcripts.append({
        conversationId: this.conversationId,
        role: 'assistant',
        content: message as unknown,
        ...(content.api ? { model: content.api } : {}),
        ...(content.usage?.input === undefined ? {} : { inputTokens: content.usage.input }),
        ...(content.usage?.output === undefined ? {} : { outputTokens: content.usage.output }),
      });
    }
    if (message.role === 'toolResult') {
      const result = message as { content: unknown; toolCallId?: string; isError?: boolean };
      return transcripts.append({
        conversationId: this.conversationId,
        role: 'tool',
        content: message as unknown,
        ...(result.toolCallId ? { toolCallId: result.toolCallId } : {}),
        ...(result.isError === undefined ? {} : { isError: result.isError }),
      });
    }
    if (message.role === 'system') {
      return transcripts.append({
        conversationId: this.conversationId,
        role: 'system',
        content: message as unknown,
      });
    }
    return transcripts.append({
      conversationId: this.conversationId,
      role: 'user',
      content: message as unknown,
    });
  }

  /**
   * 维护首条 system 消息：渲染后的提示词 + 当前 tool 声明。
   *
   * 这条消息**不落库**（每次请求即时渲染），因此变量一改，下一轮请求就生效。
   */
  #ensureSystemMessage(force = false): void {
    const rendered = renderPrompt(this.id, this.#definition.systemPrompt, this.#definition.variables);
    const tools = this.#currentTools.map((tool) => toToolDeclaration(tool));
    const first = this.#messages[0];
    if (first && first.role === 'system' && !force) {
      if (rendered.text === first.content && tools.length === 0) return;
    }
    const message = {
      role: 'system',
      content: rendered.text,
      ...(tools.length > 0 ? { toolsAdded: tools } : {}),
      timestamp: Date.now(),
    } as AgentMessage;
    if (first && first.role === 'system') {
      this.#messages[0] = message;
    } else {
      this.#messages.unshift(message);
    }
  }

  #resolveModel(): Model<never> | undefined {
    const ref = this.#definition.model;
    if (!ref) return undefined;
    return this.options.models.getModel(ref.provider, ref.modelId) as Model<never> | undefined;
  }
}

/**
 * ActBlock 挂载点：本轮最后一条 tool result → 否则最后一条 user 消息 → 否则最后一条
 * 能承载文本的消息。保证「每次请求恰好一份」在任意请求形态下都成立。
 */
function findActBlockTarget(view: AgentMessage[]): number {
  for (let index = view.length - 1; index >= 0; index -= 1) {
    if (view[index]?.role === 'toolResult') return index;
  }
  for (let index = view.length - 1; index >= 0; index -= 1) {
    if (view[index]?.role === 'user') return index;
  }
  return view.length - 1;
}

export const MESSAGE_ID = Symbol('moonan.messageId');

function messageId(message: AgentMessage): number | undefined {
  return (message as unknown as Record<symbol, number | undefined>)[MESSAGE_ID];
}

/** 给消息打上非枚举 id（不进入 JSON，不影响 provider 请求体）。 */
function markMessage<T extends AgentMessage>(message: T, id: number): T {
  if (messageId(message) !== undefined) return message;
  Object.defineProperty(message, MESSAGE_ID, { value: id, enumerable: false, configurable: true });
  return message;
}

function ensureMessageId(message: AgentMessage, next: () => number): number {
  const existing = messageId(message);
  if (existing !== undefined) return existing;
  const id = next();
  markMessage(message, id);
  return id;
}

export function userMessage(text: string): AgentMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    timestamp: Date.now(),
  } as AgentMessage;
}
