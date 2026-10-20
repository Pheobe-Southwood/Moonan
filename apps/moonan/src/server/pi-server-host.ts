import {
  createRemoteServiceEndpoint,
  type Context,
  type JsonValue,
  type RemoteServiceEndpoint,
  type RemoteServiceProvider,
  type ServiceCall,
  type ServiceProviderUpdate,
} from '@earendil-works/chord';
import type { ServerHost } from '@earendil-works/pi-server';
import type { ByteConnection } from './byte-connection.js';
import type { AgentManager } from '../runtime/agent-manager.js';

export interface HostSessionMetadata {
  readonly id: string;
}

export interface PiServerHostOptions {
  readonly serverId: string;
  readonly services: RemoteServiceProvider;
  readonly agents: AgentManager;
}

/** 发布回调：pi-server 用它把服务更新写回连接。 */
type PublishUpdate = (
  subscriptionId: string,
  update: ServiceProviderUpdate,
  context: Context,
) => void | Promise<void>;

/**
 * pi-server 的 `ServerHost` 实现。
 *
 * pi-server 只做**路由**：连接级服务与订阅全部转发给 `serverServices.invokeService`。
 * 因此应用侧必须负责两件事：
 *   1. 普通服务调用 → chord 的 `RemoteServiceProvider`（成员校验、状态编码都在它那里）；
 *   2. chord 的控制服务 `$chord.service`（catalogue / subscribe / unsubscribe）→
 *      pi-server 会处理订阅的生命周期与编码，但**不会自己应答**，所以要在这里应答。
 */
export function createPiServerHost(options: PiServerHostOptions): ServerHost<HostSessionMetadata> {
  const agents = options.agents;
  const serverServices = createRoutedServerServiceHost(options.services);
  return {
    serverServices,
    async resolveSession(sessionId: string): Promise<HostSessionMetadata> {
      if (!agents.has(sessionId)) throw new Error(`未知的 Agent：${sessionId}`);
      return { id: sessionId };
    },
    async openSession(metadata: HostSessionMetadata) {
      return {
        async attachClient() {
          return {
            async invokeService(call: ServiceCall): Promise<JsonValue | undefined> {
              return invokeAgentMethod(agents, call);
            },
            async release(): Promise<void> {
              // Agent 是常驻的，没有需要释放的呈现资源。
            },
          };
        },
        async close(): Promise<void> {
          // 不终止 Agent 本身：会话是持久的。
        },
      };
    },
  };
}

/** 从 `ServerHost` 上取出 server 级服务宿主的类型（pi-server 未从包根导出它）。 */
type RoutedServerServiceHostLike = ServerHost extends { serverServices: infer T } ? T : never;

/** 每个连接一个服务端点：连接断开时释放它的全部订阅。 */
export function createRoutedServerServiceHost(
  services: RemoteServiceProvider,
): RoutedServerServiceHostLike {
  return {
    attachClient() {
      const endpoint: RemoteServiceEndpoint = createRemoteServiceEndpoint(services);
      return {
        async invokeService(
          call: ServiceCall,
          publish: PublishUpdate,
          context: Context,
        ): Promise<JsonValue | undefined> {
          // `RemoteServiceEndpoint.invoke` 同时处理普通调用与 chord 的控制调用
          // （catalogue / subscribe / unsubscribe），并接管该连接的全部订阅。
          return endpoint.invoke(call, publish, context);
        },
        async release(): Promise<void> {
          endpoint.dispose();
        },
      };
    },
  } as RoutedServerServiceHostLike;
}

async function invokeAgentMethod(
  agents: AgentManager,
  call: ServiceCall,
): Promise<JsonValue | undefined> {
  const agentId = call.instance?.key;
  if (!agentId) throw new Error('session 调用缺少 agent 标识');
  if (!agents.has(agentId)) throw new Error(`未知的 Agent：${agentId}`);
  switch (call.member) {
    case 'send': {
      const [kind, text] = call.args as unknown as [string, string];
      agents.send(agentId, kind as 'steer' | 'followUp' | 'write', String(text ?? ''));
      return undefined;
    }
    case 'abort':
      agents.abort(agentId);
      return undefined;
    default:
      throw new Error(`Agent 不支持的方法：${call.member}`);
  }
}

export type { ByteConnection };
