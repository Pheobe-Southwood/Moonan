import { pathToFileURL } from 'node:url';
import type { Provider, ProviderAuth } from '@earendil-works/pi-ai';
import { createProvider, type Models } from '@earendil-works/pi-ai';
import type { TSchema } from 'typebox';
import type {
  ActionApi,
  ActionResult,
  ActionAvailabilityInput,
  ActionDescriptor,
  AgentDefinition,
  AgentDefinitionInput,
  AgentId,
  AgentRuntimeInfo,
  AgentSendKind,
  ConversationSidebar,
  Logger,
  PluginTool,
  TranscriptEvent,
} from '@moonan/plugin-sdk';
import type { Store } from '../store/index.js';
import { AgentInstance, type AgentCallbacks } from './agent-instance.js';

interface RegisteredAction {
  readonly descriptor: ActionDescriptor<TSchema>;
  readonly owner: string;
}

export interface AgentManagerDeps {
  readonly models: Models;
  readonly store: Store;
  readonly log: Logger;
  /** 可用 action 集合变化时通知宿主重新发布状态。 */
  readonly onActionsChanged: () => void;
  readonly onAgentsChanged: () => void;
  readonly onRuntimeChanged: (info: AgentRuntimeInfo) => void;
  readonly onTranscriptEvent: (event: TranscriptEvent) => void;
  /** 组装 action 前置条件的求值输入（含宿主状态与当前时间）。 */
  readonly availability: () => Omit<ActionAvailabilityInput, 'agentId'>;
}

export interface AvailableAction {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly parameters: unknown;
  readonly owner: string;
  readonly descriptor: ActionDescriptor<TSchema>;
}

/**
 * Agent 与 action 的中枢。
 *
 * 负责：注册/查询 action、维护 AgentInstance 生命周期、把入站消息投给正确的实例。
 * 插件只与本类交互，不直接碰 pi-agent-core。
 */
export class AgentManager {
  readonly #instances = new Map<AgentId, AgentInstance>();
  readonly #definitions = new Map<AgentId, AgentDefinition>();
  readonly #actions = new Map<string, RegisteredAction>();
  readonly #pluginTools = new Map<string, PluginTool>();
  readonly #runtime = new Map<AgentId, AgentRuntimeInfo>();
  readonly #sidebars = new Map<AgentId, ConversationSidebar[]>();
  #defaultAgentId: AgentId | undefined;

  constructor(private readonly deps: AgentManagerDeps) {}

  // -- actions -------------------------------------------------------------

  registerAction(owner: string, descriptor: ActionDescriptor<TSchema>): void {
    if (this.#actions.has(descriptor.id)) {
      throw new Error(`action id 重复：${descriptor.id}`);
    }
    if (!/^[A-Za-z0-9_.:-]+$/.test(descriptor.id)) {
      throw new Error(`action id 只允许 [A-Za-z0-9_.:-]：${descriptor.id}`);
    }
    this.#actions.set(descriptor.id, { descriptor, owner });
    this.deps.onActionsChanged();
  }

  unregisterAction(id: string): void {
    if (this.#actions.delete(id)) this.deps.onActionsChanged();
  }

  registerTool(owner: string, tool: PluginTool): void {
    if (!/^[A-Za-z0-9_-]+$/.test(tool.name)) {
      throw new Error(`tool 名只允许 [A-Za-z0-9_-]：${tool.name}`);
    }
    this.#pluginTools.set(tool.name, tool);
    this.deps.onActionsChanged();
  }

  /** 求值前置条件后返回可用 action 的完整信息。 */
  listAvailableActions(agentId: AgentId): readonly AvailableAction[] {
    const input: ActionAvailabilityInput = { ...this.deps.availability(), agentId };
    const available: AvailableAction[] = [];
    for (const [id, entry] of this.#actions) {
      let ok = false;
      try {
        ok = entry.descriptor.available(input);
      } catch (error) {
        this.deps.log.warn(`action ${id} 的前置条件求值失败`, error);
      }
      if (!ok) continue;
      available.push({
        id,
        title: entry.descriptor.title,
        description: entry.descriptor.description,
        // TypeBox 的 schema 对象不是「纯 JSON」（有原型），而 action 列表要进 replicated state。
        // 统一在边界上净化一次，下游（ActBlock 渲染、UI、wire）拿到的都是普通 JSON。
        parameters: toPlainJson(entry.descriptor.parameters),
        owner: entry.owner,
        descriptor: entry.descriptor,
      });
    }
    available.sort((left, right) => left.id.localeCompare(right.id));
    return available;
  }

  async invokeAction(
    agentId: AgentId,
    actionId: string,
    args: unknown,
    signal: AbortSignal | undefined,
  ): Promise<ActionResult> {
    const entry = this.#actions.get(actionId);
    if (!entry) return { ok: false, text: `未知的 action：${actionId}` };
    const check: ActionAvailabilityInput = { ...this.deps.availability(), agentId };
    if (!entry.descriptor.available(check)) {
      const reason = entry.descriptor.unavailableReason?.(check) ?? '当前不可用';
      return { ok: false, text: `action ${actionId} 不可用：${reason}` };
    }
    const api: ActionApi = {
      agentId,
      log: (message) => this.deps.log.debug(`[action ${actionId}] ${message}`),
      writeSidebar: async (sidebar) => {
        this.pushSidebar(agentId, sidebar);
      },
    };
    try {
      const result = await entry.descriptor.run(args as never, api, { signal });
      for (const sidebar of result.sidebars ?? []) {
        this.pushSidebar(agentId, sidebar);
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.log.error(`action ${actionId} 执行失败`, error);
      return { ok: false, text: `action ${actionId} 执行失败：${message}` };
    }
  }

  /** 对话窗里「角色发出」的消息：写进历史并留一份给 UI。 */
  pushSidebar(agentId: AgentId, sidebar: ConversationSidebar): void {
    const instance = this.#instances.get(agentId);
    if (instance) instance.write(sidebar);
    const list = this.#sidebars.get(agentId) ?? [];
    list.push(sidebar);
    if (list.length > 500) list.splice(0, list.length - 500);
    this.#sidebars.set(agentId, list);
  }

  sidebars(agentId: AgentId): readonly ConversationSidebar[] {
    return this.#sidebars.get(agentId) ?? [];
  }

  // -- agents --------------------------------------------------------------

  normalizeDefinition(input: AgentDefinitionInput): AgentDefinition {
    return {
      ...input,
      scope: input.scope ?? 'persisted',
      variables: input.variables ?? {},
      ui: input.ui ?? { dialog: true },
      tools: input.tools ?? { pluginTools: true, act: true },
    };
  }

  /** 注册或覆盖一个 Agent 定义。 */
  registerAgent(definition: AgentDefinition, persist = true): AgentDefinition {
    this.#definitions.set(definition.id, definition);
    if (persist) this.deps.store.agents.put(definition);
    if (!this.#defaultAgentId) this.#defaultAgentId = definition.id;
    this.deps.onAgentsChanged();
    return definition;
  }

  updateAgent(agentId: AgentId, patch: Partial<AgentDefinition>): AgentDefinition {
    const existing = this.#definitions.get(agentId);
    if (!existing) throw new Error(`Agent 不存在：${agentId}`);
    const next: AgentDefinition = {
      ...existing,
      ...patch,
      id: existing.id,
      variables: { ...existing.variables, ...(patch.variables ?? {}) },
      ui: { ...existing.ui, ...(patch.ui ?? {}) },
      tools: { ...existing.tools, ...(patch.tools ?? {}) },
    };
    this.#definitions.set(agentId, next);
    this.deps.store.agents.put(next);
    this.#instances.get(agentId)?.setDefinition(next);
    this.deps.onAgentsChanged();
    return next;
  }

  removeAgent(agentId: AgentId): void {
    this.#instances.get(agentId)?.abort();
    this.#instances.delete(agentId);
    this.#definitions.delete(agentId);
    this.#runtime.delete(agentId);
    this.#sidebars.delete(agentId);
    this.deps.store.agents.delete(agentId);
    this.deps.store.transcripts.deleteConversation(agentId);
    if (this.#defaultAgentId === agentId) this.#defaultAgentId = undefined;
    this.deps.onAgentsChanged();
  }

  get defaultAgentId(): AgentId | undefined {
    return this.#defaultAgentId;
  }

  definitions(): readonly AgentDefinition[] {
    return [...this.#definitions.values()];
  }

  definition(agentId: AgentId): AgentDefinition {
    const definition = this.#definitions.get(agentId);
    if (!definition) throw new Error(`Agent 不存在：${agentId}`);
    return definition;
  }

  has(agentId: AgentId): boolean {
    return this.#definitions.has(agentId);
  }

  runtimeInfos(): readonly AgentRuntimeInfo[] {
    return [...this.#runtime.values()];
  }

  /** 拿到（必要时创建并恢复）某个 Agent 的运行实体。 */
  instance(agentId: AgentId): AgentInstance {
    const existing = this.#instances.get(agentId);
    if (existing) return existing;
    const definition = this.definition(agentId);
    const callbacks: AgentCallbacks = {
      resolveActions: async (id) =>
        this.listAvailableActions(id).map((action) => ({
          id: action.id,
          title: action.title,
          description: action.description,
          parameters: action.parameters,
          available: true,
          owner: action.owner,
        })),
      resolvePluginTools: async () => (definition.tools.pluginTools ? [...this.#pluginTools.values()] : []),
      invokeAction: async (id, actionId, args, context) =>
        this.invokeAction(id, actionId, args, context.signal),
      emitEvent: (event) => this.deps.onTranscriptEvent(event),
      onPhase: (id, phase, detail) => this.#setRuntime(id, phase, detail),
    };
    const instance = new AgentInstance({
      definition,
      models: this.deps.models,
      store: this.deps.store,
      callbacks,
    });
    instance.hydrate();
    this.#instances.set(agentId, instance);
    this.#setRuntime(agentId, 'idle');
    return instance;
  }

  send(agentId: AgentId, kind: AgentSendKind, text: string): void {
    const instance = this.instance(agentId);
    if (kind === 'steer') instance.steer(text);
    else if (kind === 'followUp') instance.followUp(text);
    else instance.write({ kind: 'system', text });
    this.#setRuntime(agentId, instance.phase);
    if (kind !== 'write') {
      void instance.kick().catch((error: unknown) => {
        this.deps.log.error(`Agent ${agentId} 运行失败`, error);
      });
    }
  }

  abort(agentId: AgentId): void {
    this.#instances.get(agentId)?.abort();
  }

  async waitForIdle(agentId: AgentId): Promise<void> {
    await this.#instances.get(agentId)?.waitForIdle();
  }

  async disposeAll(): Promise<void> {
    for (const instance of this.#instances.values()) instance.abort();
    await Promise.all([...this.#instances.values()].map((instance) => instance.waitForIdle()));
    this.#instances.clear();
  }

  #setRuntime(agentId: AgentId, phase: AgentRuntimeInfo['phase'], detail?: string): void {
    const instance = this.#instances.get(agentId);
    const info: AgentRuntimeInfo = {
      agentId,
      phase,
      queued: instance?.queuedCount ?? 0,
      updatedAt: Date.now(),
      ...(detail && phase === 'tool' ? { toolName: detail } : {}),
      ...(detail && phase === 'error' ? { lastError: detail } : {}),
    };
    this.#runtime.set(agentId, info);
    this.deps.onRuntimeChanged(info);
  }
}

/**
 * 递归把值净化成纯 JSON。
 *
 * TypeBox 的 schema 对象带一个 symbol key（typebox 的类型标记）；chord 的严格 JSON
 * 校验（`copyJson`）会因为 symbol key 直接抛错，而 action 列表要进 replicated state。
 * JSON 往返会丢掉 symbol 与原型，正好得到 chord 要的形状。
 * 因此**所有**要放进 replicated state 的插件数据都从这里过一道。
 */
export function toPlainJson<T = unknown>(value: unknown): T {
  return JSON.parse(JSON.stringify(value ?? null)) as T;
}

/**
 * 解析 pi-ai 的 wire API 实现，供用户自定义 provider 使用。
 *
 * 未知 API 一律回落到 OpenAI 兼容实现（用户自定义 provider 绝大多数是这一类）。
 */
export async function resolveCustomProviderApi(api: string): Promise<unknown> {
  /**
   * pi-ai 的 `exports` 是 `./api/*` 这样的**子路径模式**：
   * 用 `createRequire().resolve()` 会失败（`ERR_PACKAGE_PATH_NOT_EXPORTED`），
   * 但直接 `import()` 这个 specifier 是可以的，导出映射会指向 `dist/api/<name>.js`。
   *
   * 未知 API 一律回落到 OpenAI 兼容实现——用户自定义的 provider 绝大多数是这一类
   * （Ollama / vLLM / LM Studio / 各类中转）。
   */
  /**
   * 要点：**要 import `.lazy` 模块**，它导出的才是工厂（返回 `ProviderStreams`）。
   * 同名的主模块导出的是 `{ stream, streamSimple, convertMessages }`，
   * 直接塞给 `createProvider` 会在运行时抛错（缺少 `compat` 之类的字段）。
   * 工厂名与模块名也不同形（openai-completions → openAICompletionsApi），因此显式列出。
   */
  const FACTORIES: Record<string, { module: string; factory: string }> = {
    'openai-completions': { module: 'openai-completions.lazy', factory: 'openAICompletionsApi' },
    'openai-responses': { module: 'openai-responses.lazy', factory: 'openAIResponsesApi' },
    'anthropic-messages': { module: 'anthropic-messages.lazy', factory: 'anthropicMessagesApi' },
    'google-generative-ai': { module: 'google-generative-ai.lazy', factory: 'googleGenerativeAIApi' },
    'mistral-conversations': {
      module: 'mistral-conversations.lazy',
      factory: 'mistralConversationsApi',
    },
  };
  const entry = FACTORIES[api] ?? FACTORIES['openai-completions'];
  if (!entry) throw new Error(`不支持的 API：${api}`);
  const module_ = (await import(`@earendil-works/pi-ai/api/${entry.module}`)) as Record<string, unknown>;
  const factory = module_[entry.factory];
  if (typeof factory !== 'function') {
    throw new Error(`pi-ai 里找不到 API 工厂 ${entry.factory}（模块 ${entry.module}）`);
  }
  return (factory as () => unknown)();
}

export function buildCustomProvider(
  record: {
    id: string;
    name: string;
    baseUrl?: string;
    api: string;
    models: readonly {
      id: string;
      name: string;
      reasoning?: boolean;
      contextWindow?: number;
      maxTokens?: number;
      input?: readonly ('text' | 'image')[];
    }[];
    headers?: Readonly<Record<string, string>>;
  },
  api: unknown,
  auth: ProviderAuth,
): Provider {
  const models = record.models.map((model) => ({
    id: model.id,
    name: model.name,
    api: record.api,
    provider: record.id,
    baseUrl: record.baseUrl ?? '',
    reasoning: model.reasoning ?? false,
    input: [...(model.input ?? ['text'])],
    contextWindow: model.contextWindow ?? 128_000,
    maxTokens: model.maxTokens ?? 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }));
  return createProvider({
    id: record.id,
    name: record.name,
    ...(record.baseUrl ? { baseUrl: record.baseUrl } : {}),
    ...(record.headers ? { headers: record.headers } : {}),
    auth,
    models: models as never,
    api: api as never,
  });
}
