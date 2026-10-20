/** WebUI 侧插件入口的契约。 */
import type { ReplicatedState } from '@earendil-works/chord';
import type {
  ActionInfo,
  TranscriptPage,
  AgentDefinition,
  AgentDefinitionInput,
  AgentId,
  AgentInfo,
  AgentRuntimeInfo,
  CustomProviderRecord,
  HostState,
  ProviderInfo,
  ProviderModelInfo,
  RenderedPrompt,
  SystemEvent,
  TranscriptEvent,
  TranscriptMessage,
} from './types.js';

/**
 * 服务句柄：WebUI 通过 WebSocket 上的 chord 远端服务绑定拿到这些对象。
 *
 * 签名与 node 侧的服务契约一致，但**不带**末尾的 `Context` 参数——远端绑定自己补。
 */
export interface ClientServices {
  readonly state: ClientHostStateService;
  readonly actions: ClientActionsService;
  readonly agents: ClientAgentsService;
  readonly transcripts: ClientTranscriptsService;
  readonly providers: ClientProvidersService;
  readonly ui: ClientUiContributionsService;
  readonly events: ClientEventsService;
}

export interface ClientHostStateService {
  readonly state: ReplicatedState<HostState>;
  get(): Promise<HostState>;
  set(input: { patch: Partial<HostState> }): Promise<HostState>;
}

export interface ClientActionsService {
  readonly state: ReplicatedState<{
    actions: ActionInfo[];
    byAgent: Record<string, ActionInfo[]>;
    sidebars: Record<string, { kind: string; text: string }[]>;
  }>;
  list(): Promise<readonly ActionInfo[]>;
  invoke(input: { agentId: AgentId; actionId: string; args: unknown }): Promise<unknown>;
}

export interface ClientAgentsService {
  readonly state: ReplicatedState<{
    agents: AgentInfo[];
    runtime: Record<string, AgentRuntimeInfo>;
  }>;
  list(): Promise<readonly AgentInfo[]>;
  get(input: { agentId: AgentId }): Promise<AgentDefinition>;
  update(input: { agentId: AgentId; patch: Partial<AgentDefinition> }): Promise<AgentDefinition>;
  spawn(input: { definition: AgentDefinitionInput }): Promise<AgentId>;
  kill(input: { agentId: AgentId }): Promise<void>;
  send(input: { agentId: AgentId; kind: 'steer' | 'followUp' | 'write'; text: string }): Promise<void>;
  renderPrompt(input: { agentId: AgentId }): Promise<RenderedPrompt>;
}

export interface ClientTranscriptsService {
  readonly events: ReplicatedState<{ recent: TranscriptEvent[] }>;
  page(input: { agentId: AgentId; before?: number; limit: number }): Promise<TranscriptPage>;
  delta(input: { agentId: AgentId; after?: number }): Promise<{ items: TranscriptMessage[]; hasMore: boolean }>;
  active(): Promise<readonly AgentId[]>;
}

export interface ClientProvidersService {
  readonly state: ReplicatedState<{ providers: ProviderInfo[] }>;
  list(): Promise<readonly ProviderInfo[]>;
  models(input: { providerId: string }): Promise<readonly ProviderModelInfo[]>;
  setKey(input: { providerId: string; key: string }): Promise<ProviderInfo>;
  clearKey(input: { providerId: string }): Promise<ProviderInfo>;
  setCustom(input: { record: CustomProviderRecord }): Promise<ProviderInfo>;
  removeCustom(input: { providerId: string }): Promise<void>;
}

export interface ClientUiContributionsService {
  readonly state: ReplicatedState<{
    tabs: { tab: string; componentId: string }[];
    badges: { tab: string; text: string; tone?: string }[];
  }>;
  contribute(input: { tab?: { tab: string; componentId: string } }): Promise<void>;
}

export interface ClientEventsService {
  readonly state: ReplicatedState<{ recent: SystemEvent[] }>;
  emit(input: SystemEvent): Promise<void>;
}

/** 宿主 shell 暴露给插件 UI 的运行时能力。 */
export interface UiHost {
  readonly services: ClientServices;
  /** 读取 `window.location.hash` 对应的路由。 */
  readonly route: { readonly tab: string; readonly param?: string };
  navigate(hash: string): void;
  /** 当前用户昵称（用于写进对话窗消息）。 */
  readonly nickname: string;
}

/** 插件 UI 入口：把组件注册到某个 Tab。 */
export interface MoonanPluginUi {
  readonly id: string;
  /** 该插件为哪个 Tab 提供内容；不填表示只提供小组件。 */
  readonly tab?: 'providers' | 'agents' | 'conversation' | 'logs';
  /** 直接渲染该 Tab 的主内容。 */
  readonly render?: (host: UiHost) => unknown;
}

export function definePluginUi(ui: MoonanPluginUi): MoonanPluginUi {
  return ui;
}

export * from './types.js';
export * from './constants.js';
