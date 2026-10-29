import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHost, webSocketLink, type Host } from "@earendil-works/chord";
import WebSocket from "ws";
import { start, type Moonan } from "../src/index.js";
import { silentLogger } from "../src/logger.js";

/**
 * Shared harness for the platform's integration tests.
 *
 * Fixtures live inside the workspace, not `tmpdir()`: a plugin resolves its bare imports
 * (`@moonan_ai/sdk`) from its own tree, exactly like a real directory plugin.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const apps: Moonan[] = [];
const dirs: string[] = [];

export interface AppOptions {
	readonly dataFile?: string;
	readonly dev?: boolean;
	readonly allowedOrigins?: readonly string[];
	readonly maxCalls?: number;
}

/** A directory under `packages/platform/`; removed by `cleanup()`. */
export async function tempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(root, "packages", "platform", prefix));
	dirs.push(dir);
	return dir;
}

/** A fresh temporary unified data file; removed by `cleanup()`. */
export async function tempDataFile(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "moonan-data-"));
	dirs.push(dir);
	return join(dir, "data.json");
}

/** A directory plugin whose server facet is `source`. */
export async function pluginDir(source: string): Promise<string> {
	const dir = await tempDir(".plugin-");
	await writeFile(join(dir, "server.mjs"), source);
	return dir;
}

/** Starts the platform on an ephemeral port; closed by `cleanup()`. */
export async function appFor(plugins: readonly string[], options: AppOptions = {}): Promise<Moonan> {
	const pluginsDir = await mkdtemp(join(tmpdir(), "moonan-plugins-"));
	dirs.push(pluginsDir);
	const dataFile = options.dataFile ?? (await tempDataFile());
	const app = await start({
		port: 0,
		hostname: "127.0.0.1",
		plugins: [...plugins],
		pluginsDir,
		dataFile,
		logger: silentLogger,
		...options,
	});
	apps.push(app);
	return app;
}

export function wsUrl(app: Moonan): string {
	return `${app.url.replace(/^http/, "ws")}/ws`;
}

export function waitOpen(socket: WebSocket): Promise<void> {
	return new Promise((resolve, reject) => {
		if (socket.readyState === WebSocket.OPEN) {
			resolve();
			return;
		}
		const timer = setTimeout(() => reject(new Error("websocket did not open")), 2_000);
		socket.once("open", () => {
			clearTimeout(timer);
			resolve();
		});
		socket.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

export async function connectClient(
	app: Moonan,
	origin?: string,
): Promise<{ socket: WebSocket; client: Host<unknown> }> {
	const socket = new WebSocket(wsUrl(app), origin === undefined ? undefined : { origin });
	const client = createHost({ kind: "client", self: { id: "browser" }, onError: () => {} });
	// Create the link before the socket opens, as chord's own WebSocket test does.
	client.connect(webSocketLink(socket as never), { principal: { id: "host" } });
	await waitOpen(socket);
	return { socket, client };
}

export async function closeClient(socket: WebSocket, client: Host<unknown>): Promise<void> {
	await client.close().catch(() => undefined);
	socket.terminate();
}

export function post(
	url: string,
	origin?: string,
): Promise<{ status: number; body: string; retryAfter: string | null }> {
	return new Promise((resolve, reject) => {
		const parsed = new URL(url);
		const request = httpRequest(
			{
				hostname: parsed.hostname,
				port: parsed.port,
				path: `${parsed.pathname}${parsed.search}`,
				method: "POST",
				headers: origin === undefined ? {} : { origin },
			},
			(response) => {
				let body = "";
				response.setEncoding("utf8");
				response.on("data", (chunk: string) => {
					body += chunk;
				});
				response.on("end", () => {
					const header = response.headers["retry-after"];
					resolve({
						status: response.statusCode ?? 0,
						body,
						retryAfter: Array.isArray(header) ? (header[0] ?? null) : (header ?? null),
					});
				});
			},
		);
		request.on("error", reject);
		request.end();
	});
}

/** Closes every app this worker started, then removes every directory it made. */
export async function cleanup(): Promise<void> {
	await Promise.all(apps.splice(0).map((app) => app.close().catch(() => undefined)));
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}
