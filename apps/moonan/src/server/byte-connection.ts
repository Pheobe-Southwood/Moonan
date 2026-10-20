import type { MaybePromise } from '@earendil-works/pi-server';

/**
 * pi-server 的 `ByteConnection` / `ByteConnectionHandler` 属于内部模块
 * （`pi-server/dist/connection.d.ts` 没有从包根导出），因此这里按它的公开用法
 * （`Server.accept(connection)` 的形参/返回值）重新声明，保持结构兼容。
 */
export interface ByteConnection {
  readonly closed: boolean;
  send(chunk: Uint8Array): Promise<void>;
  close(finalChunk?: Uint8Array): MaybePromise<void>;
}

export interface ByteConnectionHandler {
  onData(chunk: Uint8Array): void;
  onClose(): void;
  onError(error: Error): void;
}
