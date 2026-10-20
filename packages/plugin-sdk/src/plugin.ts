/** 插件 node 侧入口的契约。 */
import type { FacetEnvironment } from '@earendil-works/chord';
import type { TSchema } from 'typebox';
import type {
  ActionDescriptor,
  ActionInfo,
  AgentDefinition,
  AgentDefinitionInput,
  AgentId,
  AgentInfo,
  CustomProviderRecord,
  PluginTool,
  ProviderInfo,
  ProviderModelInfo,
  RenderedPrompt,
  SystemEvent,
  TabContribution,
  BadgeContribution,
} from './contracts.js';
import type { Logger } from './contracts.js';

/**
 * 插件向宿主注册东西的入口。
 *
 * 「注册」只在 node 侧存在（有副作用、且必须在 facet setup 阶段完成），因此不放进
 * 跨 wire 的服务契约，而是作为 facet 环境的一部分注入。
 */
export interface PluginDefine {
  /** 注册一个可被 `act` 调用的 action。 */
  action(descriptor: ActionDescriptor<TSchema>): void;
  /** 注册一个额外的 tool。 */
  tool(tool: PluginTool): void;
}

/** Agent 相关能力（plugin 视角：不需要传 chord Context）。 */
export interface PluginAgentsApi {
  list(): Promise<readonly AgentInfo[]>;
  get(input: { agentId: AgentId }): Promise<AgentDefinition>;
  update(input: { agentId: AgentId; patch: Partial<AgentDefinition> }): Promise<AgentDefinition>;
  spawn(input: { definition: AgentDefinitionInput }): Promise<AgentId>;
  kill(input: { agentId: AgentId }): Promise<void>;
  send(input: { agentId: AgentId; kind: 'steer' | 'followUp' | 'write'; text: string }): Promise<void>;
  renderPrompt(input: { agentId: AgentId }): Promise<RenderedPrompt>;
}

export interface PluginActionsApi {
  list(): Promise<readonly ActionInfo[]>;
  invoke(input: { agentId: AgentId; actionId: string; args: unknown }): Promise<{ ok: boolean; text: string }>;
}

export interface PluginTranscriptsApi {
  page(input: { agentId: AgentId; before?: number; limit: number }): Promise<unknown>;
  delta(input: { agentId: AgentId; after?: number }): Promise<unknown>;
  active(): Promise<readonly AgentId[]>;
}

export interface PluginProvidersApi {
  list(): Promise<readonly ProviderInfo[]>;
  models(input: { providerId: string }): Promise<readonly ProviderModelInfo[]>;
  setKey(input: { providerId: string; key: string }): Promise<ProviderInfo>;
  clearKey(input: { providerId: string }): Promise<ProviderInfo>;
  setCustom(input: { record: CustomProviderRecord }): Promise<ProviderInfo>;
  removeCustom(input: { providerId: string }): Promise<void>;
}

export interface PluginUiApi {
  contribute(input: { tab?: TabContribution; badge?: BadgeContribution }): Promise<void>;
}

export interface PluginEventsApi {
  emit(input: SystemEvent): Promise<void>;
}

export interface PluginStateApi {
  get(): Promise<import('./contracts.js').HostState>;
  set(input: { patch: Partial<import('./contracts.js').HostState> }): Promise<import('./contracts.js').HostState>;
}

/** setup 阶段可用的最小能力集。 */
export interface PluginServices {
  /** 只在需要时访问（chord 的服务句柄在属性访问时做阶段校验）。 */
  readonly log: Logger;
  readonly define: PluginDefine;
  /**
   * 注册激活阶段的工作（**唯一**可以访问宿主服务的时机）。
   *
   * 回调在本 facet 被激活时运行；宿主会等所有 `onReady` 完成后才发布 `/api/meta`。
   */
  readonly onReady: (fn: (ctx: PluginReadyContext) => void | Promise<void>) => void;
}

/**
 * 插件装配函数。
 *
 * **必须同步完成**，而且此时**只能**注册自己提供的东西（`env.provide`）与登记钩子。
 *
 * 为什么不能用别人的服务：Chord 的服务句柄在**属性访问时**就做阶段校验，而此时
 * 宿主 facet 还处于 `setting_up`，会抛 “service handles cannot be used while setting_up”。
 * 因此所有跨服务的工作都放进 `services.onReady(...)`——它在本 facet 激活时运行，
 * 那时依赖已经绑定完毕。
 */
export type PluginSetup = (env: FacetEnvironment, services: PluginServices) => void;

/** 宿主暴露给插件的全部能力（数据面）。 */
export interface PluginRuntimeApi {
  readonly state: PluginStateApi;
  readonly actions: PluginActionsApi;
  readonly agents: PluginAgentsApi;
  readonly transcripts: PluginTranscriptsApi;
  readonly providers: PluginProvidersApi;
  readonly ui: PluginUiApi;
  readonly events: PluginEventsApi;
  readonly log: Logger;
  readonly define: PluginDefine;
}

/** `onReady` 回调收到的上下文：数据面 + 自己的 facet 环境。 */
export interface PluginReadyContext extends PluginRuntimeApi {
  readonly env: FacetEnvironment;
}

export interface MoonanPluginNode {
  readonly id: string;
  readonly setup: PluginSetup;
}

/**
 * 声明一个插件的 node 侧 facet。
 *
 * 宿主会把它包成 Chord 的 `Facet` 并放进 facet host；`setup` 必须同步完成，
 * 异步初始化放进 `env.onActivate`。
 */
export function definePlugin(plugin: MoonanPluginNode): MoonanPluginNode {
  return plugin;
}
