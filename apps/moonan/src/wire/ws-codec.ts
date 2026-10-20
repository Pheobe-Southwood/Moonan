/**
 * 自研的最小 RFC 6455 服务端编解码。
 *
 * 只实现 Moonan 需要的部分：握手校验、二进制帧的收与发、ping/pong、close、分片重组。
 * 不依赖任何第三方库。
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
} as const;

/** 计算 `Sec-WebSocket-Accept`。 */
export function acceptKey(clientKey: string): string {
  return createHash('sha1')
    .update(`${clientKey}${WS_GUID}`)
    .digest('base64');
}

export interface HandshakeResult {
  readonly ok: boolean;
  readonly status?: number;
  readonly reason?: string;
  readonly accept?: string;
  readonly protocol?: string;
}

/** 校验升级请求。`protocols` 里第一个被客户端接受的即为选定子协议。 */
export function handleHandshake(request: IncomingMessage, protocols: readonly string[]): HandshakeResult {
  const upgrade = request.headers.upgrade?.toLowerCase();
  if (upgrade !== 'websocket') return { ok: false, status: 400, reason: 'Expected websocket upgrade' };
  const key = request.headers['sec-websocket-key'];
  if (typeof key !== 'string' || key.length === 0) {
    return { ok: false, status: 400, reason: 'Missing Sec-WebSocket-Key' };
  }
  const version = request.headers['sec-websocket-version'];
  if (version !== '13') return { ok: false, status: 426, reason: 'Unsupported websocket version' };
  const offered = String(request.headers['sec-websocket-protocol'] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const selected = protocols.find((candidate) => offered.includes(candidate));
  return {
    ok: true,
    accept: acceptKey(key),
    ...(selected ? { protocol: selected } : {}),
  };
}

export interface DecodedFrame {
  readonly opcode: number;
  readonly payload: Uint8Array;
  readonly fin: boolean;
}

export type FrameError =
  | { readonly kind: 'need-more' }
  | { readonly kind: 'error'; readonly message: string; readonly closeCode: number };

export interface FrameDecodeResult {
  readonly frames: DecodedFrame[];
  readonly error?: { readonly message: string; readonly closeCode: number };
}

const MAX_PAYLOAD = 16 * 1024 * 1024;

/**
 * 增量解析一段字节流。
 *
 * 客户端帧必须带掩码（RFC 6455 §5.1）。返回解析出的完整帧，剩余字节留在内部缓冲。
 */
export class FrameParser {
  #buffer: Uint8Array = new Uint8Array(0);
  #fragments: Uint8Array[] = [];
  #fragmentOpcode = 0;

  constructor(private readonly maxPayload = MAX_PAYLOAD) {}

  push(chunk: Uint8Array): FrameDecodeResult {
    const merged = new Uint8Array(this.#buffer.length + chunk.length);
    merged.set(this.#buffer, 0);
    merged.set(chunk, this.#buffer.length);
    this.#buffer = merged;

    const frames: DecodedFrame[] = [];
    for (;;) {
      const parsed = this.#parseOne();
      if ('error' in parsed) return { frames, error: parsed.error };
      if (parsed.frame === undefined) return { frames };
      const frame = parsed.frame;
      if (frame.opcode === OPCODE.continuation) {
        if (this.#fragments.length === 0) {
          return { frames, error: { message: 'Unexpected continuation frame', closeCode: 1002 } };
        }
        this.#fragments.push(frame.payload);
        if (frame.fin) {
          const total = this.#fragments.reduce((sum, part) => sum + part.length, 0);
          const payload = new Uint8Array(total);
          let offset = 0;
          for (const part of this.#fragments) {
            payload.set(part, offset);
            offset += part.length;
          }
          const opcode = this.#fragmentOpcode;
          this.#fragments = [];
          frames.push({ opcode, payload, fin: true });
        }
        continue;
      }
      if (!frame.fin) {
        this.#fragments = [frame.payload];
        this.#fragmentOpcode = frame.opcode;
        continue;
      }
      frames.push(frame);
    }
  }

  #parseOne(): { frame?: DecodedFrame } | { error: { message: string; closeCode: number } } {
    const buffer = this.#buffer;
    if (buffer.length < 2) return {};
    const first = buffer[0] ?? 0;
    const second = buffer[1] ?? 0;
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (buffer.length < offset + 2) return {};
      length = ((buffer[offset] ?? 0) << 8) | (buffer[offset + 1] ?? 0);
      offset += 2;
    } else if (length === 127) {
      if (buffer.length < offset + 8) return {};
      let big = 0n;
      for (let index = 0; index < 8; index += 1) {
        big = (big << 8n) | BigInt(buffer[offset + index] ?? 0);
      }
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
        return { error: { message: 'Frame too large', closeCode: 1009 } };
      }
      length = Number(big);
      offset += 8;
    }

    if (length > this.maxPayload) {
      return { error: { message: 'Frame exceeds maximum payload', closeCode: 1009 } };
    }
    if (!masked) {
      // 客户端必须掩码；服务端发来的帧这里不接受。
      return { error: { message: 'Client frames must be masked', closeCode: 1002 } };
    }
    if (buffer.length < offset + 4 + length) return {};

    const mask = buffer.subarray(offset, offset + 4);
    offset += 4;
    const payload = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      payload[index] = (buffer[offset + index] ?? 0) ^ (mask[index % 4] ?? 0);
    }
    this.#buffer = buffer.subarray(offset + length);
    return { frame: { opcode, payload, fin } };
  }
}

/** 连接关闭码，避免魔数散落各处。 */
export const CLOSE = {
  normal: 1000,
  goingAway: 1001,
  protocolError: 1002,
  unsupportedData: 1003,
  policyViolation: 1008,
  tooLarge: 1009,
  internalError: 1011,
} as const;
