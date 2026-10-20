import type { Server as HttpServer } from 'node:http';
import { MOONAN_SUBPROTOCOL, REMOTE_SERVICE_IDS, type Logger } from '@moonan/plugin-sdk';
import type { ByteConnection, ByteConnectionHandler } from './byte-connection.js';
import { WebSocketHub, type WebSocketPeer } from '../wire/ws-listener.js';

export interface WsBridgeOptions {
  readonly log: Logger;
  /** 每条连接交给 pi-server。 */
  readonly accept: (connection: ByteConnection, peer: WebSocketPeer) => ByteConnectionHandler;
  /** 额外的握手校验（默认只做同源与本机检查）。 */
  readonly authorize?: (request: import('node:http').IncomingMessage) => boolean;
}

/**
 * WebSocket ↔ pi-server 桥。
 *
 * 安全模型（见 docs/adr/0005）：服务只绑定 127.0.0.1，因此可达性即授权；
 * 这里额外拒绝非本机来源，并拒绝跨站 `Origin`，避免浏览器被第三方页面利用。
 */
export function createWsBridge(options: WsBridgeOptions): WebSocketHub {
  return new WebSocketHub({
    path: '/api/ws',
    protocols: [MOONAN_SUBPROTOCOL],
    maxPayload: 16 * 1024 * 1024,
    accept: options.accept,
    authorize: (request) => {
      if (!isLoopback(request.socket.remoteAddress ?? '')) return false;
      const origin = request.headers.origin;
      if (typeof origin === 'string' && origin.length > 0 && !isLocalOrigin(origin)) return false;
      return options.authorize ? options.authorize(request) : true;
    },
    onError: (error) => options.log.warn('websocket 错误', error.message),
  });
}

export function attachWsBridge(server: HttpServer, bridge: WebSocketHub): void {
  bridge.attach(server);
}

function isLoopback(address: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function isLocalOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
  } catch {
    return false;
  }
}

export { REMOTE_SERVICE_IDS };
