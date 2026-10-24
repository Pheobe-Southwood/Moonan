import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { acceptWebSockets, type Host, type ReloadReport } from "@earendil-works/chord";
import { Routes } from "@moonan_ai/sdk";
import { WebSocketServer } from "ws";
import type { Logger } from "./logger.js";
import { describe, errorMessage, type PluginRecord, type Principal } from "./types.js";

export interface WebServerOptions {
	host: Host<Principal>;
	port: number;
	hostname: string;
	version: string;
	/** Absent when the shell has not been built: the API and the WebSocket still work. */
	webDist?: string;
	plugins: () => PluginRecord[];
	reload: (id?: string) => Promise<{ reloaded: string[]; report?: ReloadReport }>;
	logger: Logger;
}

export interface WebServerHandle {
	server: Server;
	port: number;
	url: string;
	close: () => Promise<void>;
}

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".txt": "text/plain; charset=utf-8",
};

function sendJson(response: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"content-length": Buffer.byteLength(payload),
	});
	response.end(payload);
}

async function sendFile(response: ServerResponse, file: string, cache: boolean): Promise<boolean> {
	try {
		const info = await stat(file);
		if (!info.isFile()) return false;
		response.writeHead(200, {
			"content-type": MIME[extname(file)] ?? "application/octet-stream",
			"content-length": info.size,
			"cache-control": cache ? "public, max-age=31536000, immutable" : "no-cache",
		});
		createReadStream(file).pipe(response);
		return true;
	} catch {
		return false;
	}
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown> | undefined> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	if (chunks.length === 0) return undefined;
	try {
		const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/** A path inside `base` or nothing: `..` in a plugin asset URL must not escape the plugin. */
function within(base: string, relative: string): string | undefined {
	const target = resolve(join(base, relative));
	return target === base || target.startsWith(`${base}${sep}`) ? target : undefined;
}

/**
 * One port for everything: the WebSocket the Chord client speaks, the plugin assets the
 * browser imports, the routes plugins registered, and the shell.
 */
export async function startWebServer(options: WebServerOptions): Promise<WebServerHandle> {
	const wss = new WebSocketServer({ noServer: true });
	acceptWebSockets(wss, options.host, { principal: () => ({ id: "browser" }) });

	const plugins = options.plugins;

	const servePluginAsset = async (pathname: string, response: ServerResponse): Promise<boolean> => {
		const [, , rawId, ...rest] = pathname.split("/");
		const plugin = plugins().find((candidate) => candidate.id === rawId && candidate.web);
		if (!plugin?.web || rest.length === 0) {
			sendJson(response, 404, { error: "plugin not found" });
			return true;
		}
		const base = resolve(plugin.web.file, "..");
		const target = within(base, rest.join("/"));
		if (!target) {
			sendJson(response, 403, { error: "forbidden" });
			return true;
		}
		if (await sendFile(response, target, false)) return true;
		sendJson(response, 404, { error: "not found" });
		return true;
	};

	const serveStatic = async (pathname: string, response: ServerResponse): Promise<boolean> => {
		if (!options.webDist) return false;
		const root = resolve(options.webDist);
		const candidate = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
		const target = within(root, candidate);
		if (target && (await sendFile(response, target, candidate.startsWith("assets/")))) return true;
		// A client-side route that is not a file: hand it the shell.
		return sendFile(response, join(root, "index.html"), false);
	};

	const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		const url = new URL(request.url ?? "/", "http://localhost");
		const pathname = decodeURIComponent(url.pathname);
		const method = request.method ?? "GET";

		if (pathname === "/api/plugins") {
			sendJson(response, 200, {
				version: options.version,
				// Runtime-loaded browser facets are Moonan's own extension: chord ships no
				// browser loader, so the shape of this response is not a stable protocol yet.
				experimental: true,
				plugins: plugins().map(describe),
			});
			return;
		}

		if (pathname === "/api/plugins/reload") {
			if (method !== "POST") {
				sendJson(response, 405, { error: "method not allowed" });
				return;
			}
			const body = await readJson(request);
			const id = typeof body?.id === "string" ? body.id : undefined;
			try {
				const result = await options.reload(id);
				// Browsers are not reload participants in chord: only a page reload picks up
				// new browser facets, which is what the flag tells the client to do.
				sendJson(response, 200, { ok: true, reloadBrowser: true, ...result });
			} catch (error) {
				options.logger.error("plugin reload failed", error);
				sendJson(response, 400, { error: errorMessage(error) });
			}
			return;
		}

		if (pathname.startsWith("/plugins/")) {
			if (await servePluginAsset(pathname, response)) return;
		}

		// Plugin HTTP routes, resolved against the code version this root runs on.
		try {
			const handled = await options.host.root(async (ctx) => {
				const view = options.host.registry(Routes);
				const handler = view.get(`${method} ${pathname}`, ctx) ?? view.get(pathname, ctx);
				if (!handler) return false;
				await handler(request, response, ctx);
				return true;
			});
			if (handled) return;
		} catch (error) {
			options.logger.error(`route ${method} ${pathname} failed`, error);
			if (!response.headersSent) sendJson(response, 500, { error: "internal error" });
			else response.end();
			return;
		}

		if (await serveStatic(pathname, response)) return;

		sendJson(response, 404, { error: "not found" });
	};

	const server = createServer((request, response) => {
		handle(request, response).catch((error: unknown) => {
			options.logger.error("request failed", error);
			if (!response.headersSent) sendJson(response, 500, { error: "internal error" });
			else response.end();
		});
	});

	server.on("upgrade", (request, socket, head) => {
		if (!(request.url ?? "/").startsWith("/ws")) {
			socket.destroy();
			return;
		}
		wss.handleUpgrade(request, socket, head, (ws) => {
			wss.emit("connection", ws, request);
		});
	});

	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(options.port, options.hostname, () => {
			server.off("error", rejectListen);
			resolveListen();
		});
	});

	const address = server.address();
	const port = typeof address === "object" && address ? address.port : options.port;
	const url = `http://${options.hostname === "0.0.0.0" ? "127.0.0.1" : options.hostname}:${port}`;

	return {
		server,
		port,
		url,
		close: async () => {
			await new Promise<void>((resolveClose) => {
				wss.close(() => resolveClose());
				for (const client of wss.clients) client.terminate();
			});
			await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		},
	};
}
