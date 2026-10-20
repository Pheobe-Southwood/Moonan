import { defineFacet, type Facet, type FacetEnvironment } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { TSchema } from 'typebox';
import {
  HostFacilityToken,
  type ActionDescriptor,
  type MoonanPluginNode,
  type PluginDefine,
  type PluginReadyContext,
  type PluginServices,
  type PluginTool,
} from '@moonan/plugin-sdk';
import type { HostServices } from './services/index.js';

/**
 * 把一个插件的 node 侧入口包成 Chord facet。
 *
 * 适配层的两件事，让插件作者不用关心 chord 的细节：
 *   1. 走 `env.onActivate`，在其中把宿主服务包成不带 `Context` 参数的形态；
 *   2. 注入 `define.action` / `define.tool`，并把 owner 固定为该插件的 id。
 *
 * 注意 setup 阶段**不能**解析别的 facet 的服务（chord 会按阶段拒绝），因此这里在
 * setup 里只登记钩子，所有服务访问都发生在激活期。
 */
export function createPluginFacet(plugin: MoonanPluginNode): Facet {
  return defineFacet({
    id: plugin.id,
    setup(env: FacetEnvironment) {
      // 依赖必须在 setup 阶段声明；句柄本身可以在激活期再使用。
      const host = env.use(HostFacilityToken) as HostServices;
      let ready: ((ctx: PluginReadyContext) => void | Promise<void>) | undefined;

      const services: PluginServices = {
        get log() {
          return host.log;
        },
        get define() {
          return buildDefine(host, plugin.id);
        },
        onReady: (fn) => {
          ready = fn;
        },
      } as PluginServices;

      plugin.setup(env, services);

      env.onActivate(async () => {
        if (!ready) return;
        await ready(buildReadyContext(env, host, plugin.id));
      });
    },
  });
}

/** 目前插件是编译期 import 进宿主的；保留这个入口以便未来切换成 facet bundle 加载。 */
export function createPluginFacets(plugins: readonly MoonanPluginNode[]): Facet[] {
  return plugins.map((plugin) => createPluginFacet(plugin));
}

export interface PluginEntry {
  id: string;
  facet: string;
}

/** 进程内的登记接口：宿主直接调用，不经过 wire，因此不需要 chord Context。 */
export interface LocalPluginRegistry {
  register(input: PluginEntry): Promise<void>;
  list(): Promise<readonly PluginEntry[]>;
}

/** 插件登记服务的实现；宿主在激活后登记自己与所有插件。 */
export function createRegistry(): {
  implementation: LocalPluginRegistry;
  entries: PluginEntry[];
} {
  const entries: PluginEntry[] = [];
  return {
    entries,
    implementation: {
      async register(input: PluginEntry) {
        if (!entries.some((entry) => entry.id === input.id)) entries.push({ ...input });
      },
      async list() {
        return [...entries];
      },
    },
  };
}

function buildDefine(host: HostServices, owner: string): PluginDefine {
  return {
    action: (descriptor: ActionDescriptor<TSchema>) => host.manager.registerAction(owner, descriptor),
    tool: (tool: PluginTool) => host.manager.registerTool(owner, tool),
  };
}

function buildReadyContext(env: FacetEnvironment, host: HostServices, owner: string): PluginReadyContext {
  const context = BACKGROUND_CONTEXT;
  return {
    env,
    define: buildDefine(host, owner),
    log: host.log,
    state: {
      get: () => host.hostState.get(context),
      set: (input) => host.hostState.set(input, context),
    },
    actions: {
      list: () => host.actions.list(context),
      invoke: async (input) => {
        const result = await host.actions.invoke(input, context);
        return { ok: result.ok, text: result.text };
      },
    },
    agents: {
      list: () => host.agents.list(context),
      get: (input) => host.agents.get(input, context),
      update: (input) => host.agents.update(input, context),
      spawn: (input) => host.agents.spawn(input, context),
      kill: (input) => host.agents.kill(input, context),
      send: (input) => host.agents.send(input, context),
      renderPrompt: (input) => host.agents.renderPrompt(input, context),
    },
    transcripts: {
      page: (input) => host.transcripts.page(input, context),
      delta: (input) => host.transcripts.delta(input, context),
      active: () => host.transcripts.active(context),
    },
    providers: {
      list: () => host.providers.list(context),
      models: (input) => host.providers.models(input, context),
      setKey: (input) => host.providers.setKey(input, context),
      clearKey: (input) => host.providers.clearKey(input, context),
      setCustom: (input) => host.providers.setCustom(input, context),
      removeCustom: (input) => host.providers.removeCustom(input, context),
    },
    ui: {
      contribute: (input) => host.ui.contribute(input, context),
    },
    events: {
      emit: (input) => host.events.emit(input, context),
    },
  };
}
