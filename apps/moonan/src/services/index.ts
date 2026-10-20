import { defineFacet, type Facet, type FacetEnvironment } from '@earendil-works/chord';
import type { MutableModels } from '@earendil-works/pi-ai';
import type { Context } from '@earendil-works/chord';
import {
  ActionsToken,
  AgentsToken,
  EventsToken,
  HostFacilityToken,
  HostStateToken,
  LoggerToken,
  PluginRegistryToken,
  ProvidersToken,
  TranscriptsToken,
  UiContributionsToken,
  type ActionAvailabilityInput,
  type ActionsService,
  type AgentsService,
  type HostState,
  type Logger,
  type MoonanPluginNode,
  type ProvidersService,
  type SystemEvent,
  type TranscriptsService,
  type UiContributionsService,
} from '@moonan/plugin-sdk';
import { AgentManager } from '../runtime/agent-manager.js';
import { createPluginFacet, createRegistry, type PluginEntry } from '../plugin-runtime.js';
import type { Store } from '../store/index.js';
import { ActionsServiceImpl } from './actions.js';
import { AgentsServiceImpl } from './agents.js';
import { HostStateServiceImpl } from './host-state.js';
import { EventsServiceImpl, ProvidersServiceImpl, UiContributionsServiceImpl } from './providers.js';
import { TranscriptsServiceImpl } from './transcripts.js';

export const HOST_FACET_ID = 'moonan.host';

export interface HostServices {
  readonly hostState: HostStateServiceImpl;
  readonly actions: ActionsServiceImpl;
  readonly agents: AgentsServiceImpl;
  readonly transcripts: TranscriptsServiceImpl;
  readonly providers: ProvidersServiceImpl;
  readonly ui: UiContributionsServiceImpl;
  readonly events: EventsServiceImpl;
  readonly manager: AgentManager;
  readonly log: Logger;
}

export interface HostFacetOptions {
  readonly store: Store;
  readonly models: MutableModels;
  readonly log: Logger;
  /** 要装载的插件（顺序即激活顺序）。 */
  readonly plugins: readonly MoonanPluginNode[];
  /** 宿主服务实现写出到这个 holder（Chord 的远端通道不服务进程内访问）。 */
  readonly holder?: { services?: HostServices };
}

export interface HostBundle {
  /** 宿主 facet 与每个插件 facet。 */
  readonly facets: readonly Facet[];
  /** 插件登记项（宿主 + 各插件），`/api/meta` 用它列出在场插件。 */
  readonly entries: PluginEntry[];
  /** 宿主激活完成后的回调。 */
  onReady(listener: (services: HostServices) => void | Promise<void>): void;

  /** 整个 facet host 激活完成后的初始化（此时所有服务都可用）。 */
  initialize(services: HostServices): Promise<void>;
}

/**
 * 组装全部 facet：宿主 facet + 每个插件一个 facet。
 *
 * 每个插件独立成 facet，Chord 因此能校验依赖图——缺服务会在启动时报错，而不是运行时炸。
 */
export function createHostBundle(options: HostFacetOptions): HostBundle {
  const registry = createRegistry();
  const readyListeners: ((services: HostServices) => void | Promise<void>)[] = [];


  const hostFacet = defineFacet({
    id: HOST_FACET_ID,
    setup(env: FacetEnvironment) {
      const hostState = new HostStateServiceImpl(env);
      const events = new EventsServiceImpl(env);

      const availability = (): Omit<ActionAvailabilityInput, 'agentId'> => {
        const state = hostState.snapshot();
        return {
          openDialog: state.openDialog,
          openTabs: [state.activeTab],
          now: Date.now(),
        };
      };

      const manager = new AgentManager({
        models: options.models,
        store: options.store,
        log: options.log,
        availability,
        onActionsChanged: () => actions.publish(),
        onAgentsChanged: () => {
          agents.publish();
          actions.publish();
          transcripts.publishActive();
        },
        onRuntimeChanged: () => agents.publishRuntime(),
        onTranscriptEvent: (event) => transcripts.emit(event),
      });

      const actions = new ActionsServiceImpl(env, manager);
      const agents = new AgentsServiceImpl(env, manager);
      const transcripts = new TranscriptsServiceImpl(env, options.store, manager);
      const providers = new ProvidersServiceImpl(env, options.store, options.models, options.log);
      const ui = new UiContributionsServiceImpl(env);

      const services: HostServices = {
        hostState,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        actions,
        agents,
        transcripts,
        providers,
        ui,
        events,
        manager,
        log: options.log,
      };

      // 只把契约里的成员暴露出去：chord 会校验「远端可暴露」的成员形状，
      // 多余的本地方法（如 onChange）会让校验失败。
      env.provide(HostStateToken, {
        state: hostState.state,
        get: (_context?: Context) => hostState.get(),
        set: (input: { patch: Partial<HostState> }, _context?: Context) => hostState.set(input),
      });
      env.provide(ActionsToken, {
        state: actions.state,
        list: (c?: Context) => actions.list(c),
        invoke: (input: Parameters<ActionsService['invoke']>[0], c?: Context) => actions.invoke(input, c),
      });
      env.provide(AgentsToken, {
        state: agents.state,
        list: (c?: Context) => agents.list(c),
        get: (input: Parameters<AgentsService['get']>[0], c?: Context) => agents.get(input, c),
        update: (input: Parameters<AgentsService['update']>[0], c?: Context) => agents.update(input, c),
        spawn: (input: Parameters<AgentsService['spawn']>[0], c?: Context) => agents.spawn(input, c),
        kill: (input: Parameters<AgentsService['kill']>[0], c?: Context) => agents.kill(input, c),
        send: (input: Parameters<AgentsService['send']>[0], c?: Context) => agents.send(input, c),
        renderPrompt: (input: Parameters<AgentsService['renderPrompt']>[0], c?: Context) =>
          agents.renderPrompt(input, c),
      });
      env.provide(TranscriptsToken, {
        events: transcripts.events,
        page: (input: Parameters<TranscriptsService['page']>[0], c?: Context) => transcripts.page(input, c),
        delta: (input: Parameters<TranscriptsService['delta']>[0], c?: Context) => transcripts.delta(input, c),
        active: (c?: Context) => transcripts.active(c),
      });
      env.provide(ProvidersToken, {
        state: providers.state,
        list: (c?: Context) => providers.list(c),
        models: (input: Parameters<ProvidersService['models']>[0], c?: Context) => providers.models(input, c),
        setKey: (input: Parameters<ProvidersService['setKey']>[0], c?: Context) => providers.setKey(input, c),
        clearKey: (input: Parameters<ProvidersService['clearKey']>[0], c?: Context) => providers.clearKey(input, c),
        setCustom: (input: Parameters<ProvidersService['setCustom']>[0], c?: Context) => providers.setCustom(input, c),
        removeCustom: (input: Parameters<ProvidersService['removeCustom']>[0], c?: Context) =>
          providers.removeCustom(input, c),
      });
      env.provide(UiContributionsToken, {
        state: ui.state,
        contribute: (input: Parameters<UiContributionsService['contribute']>[0], c?: Context) =>
          ui.contribute(input, c),
      });
      env.provide(EventsToken, {
        state: events.state,
        emit: (input: SystemEvent, c?: Context) => events.emit(input, c),
      });
      env.provide(LoggerToken, options.log);
      env.provide(PluginRegistryToken, registry.implementation);
      env.provide(HostFacilityToken, services);
      options.holder!.services = services;

      hostState.subscribeLocal(() => {
        actions.publish();
      });

      env.onActivate(async () => {
        // 只碰本 facet 自己提供的东西：其他 facet 可能还没激活。
        await registry.implementation.register({ id: HOST_FACET_ID, facet: 'host' });
        for (const plugin of options.plugins) {
          await registry.implementation.register({ id: plugin.id, facet: 'plugin' });
        }
      });

      env.onDeactivate(async () => {
        await manager.disposeAll();
      });
    },
  });

  return {
    facets: [hostFacet, ...options.plugins.map((plugin) => createPluginFacet(plugin))],
    entries: registry.entries,
    onReady: (listener) => {
      readyListeners.push(listener);
    },

    /** 整个 facet host 激活完成后的初始化（此时所有服务都可用）。 */
    initialize: async (services) => {
      await services.providers.loadCustomProviders();
      await services.providers.publish();
      services.agents.publish();
      services.actions.publish();
      services.transcripts.publishActive();
      for (const listener of readyListeners) await listener(services);
    },
  };
}
