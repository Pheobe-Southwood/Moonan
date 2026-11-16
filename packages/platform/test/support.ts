import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHost, webSocketLink, type Host } from "@earendil-works/chord";
import type { MoonanPrincipal } from "@moonan_ai/sdk";
import WebSocket from "ws";
import { start, type Moonan, type OfficialPluginRef } from "../src/index.js";
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
/** Admin session cookies by app origin, used by the test-only fetch interceptor below. */
const cookies = new Map<string, string>();
const realFetch = globalThis.fetch.bind(globalThis);

/**
 * The integration suite is about platform behavior, not about re-implementing cookie
 * plumbing in every call site. `appFor` creates the first administrator and installs its
 * session cookie for that app origin; tests that exercise an unauthenticated path use
 * `rawFetch`/`request(..., { cookie: null })`.
 */
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
	const url =
		typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	const cookie = cookies.get(new URL(url).origin);
	const headers = new Headers(init?.headers);
	if (cookie !== undefined && !headers.has("cookie")) headers.set("cookie", cookie);
	return realFetch(input as never, { ...init, headers });
}) as typeof fetch;

function cookieFrom(setCookie: string | null): string | undefined {
	if (setCookie === null) return undefined;
	const first = setCookie.split(";")[0]?.trim();
	return first && first.includes("=") ? first : undefined;
}

/** The raw fetch, without the test session cookie interceptor. */
export const rawFetch = realFetch;

export interface AppOptions {
	readonly dataDb?: string;
	readonly pluginsFile?: string;
	readonly hostname?: string;
	readonly official?: boolean | readonly OfficialPluginRef[];
	readonly safeMode?: boolean;
	readonly authDb?: string;
	/** Default true: create the first administrator and install its cookie for this origin. */
	readonly bootstrapAdmin?: boolean;
	readonly secureCookies?: boolean;
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

/** A fresh temporary unified data database; removed by `cleanup()`. */
export async function tempDataDb(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "moonan-data-db-"));
	dirs.push(dir);
	return join(dir, "data.db");
}

/** A fresh temporary account database; removed by `cleanup()`. */
export async function tempAuthDb(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "moonan-auth-db-"));
	dirs.push(dir);
	return join(dir, "auth.db");
}

/** A fresh temporary plugin registry; removed by `cleanup()`. */
export async function tempPluginsFile(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "moonan-plugins-file-"));
	dirs.push(dir);
	return join(dir, "plugins.json");
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
	const dataDb = options.dataDb ?? (await tempDataDb());
	const authDb = options.authDb ?? (await tempAuthDb());
	const pluginsFile = options.pluginsFile ?? (await tempPluginsFile());
	const app = await start({
		port: 0,
		hostname: "127.0.0.1",
		plugins: [...plugins],
		pluginsDir,
		dataDb,
		authDb,
		pluginsFile,
		// Tests must never read the developer's real registry, and the official plugins would
		// add a second, unrelated facet batch to every harness app.
		official: false,
		logger: silentLogger,
		...options,
	});
	apps.push(app);
	if (options.bootstrapAdmin !== false) await setupAdmin(app);
	return app;
}

/** The session cookie for an app, if its administrator was bootstrapped. */
export function cookieFor(app: Moonan): string | undefined {
	return cookies.get(new URL(app.url).origin);
}

async function setupAdmin(app: Moonan, username = "admin", password = "moonan-test-password"): Promise<void> {
	const response = await realFetch(`${app.url}/api/auth/setup`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ username, password }),
	});
	if (response.status !== 200) {
		throw new Error(`admin setup failed: ${response.status} ${await response.text()}`);
	}
	const cookie = cookieFrom(response.headers.get("set-cookie"));
	if (cookie === undefined) throw new Error("admin setup did not set a session cookie");
	cookies.set(new URL(app.url).origin, cookie);
}

/** Create an additional account through the administrator API; returns its public record. */
export async function createUser(
	app: Moonan,
	input: { username: string; password?: string; role?: "admin" | "user" },
): Promise<{ id: string; username: string; role: "admin" | "user" }> {
	const cookie = cookieFor(app);
	if (cookie === undefined) throw new Error("app has no administrator session");
	const response = await realFetch(`${app.url}/api/v1/users/create`, {
		method: "POST",
		headers: { "content-type": "application/json", cookie },
		body: JSON.stringify({
			username: input.username,
			password: input.password ?? "moonan-test-password",
			role: input.role ?? "user",
		}),
	});
	const body = (await response.json()) as { user?: { id: string; username: string; role: "admin" | "user" }; error?: string };
	if (response.status !== 200 || body.user === undefined) {
		throw new Error(`createUser failed: ${response.status} ${body.error ?? ""}`);
	}
	return body.user;
}

/** Log in as another account; returns its cookie without changing the app's default session. */
export async function loginAs(app: Moonan, username: string, password = "moonan-test-password"): Promise<string> {
	const response = await realFetch(`${app.url}/api/auth/login`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ username, password }),
	});
	if (response.status !== 200) throw new Error(`login failed: ${response.status} ${await response.text()}`);
	const cookie = cookieFrom(response.headers.get("set-cookie"));
	if (cookie === undefined) throw new Error("login did not set a session cookie");
	return cookie;
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
	options: { cookie?: string | null } = {},
): Promise<{ socket: WebSocket; client: Host<unknown> }> {
	const cookie = options.cookie === null ? undefined : (options.cookie ?? cookieFor(app));
	const socket = new WebSocket(wsUrl(app), {
		...(origin === undefined ? {} : { origin }),
		...(cookie === undefined ? {} : { headers: { cookie } }),
	});
	const client = createHost<MoonanPrincipal>({
		kind: "client",
		self: { kind: "browser" },
		onError: () => {},
	});
	// Create the link before the socket opens, as chord's own WebSocket test does.
	client.connect(webSocketLink(socket as never), { principal: { kind: "host" } });
	await waitOpen(socket);
	return { socket, client: client as unknown as Host<unknown> };
}

export async function closeClient(socket: WebSocket, client: Host<unknown>): Promise<void> {
	await client.close().catch(() => undefined);
	socket.terminate();
}

export interface TestResponse {
	status: number;
	body: string;
	retryAfter: string | null;
}

/** One raw HTTP request; headers are sent verbatim, which `fetch` refuses for `Sec-*`. */
export function request(
	url: string,
	options: {
		method?: string;
		headers?: Record<string, string>;
		body?: string;
		/** Defaults to the bootstrapped cookie for this URL; `null` sends no cookie. */
		cookie?: string | null;
	} = {},
): Promise<TestResponse> {
	const cookie = options.cookie === null ? undefined : (options.cookie ?? cookies.get(new URL(url).origin));
	const headers: Record<string, string> = { ...(options.headers ?? {}) };
	if (cookie !== undefined && headers.cookie === undefined) headers.cookie = cookie;
	return new Promise((resolve, reject) => {
		const parsed = new URL(url);
		const req = httpRequest(
			{
				hostname: parsed.hostname,
				port: parsed.port,
				path: `${parsed.pathname}${parsed.search}`,
				method: options.method ?? "GET",
				headers,
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
		req.on("error", reject);
		if (options.body !== undefined) req.write(options.body);
		req.end();
	});
}

export function post(url: string, origin?: string): Promise<TestResponse> {
	return request(url, { method: "POST", ...(origin === undefined ? {} : { headers: { origin } }) });
}

/** Closes every app this worker started, then removes every directory it made. */
export async function cleanup(): Promise<void> {
	await Promise.all(apps.splice(0).map((app) => app.close().catch(() => undefined)));
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}
