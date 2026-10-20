import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import type { Logger } from '@moonan/plugin-sdk';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export interface HttpServerOptions {
  readonly port: number;
  readonly host: string;
  readonly webRoot: string;
  readonly log: Logger;
  readonly meta: () => unknown;
  readonly health: () => unknown;
  /** 是否把 `*` 回落到 index.html（SPA 路由）。 */
  readonly spa?: boolean;
}

export interface MoonanHttpServer {
  readonly server: HttpServer;
  /** 实际监听的端口（`port: 0` 时由系统分配）。 */
  port(): number;
  url(): string;
  listen(): Promise<void>;
  close(): Promise<void>;
}

export function createHttpServer(options: HttpServerOptions): MoonanHttpServer {
  const webRoot = resolve(options.webRoot);
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      options.log.error('HTTP 处理失败', error);
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('内部错误');
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (url.pathname === '/api/health') {
      return sendJson(response, 200, options.health());
    }
    if (url.pathname === '/api/meta') {
      return sendJson(response, 200, options.meta());
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return sendJson(response, 405, { error: 'method_not_allowed' });
    }
    return serveStatic(url.pathname, response);
  }

  function serveStatic(pathname: string, response: ServerResponse): void {
    const relative = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
    const candidate = join(webRoot, relative);
    if (!candidate.startsWith(webRoot)) {
      return sendJson(response, 403, { error: 'forbidden' });
    }
    const target = pickFile(candidate, webRoot, options.spa ?? true);
    if (!target) return sendJson(response, 404, { error: 'not_found' });
    const type = MIME[extname(target)] ?? 'application/octet-stream';
    response.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
    createReadStream(target).pipe(response);
  }

  return {
    server,
    port: () => {
      const address = server.address();
      return typeof address === 'object' && address !== null ? address.port : options.port;
    },
    url: () => `http://${options.host}:${server.address() && typeof server.address() === 'object' ? (server.address() as { port: number }).port : options.port}`,
    listen: () =>
      new Promise<void>((resolvePromise, reject) => {
        server.once('error', reject);
        server.listen(options.port, options.host, () => {
          server.removeListener('error', reject);
          options.log.info(`WebUI 已启动：http://${options.host}:${options.port}`);
          resolvePromise();
        });
      }),
    close: () =>
      new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
      }),
  };
}

/**
 * 解析一个静态文件请求。
 *
 * 命中文件直接返回；目录取 index.html；都不命中时（SPA 路由）回落到站点根的 index.html。
 */
function pickFile(candidate: string, webRoot: string, spa: boolean): string | undefined {
  try {
    const stat = statSync(candidate);
    if (stat.isFile()) return candidate;
    if (stat.isDirectory()) {
      const index = join(candidate, 'index.html');
      if (existsSync(index)) return index;
    }
  } catch {
    // 交给下面的 SPA 回落
  }
  if (!spa) return undefined;
  const index = join(webRoot, 'index.html');
  return existsSync(index) ? index : undefined;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}
