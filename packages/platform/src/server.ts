import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { acceptWebSockets, isChordError, type Host, type ReloadReport } from "@earendil-works/chord";
import {
	PLUGIN_ADMIN_API,
	Routes,
	type DataBundle,
	type DataImportReport,
	type DataStoreStorageInfo,
	type PluginAdminSnapshot,
} from "@moonan_ai/sdk";
import { WebSocketServer } from "ws";
import type { Logger } from "./logger.js";
import type { PluginMutationResult } from "./platform.js";
import {
	adminEntry,
	describe,
	errorMessage,
	PluginOperationError,
	webSignature,
	type PluginState,
	type Principal,
	type StartupReport,
} from "./types.js";

export interface WebServerData {
	status(): Promise<DataStoreStorageInfo>;
	export(options: { includeSecrets: boolean }): Promise<DataBundle>;
	import(bundle: unknown): Promise<DataImportReport>;
}

/**
 * The platform's plugin-management operations. They are handed to the HTTP layer directly
 * (never wrapped in a Chord remote object): changing the plugin set commits a chord reload,
 * and a reload waits for roots (gate/retire deadlines) and aborts the root that is driving
 * it, so management runs outside any root on the plain HTTP path.
 */
export interface WebServerAdmin {
	setEnabled(ref: string, enabled: boolean): Promise<PluginMutationResult>;
	add(ref: string, options?: { enabled?: boolean }): Promise<PluginMutationResult>;
	remove(ref: string): Promise<PluginMutationResult>;
}

export interface WebServerOptions {
	host: Host<Principal>;
	port: number;
	hostname: string;
	version: string;
	/** Absent when the shell has not been built: the API and the WebSocket still work. */
	webDist?: string;
	plugins: () => PluginState[];
	/** chord's code version: what a browser and an external tool compare to know a commit landed. */
	revision: () => number;
	reload: () => Promise<ReloadReport | undefined>;
	/** Plugin management, served on `/api/v1/plugins*`. */
	admin: WebServerAdmin;
	/** Loopback only unless the operator passed `--allow-management`. */
	managementEnabled: boolean;
	pluginsFile: string;
	pluginsDir: string;
	dataFile: string;
	cwd: string;
	/** A recovery notice from the plugin registry file, read per request (a save clears it). */
	registryWarning?: () => string | undefined;
	/** Set when the degraded startup fallback left entries out of this process. */
	startup?: StartupReport;
	/** The platform's unified data surface. */
	data: WebServerData;
	/**
	 * Extra browser origins accepted in addition to same-origin, matched exactly against the
	 * `Origin` header (`http://host:port`). This is Moonan policy, not a chord concept.
	 */
	allowedOrigins?: readonly string[];
	/** chord's per-link concurrent call limit. Default: chord's default (no limit). */
	maxCalls?: number;
	logger: Logger;
}

export interface WebServerHandle {
	server: Server;
	port: number;
	url: string;
	close: () => Promise<void>;
}

/** One retry for an idempotent request that chord marked retryable (`upgrade_conflict`, `superseded`). */
const RETRY_LIMIT = 1;
const RETRY_DELAY_MS = 10;

/**
 * Moonan's origin policy, not a chord one.
 *
 * A browser sends `Origin`; a same-host origin is accepted, and so is an explicitly
 * configured one. No `Origin` means a non-browser client (tests, curl), which is allowed —
 * chord's own WebSocket test connects that way. `Origin: null` and malformed values are
 * refused. Reverse proxies that rewrite `Host` are outside this check.
 */
function sameOrigin(request: IncomingMessage, allowedOrigins: readonly string[]): boolean {
	const origin = request.headers.origin;
	if (origin === undefined) return true;
	if (origin === "null") return false;
	if (allowedOrigins.includes(origin)) return true;

	let parsed: URL;
	try {
		parsed = new URL(origin);
	} catch {
		return false;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
	const host = request.headers.host;
	if (host === undefined) return false;
	return parsed.host.toLowerCase() === host.toLowerCase();
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
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

function sendJson(
	response: ServerResponse,
	status: number,
	body: unknown,
	headers: Record<string, string> = {},
): void {
	const payload = JSON.stringify(body);
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"content-length": Buffer.byteLength(payload),
		...headers,
	});
	response.end(payload);
}

const MAX_DATA_BODY = 16 * 1024 * 1024;

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
	let size = 0;
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.byteLength;
		if (size > MAX_DATA_BODY) throw new Error("request body is too large");
		chunks.push(buffer);
	}
	if (chunks.length === 0) return undefined;
	const text = Buffer.concat(chunks).toString("utf8");
	try {
		return JSON.parse(text);
	} catch {
		throw new Error("request body is not valid JSON");
	}
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

/** A path inside `base` or nothing: `..` in a facet asset URL must not escape the facet. */
function within(base: string, relative: string): string | undefined {
	const target = resolve(join(base, relative));
	return target === base || target.startsWith(`${base}${sep}`) ? target : undefined;
}

/**
 * One port for everything: the WebSocket the Chord client speaks, the browser facets the
 * shell imports, the routes plugins registered, and the shell.
 */
export async function startWebServer(options: WebServerOptions): Promise<WebServerHandle> {
	const wss = new WebSocketServer({ noServer: true });
	const allowedOrigins = options.allowedOrigins ?? [];
	acceptWebSockets(wss, options.host, {
		// No authentication by design (README): every connection acts as the same principal, so
		// all browsers share one instance of every remote type they hold. The authenticator is
		// still chord's official refusal point, so a cross-origin page is turned away there.
		principal: (request) => {
			if (!sameOrigin(request, allowedOrigins)) {
				options.logger.warn(`refused a websocket from origin ${request.headers.origin ?? "(null)"}`);
				return undefined;
			}
			return { id: "browser" };
		},
		...(options.maxCalls === undefined ? {} : { maxCalls: options.maxCalls }),
		// chord closes a link whose peer announced another protocol version, and the peer closes
		// too after reloading its page. Log it here, or a stale tab disappears without a trace.
		onProtocolMismatch: ({ local, peer }) =>
			options.logger.warn(`a client speaks protocol ${peer ?? "(none)"} while this server speaks ${local}: it has to reload`),
	});

	const plugins = options.plugins;
	/** Disabled and startup-skipped plugins are not served and not published to the browser. */
	const activePlugins = (): PluginState[] => plugins().filter((plugin) => plugin.enabled && !plugin.startupSkipped);

	const serveFacetAsset = async (pathname: string, response: ServerResponse): Promise<boolean> => {
		const facet = activePlugins().find((candidate) => candidate.web && pathname.startsWith(candidate.web.base));
		if (!facet?.web) {
			sendJson(response, 404, { error: "facet not found" });
			return true;
		}
		const relative = pathname.slice(facet.web.base.length);
		if (!relative) {
			sendJson(response, 404, { error: "not found" });
			return true;
		}
		const target = within(resolve(facet.web.file, ".."), relative);
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

	/** The plugin-management snapshot. Built per request so it always shows a landed commit. */
	const snapshot = (): PluginAdminSnapshot => {
		const warning = options.registryWarning?.();
		return {
			api: PLUGIN_ADMIN_API,
			version: options.version,
			revision: options.revision(),
			management: options.managementEnabled,
			...(warning === undefined ? {} : { warning }),
			...(options.startup ? { startup: options.startup } : {}),
			paths: {
				cwd: options.cwd,
				pluginsFile: options.pluginsFile,
				dataFile: options.dataFile,
				pluginsDir: options.pluginsDir,
			},
			plugins: plugins().map(adminEntry),
		};
	};

	/**
	 * The management endpoints change the running process, so they are refused when they are
	 * disabled (non-loopback bind), cross-origin, or embedded cross-site. This is Moonan
	 * policy: there is no account authentication to fall back on.
	 */
	const guardManagement = (request: IncomingMessage, response: ServerResponse): boolean => {
		if (!options.managementEnabled) {
			sendJson(response, 403, {
				error:
					"plugin management is disabled: it is limited to a loopback bind unless --allow-management is set",
				code: "management_disabled",
			});
			return true;
		}
		if (!sameOrigin(request, allowedOrigins)) {
			sendJson(response, 403, { error: "forbidden" });
			return true;
		}
		if (request.headers["sec-fetch-site"] === "cross-site") {
			sendJson(response, 403, { error: "cross-site request refused", code: "forbidden" });
			return true;
		}
		return false;
	};

	const readAdminBody = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
		let body: unknown;
		try {
			body = await readJsonBody(request);
		} catch (error) {
			throw new PluginOperationError("invalid_body", errorMessage(error), 400);
		}
		if (typeof body !== "object" || body === null || Array.isArray(body)) {
			throw new PluginOperationError("invalid_body", "request body must be a JSON object", 400);
		}
		return body as Record<string, unknown>;
	};

	const stringField = (body: Record<string, unknown>, key: string): string => {
		const value = body[key];
		if (typeof value !== "string" || value.trim().length === 0) {
			throw new PluginOperationError("invalid_body", `"${key}" must be a non-empty string`, 400);
		}
		return value;
	};

	const sendMutation = (response: ServerResponse, result: PluginMutationResult): void => {
		sendJson(response, 200, {
			ok: true,
			changed: result.changed,
			reloadBrowser: result.reloadBrowser,
			revision: options.revision(),
			...(result.plugin ? { plugin: adminEntry(result.plugin) } : {}),
		});
	};

	const sendOperationError = (response: ServerResponse, error: unknown): void => {
		if (error instanceof PluginOperationError) {
			sendJson(response, error.status, {
				error: error.message,
				code: error.code,
				...(error.details.chordCode ? { chordCode: error.details.chordCode } : {}),
				...(error.details.reason ? { reason: error.details.reason } : {}),
				...(error.details.committed ? { committed: true } : {}),
				...(error.details.plugin ? { plugin: error.details.plugin } : {}),
			});
			return;
		}
		if (isChordError(error)) {
			sendJson(response, 400, {
				error: error.message,
				code: error.code,
				...(error.reason ? { reason: error.reason } : {}),
			});
			return;
		}
		options.logger.error("plugin operation failed", error);
		sendJson(response, 500, { error: errorMessage(error) });
	};

	const runAdmin = async (
		request: IncomingMessage,
		response: ServerResponse,
		action: (body: Record<string, unknown>) => Promise<PluginMutationResult>,
	): Promise<void> => {
		if (guardManagement(request, response)) return;
		try {
			const body = await readAdminBody(request);
			sendMutation(response, await action(body));
		} catch (error) {
			sendOperationError(response, error);
		}
	};

	const runReload = async (response: ServerResponse): Promise<void> => {
		const beforeWeb = webSignature(activePlugins());
		try {
			const report = await options.reload();
			// `reloadBrowser` means "the browser facet set or its code changed", not "the
			// server committed". A web file's content hash is the signal; a server-only
			// change leaves it untouched. A browser that is not a cluster participant
			// learns this through `WebFacetCatalog` and swaps its own facets with `host.reload`.
			const afterWeb = webSignature(activePlugins());
			sendJson(response, 200, {
				ok: true,
				// A manual reload always commits (the code version advances) but need not change
				// any facet code. Chord reports the types a batch touched by name; a re-listing
				// of every current facet makes all of its types report as changed.
				changed: report !== undefined && (report.changed.length > 0 || report.removed.length > 0),
				reloadBrowser: afterWeb !== beforeWeb,
				revision: options.revision(),
				...(report ? { report } : {}),
			});
		} catch (error) {
			if (error instanceof PluginOperationError) {
				sendOperationError(response, error);
				return;
			}
			options.logger.error("facet reload failed", error);
			sendJson(response, 400, {
				error: errorMessage(error),
				...(isChordError(error)
					? { code: error.code, ...(error.reason ? { reason: error.reason } : {}) }
					: {}),
			});
		}
	};

	const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		const url = new URL(request.url ?? "/", "http://localhost");
		const pathname = decodeURIComponent(url.pathname);
		const method = request.method ?? "GET";

		if (pathname === "/api/data/status") {
			if (method !== "GET") {
				sendJson(response, 405, { error: "method not allowed" });
				return;
			}
			if (!sameOrigin(request, allowedOrigins)) {
				sendJson(response, 403, { error: "forbidden" });
				return;
			}
			try {
				sendJson(response, 200, await options.data.status());
			} catch (error) {
				sendJson(response, 500, { error: errorMessage(error) });
			}
			return;
		}

		if (pathname === "/api/data/export") {
			if (method !== "GET") {
				sendJson(response, 405, { error: "method not allowed" });
				return;
			}
			if (!sameOrigin(request, allowedOrigins)) {
				sendJson(response, 403, { error: "forbidden" });
				return;
			}
			try {
				const includeSecrets = url.searchParams.get("includeSecrets") === "1";
				const bundle = await options.data.export({ includeSecrets });
				sendJson(response, 200, bundle, {
					"content-disposition": `attachment; filename="moonan-data-${Date.now()}.json"`,
					...(includeSecrets ? { "x-moonan-secrets": "included" } : {}),
				});
			} catch (error) {
				sendJson(response, 500, { error: errorMessage(error) });
			}
			return;
		}

		if (pathname === "/api/data/import") {
			if (method !== "POST") {
				sendJson(response, 405, { error: "method not allowed" });
				return;
			}
			if (!sameOrigin(request, allowedOrigins)) {
				sendJson(response, 403, { error: "forbidden" });
				return;
			}
			try {
				const bundle = await readJsonBody(request);
				sendJson(response, 200, await options.data.import(bundle));
			} catch (error) {
				sendJson(response, 400, {
					error: errorMessage(error),
					...(isChordError(error)
						? { code: error.code, ...(error.reason ? { reason: error.reason } : {}) }
						: {}),
				});
			}
			return;
		}

		if (pathname === "/api/plugins") {
			// Deliberately ungated: the read-only diagnostic, and the plugin-manager's fallback
			// when management is disabled (packages/plugin-manager/src/web/app.tsx).
			sendJson(response, 200, {
				version: options.version,
				revision: options.revision(),
				// Runtime-loaded browser facets are Moonan's own extension: chord ships no
				// browser loader, so the shape of this response is not a stable protocol yet.
				experimental: true,
				plugins: plugins().map((plugin) => ({
					...describe(plugin),
					enabled: plugin.enabled,
					builtin: plugin.builtin,
					locked: plugin.locked,
					ephemeral: plugin.ephemeral,
					startupSkipped: plugin.startupSkipped,
				})),
			});
			return;
		}

		if (pathname === "/api/plugins/reload") {
			if (method !== "POST") {
				sendJson(response, 405, { error: "method not allowed" });
				return;
			}
			// The legacy spelling of the management reload: same policy as
			// `/api/v1/plugins/reload`, so a non-loopback bind without `--allow-management`
			// cannot drive a reload through this path.
			if (guardManagement(request, response)) return;
			await runReload(response);
			return;
		}

		if (pathname === "/api/v1/plugins") {
			if (method !== "GET") {
				sendJson(response, 405, { error: "method not allowed" });
				return;
			}
			if (guardManagement(request, response)) return;
			sendJson(response, 200, snapshot());
			return;
		}

		if (pathname === "/api/v1/plugins/reload") {
			if (method !== "POST") {
				sendJson(response, 405, { error: "method not allowed" });
				return;
			}
			if (guardManagement(request, response)) return;
			await runReload(response);
			return;
		}

		if (pathname === "/api/v1/plugins/enable") {
			if (method !== "POST") {
				sendJson(response, 405, { error: "method not allowed" });
				return;
			}
			await runAdmin(request, response, (body) => options.admin.setEnabled(stringField(body, "id"), true));
			return;
		}

		if (pathname === "/api/v1/plugins/disable") {
			if (method !== "POST") {
				sendJson(response, 405, { error: "method not allowed" });
				return;
			}
			await runAdmin(request, response, (body) => options.admin.setEnabled(stringField(body, "id"), false));
			return;
		}

		if (pathname === "/api/v1/plugins/install") {
			if (method !== "POST") {
				sendJson(response, 405, { error: "method not allowed" });
				return;
			}
			await runAdmin(request, response, (body) =>
				options.admin.add(stringField(body, "ref"), { enabled: body.enable !== false }),
			);
			return;
		}

		if (pathname === "/api/v1/plugins/remove") {
			if (method !== "POST") {
				sendJson(response, 405, { error: "method not allowed" });
				return;
			}
			await runAdmin(request, response, (body) => options.admin.remove(stringField(body, "id")));
			return;
		}

		if (pathname.startsWith("/facets/")) {
			if (await serveFacetAsset(pathname, response)) return;
		}

		// Plugin HTTP routes, resolved against the code version this root runs on. The root
		// follows the response's lifetime: a client that disconnects aborts `ctx.signal`, so
		// a plugin's nested calls stop instead of running for a response nobody will read.
		const controller = new AbortController();
		const abortOnClose = () => {
			if (!response.writableEnded) controller.abort();
		};
		response.on("close", abortOnClose);
		try {
			const idempotent = method === "GET" || method === "HEAD";
			let handled = false;
			for (let attempt = 0; ; attempt += 1) {
				try {
					handled = await options.host.root(
						async (ctx) => {
							const view = options.host.registry(Routes);
							const handler = view.get(`${method} ${pathname}`, ctx) ?? view.get(pathname, ctx);
							if (!handler) return false;
							// A browser-initiated request from another site (`<img>`, `<form>`, a
							// third-party frame) must not drive a plugin route, including side-effectful
							// GETs. Browsers send `Sec-Fetch-Site`; non-browser clients (curl, tests,
							// other services) do not. An origin the operator explicitly allowed keeps
							// the same trust it has on the built-in endpoints; a cross-site embed has
							// no Origin header and is always refused.
							if (request.headers["sec-fetch-site"] === "cross-site") {
								const origin = request.headers.origin;
								const explicitlyAllowed = origin !== undefined && sameOrigin(request, allowedOrigins);
								if (!explicitlyAllowed) {
									sendJson(response, 403, { error: "cross-site request refused" });
									return true;
								}
							}
							await handler(request, response, ctx);
							return true;
						},
						{ signal: controller.signal },
					);
					break;
				} catch (error) {
					// chord marks upgrade_conflict and superseded retryable: the official recovery is
					// to start a new root. A retry is only safe when nothing reached the response and
					// the request is idempotent; otherwise the client gets a retryable 503.
					if (isChordError(error) && error.retryable) {
						const retry =
							idempotent &&
							attempt < RETRY_LIMIT &&
							!response.headersSent &&
							!response.writableEnded &&
							!controller.signal.aborted;
						if (retry) {
							options.logger.warn(
								`route ${method} ${pathname} hit ${error.code}${error.reason ? `/${error.reason}` : ""}; retrying as a new root`,
							);
							await delay(RETRY_DELAY_MS);
							continue;
						}
						if (!response.headersSent && !response.writableEnded && !controller.signal.aborted) {
							// Application policy, not a chord rule: a handler may already have had side
							// effects, so a non-idempotent request is not replayed for the client.
							response.setHeader("retry-after", "1");
							sendJson(response, 503, {
								error: errorMessage(error),
								code: error.code,
								...(error.reason ? { reason: error.reason } : {}),
								retryable: true,
							});
							return;
						}
					}
					throw error;
				}
			}
			if (handled) return;
		} catch (error) {
			// A disconnect is not a server error: the root was aborted on purpose.
			if (controller.signal.aborted) return;
			options.logger.error(`route ${method} ${pathname} failed`, error);
			if (!response.headersSent) {
				sendJson(response, 500, {
					error: "internal error",
					...(isChordError(error)
						? { code: error.code, ...(error.reason ? { reason: error.reason } : {}) }
						: {}),
				});
			} else response.end();
			return;
		} finally {
			response.off("close", abortOnClose);
		}

		// `/api/*` is the platform's own JSON surface. An unknown path is a 404, never the
		// SPA shell with a misleading 200.
		if (pathname === "/api" || pathname.startsWith("/api/")) {
			sendJson(response, 404, { error: "not found" });
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
			await new Promise<void>((resolveClose) => {
				server.close(() => resolveClose());
				// HTTP keep-alive connections from the shell/API can otherwise keep `close()`
				// waiting for their idle timeout after the listener is gone.
				server.closeIdleConnections();
			});
		},
	};
}
