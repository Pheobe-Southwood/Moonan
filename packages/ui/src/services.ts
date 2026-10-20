import { createContext, useContext, useEffect, useState } from 'react';
import type { ReplicatedState } from '@earendil-works/chord';
import {
  ClientActionsToken,
  ClientAgentsToken,
  ClientEventsToken,
  ClientProvidersToken,
  ClientStateToken,
  ClientTranscriptsToken,
  ClientUiToken,
  type ClientServices,
} from '@moonan/plugin-sdk';

/**
 * 客户端的服务 token。
 *
 * 它们与 node 侧的服务共用同一个 id——这正是「插件写一次数据访问层、两侧都能跑」
 * 的前提：chord 的远端绑定按 id 找到服务，方法签名去掉末尾的 `Context`。
 * token 定义在 SDK 里（纯数据），这样非 React 的客户端与测试也能直接引用。
 */
export const STATE_SERVICE = ClientStateToken;
export const ACTIONS_SERVICE = ClientActionsToken;
export const AGENTS_SERVICE = ClientAgentsToken;
export const TRANSCRIPTS_SERVICE = ClientTranscriptsToken;
export const PROVIDERS_SERVICE = ClientProvidersToken;
export const UI_SERVICE = ClientUiToken;
export const EVENTS_SERVICE = ClientEventsToken;

/** 由 shell 在握手完成后构造。 */
export function acquireServices(use: (service: never) => unknown): ClientServices {
  return {
    state: use(STATE_SERVICE as never) as ClientServices['state'],
    actions: use(ACTIONS_SERVICE as never) as ClientServices['actions'],
    agents: use(AGENTS_SERVICE as never) as ClientServices['agents'],
    transcripts: use(TRANSCRIPTS_SERVICE as never) as ClientServices['transcripts'],
    providers: use(PROVIDERS_SERVICE as never) as ClientServices['providers'],
    ui: use(UI_SERVICE as never) as ClientServices['ui'],
    events: use(EVENTS_SERVICE as never) as ClientServices['events'],
  };
}

/** React 上下文：把服务句柄传给各个 Tab。 */
export const ServicesContext = createContext<ClientServices | undefined>(undefined);

export function useServices(): ClientServices {
  const services = useContext(ServicesContext);
  if (!services) throw new Error('ServicesContext 尚未提供');
  return services;
}

/** 订阅一个 replicated state，返回当前值（未 hydrate 时为 undefined）。 */
export function useReplicatedValue<T>(state: ReplicatedState<T>): T | undefined {
  const [value, setValue] = useState<T | undefined>(() => state.value);
  useEffect(() => {
    setValue(state.value);
    return state.subscribe((next: T) => setValue(next));
  }, [state]);
  return value;
}
