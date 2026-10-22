import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { type Host, acceptWebSockets } from "@earendil-works/chord";
import { WebSocketServer } from "ws";
import type { Logger } from "./util.js";

export interface PluginWebAsset {
	id: string;
	name: string;
	/** Absolute path of the plugin's `web.js`. */
	file: string;
}

export interface WebServerOptions {
	chordHost: Host<unknown>;
	port: number;
	hostname: string;
	/** Built web app directory. Absent in dev mode, where Vite serves the app. */
	webDist?: string;
	version: string;
	plugins: () => PluginWebAsset[];
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

export async function startWebServer(options: WebServerOptions): Promise<WebServerHandle> {
	const server = createServer((request, response) => {
		handle(request, response).catch((error: unknown) => {
			options.logger.error("request failed", error);
			if (!response.headersSent) sendJson(response, 500, { error: "internal error" });
			else response.end();
		});
	});

	const wss = new WebSocketServer({ noServer: true });
	acceptWebSockets(wss, options.chordHost, {
		principal: () => ({ id: "local" }),
	});
	server.on("upgrade", (request, socket, head) => {
		const url = request.url ?? "/";
		if (!url.startsWith("/ws")) {
			socket.destroy();
			return;
		}
		wss.handleUpgrade(request, socket, head, (ws) => {
			wss.emit("connection", ws, request);
		});
	});

	const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		const url = new URL(request.url ?? "/", "http://localhost");
		const pathname = decodeURIComponent(url.pathname);

		if (pathname === "/api/plugins") {
			sendJson(response, 200, {
				version: options.version,
				plugins: options.plugins().map((plugin) => ({
					id: plugin.id,
					name: plugin.name,
					web: `/plugins/${plugin.id}/web.js`,
				})),
			});
			return;
		}

		if (pathname.startsWith("/plugins/")) {
			const [, , id, ...rest] = pathname.split("/");
			const asset = options.plugins().find((plugin) => plugin.id === id);
			if (!asset || rest.length === 0) {
				sendJson(response, 404, { error: "plugin not found" });
				return;
			}
			const base = resolve(asset.file, "..");
			const target = resolve(join(base, rest.join("/")));
			if (target !== base && !target.startsWith(`${base}${sep}`)) {
				sendJson(response, 403, { error: "forbidden" });
				return;
			}
			if (await sendFile(response, target, false)) return;
			sendJson(response, 404, { error: "not found" });
			return;
		}

		if (options.webDist) {
			const root = resolve(options.webDist);
			const candidate = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
			const target = resolve(join(root, candidate));
			if (target.startsWith(`${root}${sep}`) && (await sendFile(response, target, candidate.startsWith("assets/")))) return;
			if (await sendFile(response, join(root, "index.html"), false)) return;
		}

		sendJson(response, 404, { error: "not found" });
	};

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
