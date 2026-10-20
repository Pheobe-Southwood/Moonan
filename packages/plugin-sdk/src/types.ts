/**
 * 纯类型定义（**不含任何运行时依赖**）。
 *
 * 单独成文件的原因：浏览器侧的 UI 只需要类型，如果从 `contracts.ts` 导入就会被
 * 拽进 `@earendil-works/chord` 的运行时（defineService 等），白白增大前端产物。
 */
import type { Context, ReplicatedState } from '@earendil-works/chord';
import type { TSchema, Static } from 'typebox';

// ---------------------------------------------------------------------------
// 基础
// ---------------------------------------------------------------------------

export interface MoonanContext {
  readonly signal: AbortSignal | undefined;
  /** 传给服务调用的 chord 上下文（需要透传时使用）。 */
  readonly chord?: Context;
}

/** 全局唯一的 Agent id。内置主 Agent 固定为 `main`。 */
export type AgentId = string;

/** Agent 的持久化范围。 */
export type AgentScope = 'persisted' | 'ephemeral';

/** 思考等级。与 pi-agent-core 的 ThinkingLevel 对齐。 */
export type AgentThinkingLevel =
  | 'off'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

/** 一个可用的模型引用。 */
export interface ModelRef {
  readonly provider: string;
  readonly modelId: string;
}

/**
 * Agent 配置（可编辑、可持久化）。
 *
 * `systemPrompt` 是**模板**，其中的 `{{变量名}}` 在每次请求前用 `variables`
 * 渲染；渲染结果才是发给模型的文本。
 */
export interface AgentDefinition {
  readonly id: AgentId;
  /** Agent 在 UI 中的显示名。 */
  name: string;
  /** 一句话说明。 */
  description: string;
  /** SYSTEM PROMPT 模板。 */
  systemPrompt: string;
  /** 变量表。内置变量 `botname`（角色名）与 `soul`（角色人设）。 */
  variables: Record<string, string>;
  /** 该 Agent 使用的模型；未设置时沿用上一次成功的选择。 */
  model?: ModelRef;
  thinkingLevel?: AgentThinkingLevel;
  /** `persisted` 的 Agent 在重启后自动恢复会话；`ephemeral` 的等到首次被使用时才物化。 */
  scope: AgentScope;
  /** UI 呈现方式。`dialog: false` 表示不在「对话」Tab 中出条目。 */
  ui: AgentUiSpec;
  /** 工具装载策略。 */
  tools: AgentToolSpec;
  /** 注册该 Agent 的插件 id（内置的为 `moonan.agent-manager`）。 */
  owner?: string;
}

export interface AgentUiSpec {
  /** 是否在「对话」Tab 中注册一个入口。 */
  readonly dialog: boolean;
  /** 入口图标（单字符或 emoji）。 */
  readonly icon?: string;
}

export interface AgentToolSpec {
  /** 是否装载插件注册的全部 tool。 */
  readonly pluginTools: boolean;
  /** 是否装载 `act`。 */
  readonly act: boolean;
}

/** Agent 注册时的输入：只需给必填项。 */
export type AgentDefinitionInput = Omit<
  AgentDefinition,
  'scope' | 'ui' | 'tools' | 'variables'
> &
  Partial<Pick<AgentDefinition, 'scope' | 'ui' | 'tools' | 'variables'>>;

export type AgentRuntimePhase = 'idle' | 'streaming' | 'tool' | 'error';

/** Agent 的实时状态（供 UI 显示）。 */
export interface AgentRuntimeInfo {
  readonly agentId: AgentId;
  readonly phase: AgentRuntimePhase;
  readonly toolName?: string;
  readonly queued: number;
  readonly lastError?: string;
  readonly updatedAt: number;
}

/** Agent 的静态信息（供 UI 列表）。 */
export interface AgentInfo {
  readonly id: AgentId;
  readonly name: string;
  readonly description: string;
  readonly owner?: string;
  readonly scope: AgentScope;
  readonly ui: AgentUiSpec;
  readonly model?: ModelRef;
  readonly thinkingLevel?: AgentThinkingLevel;
  readonly subjectCount: number;
}

/** 系统提示词与 Agent 变量渲染后的结果。 */
export interface RenderedPrompt {
  readonly agentId: AgentId;
  readonly text: string;
  readonly missingVariables: readonly string[];
}

// ---------------------------------------------------------------------------
// 消息与上下文
// ---------------------------------------------------------------------------

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/** 持久化的一条上下文消息。`content` 是**原文**，永远不含 ActBlock。 */
export interface TranscriptMessage {
  id: number;
  conversationId: string;
  seq: number;
  role: MessageRole;
  /** pi-ai 的 Message 结构（JSON）。 */
  content: unknown;
  model?: string;
  toolCallId?: string;
  isError?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  createdAt: number;
}

/** 一页上下文消息。`cursor` 用 id，向上翻页时传 `before`。 */
export interface TranscriptPage {
  readonly items: readonly TranscriptMessage[];
  readonly before?: number;
}

/**
 * 从 `after` 起的所有消息。`after = 0` 表示从头。
 * 客户端重连后用它补齐断线期间的内容。
 */
export interface TranscriptDelta {
  readonly items: readonly TranscriptMessage[];
  readonly hasMore: boolean;
}

/** 日志窗看到的实况事件（由 `moonan.transcripts` 广播）。 */
export interface TranscriptEvent {
  kind: 'append' | 'update' | 'phase' | 'error';
  agentId: AgentId;
  /** 流式更新时非空：正在生成中的消息（尚未落库）。 */
  streaming?: StreamingMessage;
  appended?: TranscriptMessage;
  phase?: AgentRuntimePhase;
  error?: string;
}

export type StreamingPartKind = 'text' | 'thinking' | 'toolcall';

/** 正在流式生成中的消息。 */
export interface StreamingMessage {
  role: MessageRole;
  parts: StreamingPart[];
  startedAt: number;
}

export interface StreamingPart {
  kind: StreamingPartKind;
  text: string;
  toolName?: string;
  done?: boolean;
}

/** 订阅请求。`after` 用于重连补洞。 */
export interface TranscriptSubscribeInput {
  readonly agentId: AgentId;
  readonly after?: number;
}

/**
 * `moonan.transcripts` 的远端契约。方法返回 strict JSON，`events` 是可订阅状态。
 *
 * `events` 保留最近 {@link TRANSCRIPT_EVENT_BUFFER} 条实况事件；客户端刷新后
 * 用 `delta()` 补齐持久化消息，用事件缓冲补齐流式输出。
 */
export interface TranscriptsService {
  readonly events: ReplicatedState<{ recent: TranscriptEvent[] }>;
  page(
    input: { readonly agentId: AgentId; readonly before?: number; readonly limit: number },
    context: Context,
  ): Promise<TranscriptPage>;
  delta(
    input: TranscriptSubscribeInput,
    context: Context,
  ): Promise<TranscriptDelta>;
  active(context: Context): Promise<readonly AgentId[]>;
}

// ---------------------------------------------------------------------------
// Actions 与 ActBlock
// ---------------------------------------------------------------------------

/** 求值前置条件时可见的宿主状态。 */
export interface ActionAvailabilityInput {
  readonly agentId: AgentId;
  /** 当前在「对话」Tab 中被打开的 Agent id。 */
  readonly openDialog: AgentId | null;
  readonly openTabs: readonly string[];
  readonly now: number;
}

export interface ActionResult {
  readonly ok: boolean;
  /** 回给模型的结果文本。 */
  readonly text: string;
  /** 是否终止本轮的后续 tool 调用。 */
  readonly terminate?: boolean;
  readonly sidebars?: readonly ConversationSidebar[];
}

/** 由 action 产生的、需要在「对话」Tab 中展示的非模型消息。 */
export interface ConversationSidebar {
  readonly kind: 'character' | 'system';
  readonly text: string;
}

/** 插件对外提供的一个 action。 */
export interface ActionDescriptor<T extends TSchema = TSchema> {
  readonly id: string;
  /** ActBlock 中显示的名字。 */
  readonly title: string;
  /** 给模型看的纯文本说明。 */
  readonly description: string;
  /** 参数 schema（TypeBox 对象）。 */
  readonly parameters: T;
  /** 缺少必填参数时给出提示，而不是让模型瞎猜。 */
  readonly available: (input: ActionAvailabilityInput) => boolean;
  /** 不可用时的原因，写进 ActBlock 供模型参考。 */
  readonly unavailableReason?: (input: ActionAvailabilityInput) => string;
  run(
    args: Static<T>,
    api: ActionApi,
    context: MoonanContext,
  ): Promise<ActionResult>;
}

/** action 执行时拿到的宿主能力。 */
export interface ActionApi {
  readonly agentId: AgentId;
  /** 只写历史、不触发生成（对话窗左侧的角色消息）。 */
  writeSidebar(sidebar: ConversationSidebar, context?: MoonanContext): Promise<void>;
  log(message: string): void;
}

export interface ActionInfo {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** 参数 JSON Schema（由 TypeBox 渲染）。 */
  readonly parameters: unknown;
  readonly available: boolean;
  readonly unavailableReason?: string;
  readonly owner?: string;
}

export interface ActionsService {
  readonly state: ReplicatedState<{ actions: ActionInfo[]; byAgent: Record<string, ActionInfo[]> }>;
  list(context: Context): Promise<readonly ActionInfo[]>;
  invoke(
    input: { readonly agentId: AgentId; readonly actionId: string; readonly args: unknown },
    context: Context,
  ): Promise<ActionResult>;
}

/** 可装载 tool。与 pi-ai 的 `Tool` 结构一致，额外允许声明参数 schema。 */
export interface PluginTool {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: TSchema;
  execute(
    args: Record<string, unknown>,
    api: ActionApi,
    context: MoonanContext,
  ): Promise<ActionResult>;
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export type AgentSendKind = 'steer' | 'followUp' | 'write';

export interface AgentsService {
  readonly state: ReplicatedState<{
    agents: AgentInfo[];
    runtime: Record<string, AgentRuntimeInfo>;
  }>;
  list(context: Context): Promise<readonly AgentInfo[]>;
  get(input: { readonly agentId: AgentId }, context: Context): Promise<AgentDefinition>;
  update(
    input: { readonly agentId: AgentId; readonly patch: Partial<AgentDefinition> },
    context: Context,
  ): Promise<AgentDefinition>;
  spawn(input: { readonly definition: AgentDefinitionInput }, context: Context): Promise<AgentId>;
  kill(input: { readonly agentId: AgentId }, context: Context): Promise<void>;
  send(
    input: { readonly agentId: AgentId; readonly kind: AgentSendKind; readonly text: string },
    context: Context,
  ): Promise<void>;
  renderPrompt(input: { readonly agentId: AgentId }, context: Context): Promise<RenderedPrompt>;
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export interface ProviderModelInfo {
  readonly id: string;
  readonly name: string;
  readonly reasoning: boolean;
  readonly contextWindow: number;
}

export interface ProviderInfo {
  readonly id: string;
  readonly name: string;
  /** `builtin` 的 provider 来自 pi-ai；`custom` 来自用户配置。 */
  readonly kind: 'builtin' | 'custom';
  readonly configured: boolean;
  /** 凭据来源的人类可读标签：`已保存的 Key` / `env:OPENAI_API_KEY` / `未配置`。 */
  readonly source?: string;
  /** 是否提供 OAuth 登录（rc1 仅展示占位）。 */
  readonly supportsOAuth: boolean;
  readonly oauthImplemented: false;
  readonly modelCount: number;
  readonly apiKind?: string;
  readonly baseUrl?: string;
}

export interface ProvidersService {
  readonly state: ReplicatedState<{ providers: ProviderInfo[] }>;
  list(context: Context): Promise<readonly ProviderInfo[]>;
  models(
    input: { readonly providerId: string },
    context: Context,
  ): Promise<readonly ProviderModelInfo[]>;
  setKey(
    input: { readonly providerId: string; readonly key: string },
    context: Context,
  ): Promise<ProviderInfo>;
  clearKey(
    input: { readonly providerId: string },
    context: Context,
  ): Promise<ProviderInfo>;
  setCustom(input: { readonly record: CustomProviderRecord }, context: Context): Promise<ProviderInfo>;
  removeCustom(input: { readonly providerId: string }, context: Context): Promise<void>;
}

/** 用户自定义 provider 的持久化记录。 */
export interface CustomProviderRecord {
  readonly id: string;
  readonly name: string;
  readonly baseUrl?: string;
  /** pi-ai 的 wire API，例如 `openai-completions`。 */
  readonly api: string;
  readonly models: readonly CustomProviderModel[];
  /** 额外的静态请求头。 */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface CustomProviderModel {
  readonly id: string;
  readonly name: string;
  readonly reasoning?: boolean;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly input?: readonly ('text' | 'image')[];
}

// ---------------------------------------------------------------------------
// UI 贡献与事件
// ---------------------------------------------------------------------------

export type TabId = 'providers' | 'agents' | 'conversation' | 'logs';

/** 默认激活的 Tab（宿主 shell 的第一屏）。 */
export const DEFAULT_TAB: TabId = 'conversation';

export interface BadgeContribution {
  readonly tab: TabId;
  readonly text: string;
  readonly tone?: 'neutral' | 'accent' | 'warning';
}

export interface TabContribution {
  readonly tab: TabId;
  readonly componentId: string;
}

export interface UiContributionsService {
  readonly state: ReplicatedState<{
    tabs: TabContribution[];
    badges: BadgeContribution[];
  }>;
  contribute(
    input: { readonly tab?: TabContribution; readonly badge?: BadgeContribution },
    context: Context,
  ): Promise<void>;
}

export type SystemEventKind =
  | 'dialog.opened'
  | 'dialog.closed'
  | 'user.batch'
  | 'agent.spawned'
  | 'agent.killed'
  | 'plugin.loaded';

export interface SystemEvent {
  readonly kind: SystemEventKind;
  readonly agentId?: AgentId;
  readonly at: number;
  readonly detail?: string;
}

export interface EventsService {
  readonly state: ReplicatedState<{ recent: SystemEvent[] }>;
  emit(input: SystemEvent, context: Context): Promise<void>;
}

// ---------------------------------------------------------------------------
// 宿主状态
// ---------------------------------------------------------------------------

/** 所有插件共享的根状态（对应 Chord 的 replicated state）。 */
export interface HostState {
  /** 当前在「对话」Tab 打开的 Agent。 */
  openDialog: AgentId | null;
  /** 当前 WebUI 活跃的顶层 Tab。 */
  activeTab: TabId;
  /** 当前用户昵称（写入对话窗消息）。 */
  nickname: string;
  /** 记录用户最后一次打开对话窗的时间，用于排队通知去重。 */
  dialogOpenedAt: number;
}

export interface HostStateService {
  readonly state: ReplicatedState<HostState>;
  get(context: Context): Promise<HostState>;
  set(input: { readonly patch: Partial<HostState> }, context: Context): Promise<HostState>;
}

// ---------------------------------------------------------------------------
// 日志（宿主本地，不跨 wire）
// ---------------------------------------------------------------------------

/**
 * 已装载插件的登记簿。
 *
 * 每个插件在自己的 facet `setup` 里把自己登记进来；宿主据此知道有哪些插件在场。
 * 这是「插件系统真的存在」的可观测证据（`/api/meta` 会列出来）。
 */
export interface PluginRegistry {
  register(input: { readonly id: string; readonly facet: string }, context: Context): Promise<void>;
  list(context: Context): Promise<readonly { id: string; facet: string }[]>;
}

export interface Logger {
  debug(message: string, detail?: unknown): void;
  info(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
}
