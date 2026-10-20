/**
 * Moonan 插件契约的服务 token 与聚合入口。
 *
 * 类型定义在 `types.ts`（纯类型），这里只放需要运行时的东西（`defineService`）
 * 以及把两部分一起导出的入口。
 */
import { defineService, type Service } from '@earendil-works/chord';
import type {
  ActionsService,
  AgentsService,
  EventsService,
  HostStateService,
  Logger,
  PluginRegistry,
  ProvidersService,
  TranscriptsService,
  UiContributionsService,
} from './types.js';

export * from './types.js';

/**
 * facet 依赖注入用的进程内 token。
 *
 * 它**不是**远端服务：插件用 `env.use()` 取宿主服务的实现，比逐方法构造更直接。
 */
export const HostFacilityToken = defineService<unknown>('moonan.host-facility', { local: true });

// ---------------------------------------------------------------------------
// 服务 token
// ---------------------------------------------------------------------------

export const HostStateToken = defineService<HostStateService>('moonan.host-state');
export const ActionsToken = defineService<ActionsService>('moonan.actions');
export const AgentsToken = defineService<AgentsService>('moonan.agents');
export const TranscriptsToken = defineService<TranscriptsService>('moonan.transcripts');
export const ProvidersToken = defineService<ProvidersService>('moonan.providers');
export const UiContributionsToken = defineService<UiContributionsService>('moonan.ui');
export const EventsToken = defineService<SystemEventsService>('moonan.events');
export const LoggerToken = defineService<Logger>('moonan.log', { local: true });

/**
 * 插件登记服务。
 *
 * 声明为 **local**：它是进程内的装配依赖，不跨 wire。
 */
export const PluginRegistryToken = defineService<PluginRegistry>('moonan.plugins', { local: true });

/** `moonan.events` 的完整契约（`emit` 只有 node 侧需要，故单独命名）。 */
export interface SystemEventsService extends EventsService {
  /** node 侧专用：`emit` 已在 {@link EventsService} 中声明。 */
}



// ---------------------------------------------------------------------------
// WebUI 侧的服务 token
// ---------------------------------------------------------------------------

/**
 * 客户端侧的 token。
 *
 * 与上面的同名服务共用 **同一个 id**；类型参数用的是 `./client.js` 里那份
 * 「方法少一个 `Context`」的契约。因为 id 相同，node 与浏览器两侧可以用同一个
 * 服务名、同一份数据访问代码（见 README 的插件开发一节）。
 *
 * 放在 SDK（而不是 UI 包）里的原因：token 是纯数据，测试与将来非 React 的客户端
 * 都能直接引用它，不必把 React 拽进来。
 */
import type { ClientServices } from './client.js';

/**
 * 客户端的 token 直接按 chord 的 `Service<T>` 形状构造。
 *
 * 不走 `defineService`：它的重载会做「可远端暴露」校验，而客户端契约刻意少了末尾的
 * `Context` 参数（那是服务端补的），因此在这里会判定为不可暴露。
 * token 只是 `{ id, local }` 两个数据字段，直接构造并经一次断言即可。
 */
function clientService<T>(id: string): Service<T> {
  return { id, local: false } as Service<T>;
}

export const ClientStateToken = clientService<ClientServices['state']>('moonan.host-state');
export const ClientActionsToken = clientService<ClientServices['actions']>('moonan.actions');
export const ClientAgentsToken = clientService<ClientServices['agents']>('moonan.agents');
export const ClientTranscriptsToken = clientService<ClientServices['transcripts']>('moonan.transcripts');
export const ClientProvidersToken = clientService<ClientServices['providers']>('moonan.providers');
export const ClientUiToken = clientService<ClientServices['ui']>('moonan.ui');
export const ClientEventsToken = clientService<ClientServices['events']>('moonan.events');
