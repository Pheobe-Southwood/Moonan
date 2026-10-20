import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { ByteConnection, ByteConnectionHandler } from '../server/byte-connection.js';
import { CLOSE, FrameParser, handleHandshake, OPCODE } from './ws-codec.js';

export interface WebSocketPeer {
  readonly remoteAddress: string;
  readonly protocols: readonly string[];
}

export interface WebSocketHubOptions {
  readonly path: string;
  readonly protocols: readonly string[];
  /** 每条连接建立后交给 pi-server 的 accept。 */
  readonly accept: (connection: ByteConnection, peer: WebSocketPeer) => ByteConnectionHandler;
  /** 握手前的鉴权；返回 false 时以 401 关闭。 */
  readonly authorize?: (request: IncomingMessage) => boolean;
  readonly maxPayload?: number;
  readonly onError?: (error: Error) => void;
}

/** 把 HTTP upgrade 的 socket 变成一个 `ByteConnection`，并把字节交给 pi-server。 */
class WebSocketConnection implements ByteConnection {
  #closed = false;
  #handler: ByteConnectionHandler | undefined;
  readonly #parser: FrameParser;
  readonly #socket: Socket;

  constructor(
    socket: Socket,
    private readonly options: WebSocketHubOptions,
    readonly peer: WebSocketPeer,
  ) {
    this.#socket = socket;
    this.#parser = new FrameParser(options.maxPayload);
    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) => this.#onData(new Uint8Array(chunk)));
    socket.on('error', (error: Error) => this.#fail(error));
    socket.on('close', () => this.#onClose());
  }

  get remoteAddress(): string {
    return this.peer.remoteAddress;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** 由 hub 在 accept 之后调用。 */
  attach(handler: ByteConnectionHandler): void {
    this.#handler = handler;
  }

  async send(chunk: Uint8Array): Promise<void> {
    if (this.#closed) return;
    await this.#writeFrame(OPCODE.binary, chunk);
  }

  async close(finalChunk?: Uint8Array): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      if (finalChunk) await this.#writeFrame(OPCODE.binary, finalChunk);
      await this.#writeFrame(OPCODE.close, closePayload(CLOSE.normal, 'bye'));
    } catch {
      // 关闭阶段忽略写失败
    }
    this.#socket.end();
    setTimeout(() => this.#socket.destroy(), 1000).unref?.();
  }

  #onData(chunk: Uint8Array): void {
    const result = this.#parser.push(chunk);
    for (const frame of result.frames) {
      if (frame.opcode === OPCODE.ping) {
        void this.#writeFrame(OPCODE.pong, frame.payload);
        continue;
      }
      if (frame.opcode === OPCODE.pong) continue;
      if (frame.opcode === OPCODE.close) {
        void this.close();
        return;
      }
      if (frame.opcode !== OPCODE.binary && frame.opcode !== OPCODE.text) continue;
      this.#handler?.onData(frame.payload);
    }
    if (result.error) {
      this.options.onError?.(new Error(`websocket 帧错误：${result.error.message}`));
      void this.#closeWith(result.error.closeCode, result.error.message);
    }
  }

  #onClose(): void {
    if (this.#closed) {
      this.#handler?.onClose();
      return;
    }
    this.#closed = true;
    this.#handler?.onClose();
  }

  #fail(error: Error): void {
    this.options.onError?.(error);
    if (this.#closed) return;
    this.#closed = true;
    this.#handler?.onError(error);
  }

  async #closeWith(code: number, reason: string): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#writeFrame(OPCODE.close, closePayload(code, reason));
    } catch {
      // 忽略
    }
    this.#socket.end();
    this.#handler?.onClose();
  }

  #writeFrame(opcode: number, payload: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      const header = frameHeader(opcode, payload.length);
      const frame = new Uint8Array(header.length + payload.length);
      frame.set(header, 0);
      frame.set(payload, header.length);
      this.#socket.write(frame, (error) => (error ? reject(error) : resolve()));
    });
  }
}

/** 挂在 HTTP server 的 `upgrade` 事件上。 */
export class WebSocketHub {
  readonly #connections = new Set<WebSocketConnection>();

  constructor(private readonly options: WebSocketHubOptions) {}

  get connectionCount(): number {
    return this.#connections.size;
  }

  attach(server: HttpServer): void {
    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname !== this.options.path) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }
      if (this.options.authorize && !this.options.authorize(request)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      const handshake = handleHandshake(request, this.options.protocols);
      if (!handshake.ok || !handshake.accept) {
        socket.write(`HTTP/1.1 ${handshake.status ?? 400} ${handshake.reason ?? 'Bad Request'}\r\n\r\n`);
        socket.destroy();
        return;
      }
      const lines = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${handshake.accept}`,
      ];
      if (handshake.protocol) lines.push(`Sec-WebSocket-Protocol: ${handshake.protocol}`);
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length > 0) socket.unshift(head);

      const peer: WebSocketPeer = {
        remoteAddress: request.socket.remoteAddress ?? 'unknown',
        protocols: handshake.protocol ? [handshake.protocol] : [],
      };
      const connection = new WebSocketConnection(socket as Socket, this.options, peer);
      this.#connections.add(connection);
      connection.attach(this.options.accept(connection, peer));
    });
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.#connections].map((connection) => connection.close()));
    this.#connections.clear();
  }
}

function frameHeader(opcode: number, length: number): Uint8Array {
  if (length < 126) {
    return new Uint8Array([0x80 | opcode, length]);
  }
  if (length < 65_536) {
    return new Uint8Array([0x80 | opcode, 126, (length >> 8) & 0xff, length & 0xff]);
  }
  const header = new Uint8Array(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  let remaining = BigInt(length);
  for (let index = 9; index >= 2; index -= 1) {
    header[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return header;
}

function closePayload(code: number, reason: string): Uint8Array {
  const reasonBytes = new TextEncoder().encode(reason.slice(0, 100));
  const payload = new Uint8Array(2 + reasonBytes.length);
  payload[0] = (code >> 8) & 0xff;
  payload[1] = code & 0xff;
  payload.set(reasonBytes, 2);
  return payload;
}
