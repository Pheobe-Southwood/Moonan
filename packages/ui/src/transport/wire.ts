/**
 * WebUI 侧 wire：浏览器与服务器之间的 CBOR 帧 + chord 远端服务绑定。
 *
 * 协议与 node 侧完全一致（`@earendil-works/pi-protocol` 的信封 + framing），
 * 所以「插件写一次数据访问层，node 与 UI 两侧都能用」这句话是真的。
 */
import {
  PROTOCOL_VERSION,
  ServerMessageDecoder,
  encodeClientMessage,
  type ClientMessage,
  type ResponseEnvelope,
  type RpcTarget,
  type ServerMessage,
  type ServiceEventEnvelope,
} from '@earendil-works/pi-protocol';
import {
  createRemoteServiceBinding,
  createServiceStateDecoder,
  createServiceSubscribeCall,
  createServiceUnsubscribeCall,
  type Context,
  type JsonValue,
  type RemoteServiceBinding,
  type RemoteServiceTransport,
  type ServiceCall,
  type ServiceMode,
  type ServiceProviderUpdate,
  type ServiceSubscription,
  type ServiceSubscriptionSnapshot,
} from '@earendil-works/chord';

const EMPTY_RESULT = undefined as unknown as JsonValue;

export interface WireOptions {
  readonly url: string;
  readonly protocols?: readonly string[];
  readonly onNotice?: (message: string) => void;
  readonly onStatus?: (status: WireStatus) => void;
}

export type WireStatus = 'connecting' | 'open' | 'closed' | 'error';

export interface WireClient {
  readonly status: WireStatus;
  readonly serverId: string | undefined;
  /** chord 的远端服务绑定：`use(service)` 拿到服务代理。 */
  readonly services: RemoteServiceBinding;
  close(): void;
  whenReady(): Promise<void>;
}

interface PendingInvoke {
  resolve(value: JsonValue | undefined): void;
  reject(error: Error): void;
}

interface LiveSubscription {
  readonly decoder: ReturnType<typeof createServiceStateDecoder>;
  readonly listener: (update: ServiceProviderUpdate, context: Context) => void;
  readonly context: Context;
}

export function createWire(options: WireOptions): WireClient {
  const url = options.url;
  const socket = new WebSocket(url, [...(options.protocols ?? [])]);
  socket.binaryType = 'arraybuffer';

  const decoder = new ServerMessageDecoder();
  const pending = new Map<string, PendingInvoke>();
  const subscriptions = new Map<string, LiveSubscription>();
  let nextId = 1;
  let status: WireStatus = 'connecting';
  let serverId: string | undefined;
  let readyResolve: () => void;
  let readyReject: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  function setStatus(next: WireStatus): void {
    status = next;
    options.onStatus?.(next);
  }

  socket.addEventListener('open', () => {
    setStatus('open');
    send({ type: 'hello', version: PROTOCOL_VERSION });
  });

  socket.addEventListener('message', (event: MessageEvent) => {
    const data = event.data;
    // 服务端只发二进制帧；文本帧直接忽略（例如调试用的人工回包）。
    if (!(data instanceof ArrayBuffer)) return;
    let messages: readonly ServerMessage[];
    try {
      messages = decoder.push(new Uint8Array(data)) as unknown as readonly ServerMessage[];
    } catch (error) {
      options.onNotice?.(`协议错误：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    for (const message of messages) handleServerMessage(message);
  });

  socket.addEventListener('error', () => {
    setStatus('error');
    options.onNotice?.('与服务器的连接出错');
  });

  socket.addEventListener('close', () => {
    setStatus('closed');
    for (const [, entry] of pending) entry.reject(new Error('连接已关闭'));
    pending.clear();
    subscriptions.clear();
  });

  function send(message: ClientMessage): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(encodeClientMessage(message));
  }

  function handleServerMessage(message: ServerMessage): void {
    switch (message.type) {
      case 'hello':
        serverId = message.serverId;
        readyResolve();
        break;
      case 'hello_error':
        readyReject(new Error(`${message.error.code}: ${message.error.message}`));
        options.onNotice?.(`握手失败：${message.error.message}`);
        break;
      case 'response':
        handleResponse(message);
        break;
      case 'service_update':
        handleServiceUpdate(message);
        break;
      default:
        break;
    }
  }

  function handleResponse(message: ResponseEnvelope): void {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.ok) entry.resolve(message.result as JsonValue | undefined);
    else entry.reject(new Error(`${message.error.code}: ${message.error.message}`));
  }

  function handleServiceUpdate(message: ServiceEventEnvelope): void {
    const subscription = subscriptions.get(message.subscriptionId);
    if (!subscription) return;
    try {
      const update = subscription.decoder.decodeUpdate(
        message.update as unknown as Parameters<typeof subscription.decoder.decodeUpdate>[0],
      ) as ServiceProviderUpdate;
      subscription.listener(update, subscription.context);
    } catch (error) {
      options.onNotice?.(`订阅解码失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const target: RpcTarget = { serverId: '00000000-0000-4000-8000-000000000000' };

  function invoke(call: ServiceCall, context: Context): Promise<JsonValue | undefined> {
    const id = `r${nextId++}`;
    return new Promise<JsonValue | undefined>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        send({ type: 'request', id, target: resolveTarget(), call: call as unknown as JsonValue });
      } catch (error) {
        pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
      const signal = context.abortSignal;
      if (signal) {
        signal.addEventListener('abort', () => {
          if (!pending.has(id)) return;
          pending.delete(id);
          reject(new Error('调用已取消'));
        });
      }
    });
  }

  /** 服务器目标里的 serverId 必须匹配；握手后才知道真实 id。 */
  function resolveTarget(): RpcTarget {
    if (serverId) return { serverId };
    return target;
  }

  const transport: RemoteServiceTransport = {
    invoke,
    async subscribe(
      serviceId: string,
      mode: ServiceMode,
      listener: (update: ServiceProviderUpdate, context: Context) => void,
      context: Context,
    ): Promise<ServiceSubscription> {
      const subscriptionId = `s${nextId++}`;
      const result = await invoke(createServiceSubscribeCall(subscriptionId, serviceId, mode), context);
      if (result === undefined) throw new Error(`订阅 ${serviceId} 未返回快照`);
      const decoder = createServiceStateDecoder();
      const snapshot = decoder.decodeSnapshot(
        result as unknown as Parameters<typeof decoder.decodeSnapshot>[0],
      );
      const entry: LiveSubscription = { decoder, listener, context };
      let active = false;
      return {
        snapshot: snapshot as ServiceSubscriptionSnapshot,
        activate: () => {
          active = true;
          subscriptions.set(subscriptionId, entry);
        },
        close: () => {
          subscriptions.delete(subscriptionId);
          if (active) {
            void invoke(createServiceUnsubscribeCall(subscriptionId), context).catch(() => EMPTY_RESULT);
          }
        },
      };
    },
  };

  const services = createRemoteServiceBinding({
    services: [
      { id: 'moonan.host-state' },
      { id: 'moonan.actions' },
      { id: 'moonan.agents' },
      { id: 'moonan.transcripts' },
      { id: 'moonan.providers' },
      { id: 'moonan.ui' },
      { id: 'moonan.events' },
    ],
    transport,
    onError: (error) => options.onNotice?.(error.message),
    assertAccess: () => {
      if (status === 'closed') throw new Error('连接已关闭');
    },
  });

  return {
    get status() {
      return status;
    },
    get serverId() {
      return serverId;
    },
    services,
    whenReady: () => ready,
    close: () => socket.close(),
  };
}
