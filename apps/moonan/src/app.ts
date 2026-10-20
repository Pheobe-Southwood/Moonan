import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createFacetHost,
  createStaticFacetLoader,
  combineFacetLoaders,
  RemoteServiceProvider,
  type Service,
} from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Server } from '@earendil-works/pi-server';
import type { MutableModels } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import {
  ActionsToken,
  AgentsToken,
  EventsToken,
  HostStateToken,
  ProvidersToken,
  TranscriptsToken,
  UiContributionsToken,
  type AgentDefinition,
  type AgentDefinitionInput,
  type CustomProviderRecord,
  type HostState,
  type Logger,
  type SystemEvent,
  type UiContributionsService,
} from '@moonan/plugin-sdk';
import { BUILTIN_PLUGINS } from './plugins.js';
import { createLogger } from './runtime/logger.js';
import { createHostBundle, type HostServices } from './services/index.js';
import { createHttpServer, type MoonanHttpServer } from './server/http-server.js';
import { createWsBridge } from './server/ws-bridge.js';
import { createPiServerHost } from './server/pi-server-host.js';
import { createStore, type Store } from './store/index.js';

export interface AppOptions {
  readonly port?: number;
  readonly host?: string;
  /** 数据目录；默认 `~/.moonan`，可用 `MOONAN_HOME` 覆盖。 */
  readonly home?: string;
  /** WebUI 静态目录；默认相对本包 `dist/web`。 */
  readonly webRoot?: string;
  readonly logLevel?: 'debug' | 'info' | 'warn' | 'error';
}

export interface App {
  readonly store: Store;
  readonly models: MutableModels;
  readonly url: string;
  readonly services: HostServices;
  readonly plugins: readonly { id: string; facet: string }[];
  readonly log: Logger;
  close(): Promise<void>;
}

export function resolveHome(override?: string): string {
  const home = override ?? process.env['MOONAN_HOME'] ?? join(homedir(), '.moonan');
  const absolute = resolve(home);
  mkdirSync(absolute, { recursive: true });
  return absolute;
}

/**
 * 组装并启动 Moonan。
 *
 * 结构：HTTP(21315) + 自研 WebSocket → pi-server(ByteConnection) + Chord facet host
 * （宿主服务 + 五个官方插件）→ pi-agent-core 运行实体。
 */
export async function createApp(options: AppOptions = {}): Promise<App> {
  const home = resolveHome(options.home);
  const log = createLogger({ namespace: 'moonan', level: options.logLevel ?? 'info' });
  const store = createStore(join(home, 'moonan.db'));
  const serverId = store.settings.get('host.serverId') ?? randomUUID();
  store.settings.set('host.serverId', serverId);
  log.info(`数据目录 ${home}（schema v${store.db.schemaVersion}）`);

  // 明文凭据存储直接注入 pi-ai：配置一改，下一次请求即可生效。
  const models = builtinModels({ credentials: store.credentials });

  const holder: { services?: HostServices } = {};
  const bundle = createHostBundle({ store, models, log, plugins: BUILTIN_PLUGINS, holder });

  const loader = combineFacetLoaders([createStaticFacetLoader([...bundle.facets])]);
  const loaded = await loader.load();
  const host = await createFacetHost({
    facets: loaded.facets,
    onError: (error) => log.warn('chord 错误', error.message),
  });

  const ready = holder.services;
  if (!ready) throw new Error('宿主服务未就绪');

  /**
   * wire 侧的服务提供者。
   *
   * 不使用 chord facet host 内部那个 provider：它只为 facet 之间的依赖服务，
   * 而 pi-server 的路由需要额外放行 chord 的 `$chord.service` 控制服务
   * （订阅就是通过它进来的），因此这里单独建一个并显式登记。
   */
  const wireProvider = new RemoteServiceProvider([
    { id: '$chord.service' },
    { id: 'moonan.host-state' },
    { id: 'moonan.actions' },
    { id: 'moonan.agents' },
    { id: 'moonan.transcripts' },
    { id: 'moonan.providers' },
    { id: 'moonan.ui' },
    { id: 'moonan.events' },
  ]);
  for (const [token, implementation] of SERVICES_FOR_WIRE(ready)) {
    wireProvider.provide(token as Service<never>, implementation as never);
  }
  void host.services;

  // Chord 按依赖顺序逐个激活 facet；插件自己的跨服务初始化在各自 onActivate 里跑，
  // 这里做的是宿主级的收尾（装载自定义 provider、发布初始状态）。
  await bundle.initialize(ready);

  // 数据面：路由与订阅全部由 pi-server 处理。
  const piServer = new Server(
    createPiServerHost({ serverId, services: wireProvider, agents: ready.manager }),
    { listeners: [], serverId, onError: (error) => log.warn('pi-server 错误', error.message) },
  );
  await piServer.start();

  const wsBridge = createWsBridge({
    log,
    accept: (connection) => piServer.accept(connection),
  });

  const http: MoonanHttpServer = createHttpServer({
    port: options.port ?? Number(process.env['MOONAN_PORT'] ?? 21315),
    host: options.host ?? '127.0.0.1',
    webRoot: options.webRoot ?? defaultWebRoot(),
    log,
    meta: () => ({
      version: process.env['MOONAN_VERSION'] ?? '0.0.1-rc.1',
      serverId,
      protocol: 'pi-server/8',
      home,
      plugins: bundle.entries.map((entry) => entry.id),
      agents: ready.manager.definitions().map((definition) => definition.id),
    }),
    health: () => ({ ok: true, uptime: process.uptime() }),
  });
  wsBridge.attach(http.server);
  await http.listen();

  return {
    store,
    models,
    url: http.url(),
    services: ready,
    plugins: bundle.entries,
    log,
    async close() {
      await wsBridge.closeAll();
      await http.close();
      await piServer.close();
      await ready.manager.disposeAll();
      await host.dispose();
      store.close();
    },
  };
}

/** WebUI 静态产物：本文件编译到 `dist/app.js`，产物在相邻的 `dist/web`。 */
function defaultWebRoot(): string {
  return resolve(import.meta.dirname, 'web');
}

/**
 * wire 上要暴露的服务清单（id 必须与 SDK 里的 `REMOTE_SERVICE_IDS` 一致）。
 *
 * 注意这里返回的是**只含契约成员的门面**：chord 会校验「可远端暴露」的成员形状，
 * 内部字段（如 manager、onChange）会让校验失败。
 */
function SERVICES_FOR_WIRE(services: HostServices): readonly (readonly [unknown, unknown])[] {
  const context = BACKGROUND_CONTEXT;
  return [
    [
      HostStateToken,
      {
        state: services.hostState.state,
        get: () => services.hostState.get(context),
        set: (input: { patch: Partial<HostState> }) => services.hostState.set(input, context),
      },
    ],
    [
      ActionsToken,
      {
        state: services.actions.state,
        list: () => services.actions.list(context),
        invoke: (input: { agentId: string; actionId: string; args: unknown }) =>
          services.actions.invoke(input, context),
      },
    ],
    [
      AgentsToken,
      {
        state: services.agents.state,
        list: () => services.agents.list(context),
        get: (input: { agentId: string }) => services.agents.get(input, context),
        update: (input: { agentId: string; patch: Partial<AgentDefinition> }) =>
          services.agents.update(input, context),
        spawn: (input: { definition: AgentDefinitionInput }) => services.agents.spawn(input, context),
        kill: (input: { agentId: string }) => services.agents.kill(input, context),
        send: (input: { agentId: string; kind: 'steer' | 'followUp' | 'write'; text: string }) =>
          services.agents.send(input, context),
        renderPrompt: (input: { agentId: string }) => services.agents.renderPrompt(input, context),
      },
    ],
    [
      TranscriptsToken,
      {
        events: services.transcripts.events,
        page: (input: { agentId: string; before?: number; limit: number }) =>
          services.transcripts.page(input, context),
        delta: (input: { agentId: string; after?: number }) => services.transcripts.delta(input, context),
        active: () => services.transcripts.active(context),
      },
    ],
    [
      ProvidersToken,
      {
        state: services.providers.state,
        list: () => services.providers.list(context),
        models: (input: { providerId: string }) => services.providers.models(input, context),
        setKey: (input: { providerId: string; key: string }) => services.providers.setKey(input, context),
        clearKey: (input: { providerId: string }) => services.providers.clearKey(input, context),
        setCustom: (input: { record: CustomProviderRecord }) =>
          services.providers.setCustom(input, context),
        removeCustom: (input: { providerId: string }) => services.providers.removeCustom(input, context),
      },
    ],
    [
      UiContributionsToken,
      {
        state: services.ui.state,
        contribute: (input: Parameters<UiContributionsService['contribute']>[0]) =>
          services.ui.contribute(input, context),
      },
    ],
    [
      EventsToken,
      {
        state: services.events.state,
        emit: (input: SystemEvent) => services.events.emit(input, context),
      },
    ],
  ];
}
