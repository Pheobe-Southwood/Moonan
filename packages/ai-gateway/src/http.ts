import type { IncomingMessage, ServerResponse } from "node:http";
import {
	invalid,
	isChordError,
	type Ctx,
	type Ref,
	type RouteHandler,
} from "@moonan_ai/sdk";
import type { AiGateway } from "./contract.js";
import { errorMessage } from "./util.js";

const MAX_JSON_BODY = 1_000_000;

function sendJson(response: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"content-length": Buffer.byteLength(payload),
	});
	response.end(payload);
}

function sameOrigin(request: IncomingMessage): boolean {
	const origin = request.headers.origin;
	if (origin === undefined) return true;
	if (origin === "null") return false;
	const host = request.headers.host;
	if (!host) return false;
	try {
		const parsed = new URL(origin);
		return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host.toLowerCase() === host.toLowerCase();
	} catch {
		return false;
	}
}

async function readJson(request: IncomingMessage): Promise<unknown> {
	let size = 0;
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.byteLength;
		if (size > MAX_JSON_BODY) throw new Error("request body is too large");
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

function routeError(response: ServerResponse, status: number, error: unknown): void {
	sendJson(response, status, {
		error: errorMessage(error),
		// Keep the Chord code and reason on the wire: the panel distinguishes a user-fixable
		// configuration error from an upstream outage, and so does any other HTTP client.
		...(isChordError(error) ? { code: error.code, ...(error.reason ? { reason: error.reason } : {}) } : {}),
	});
}

/** Resolves the signed-in caller's own gateway object; a route never reaches another user's. */
export type GatewayResolver = (ctx: Ctx) => Promise<Ref<typeof AiGateway>>;

/**
 * The HTTP face of the same per-user object the browser uses. It is intentionally
 * read-mostly: all writes go through Chord, so the panel does not have two competing
 * mutation paths. The exceptions are discovery (a network probe with no persistence) and
 * reload-from-disk (an explicit recovery action), both of which are also available as
 * Chord methods.
 *
 * The routes are registered once by the host-lifetime admin object, but every request is
 * answered from the caller's own {@link AiGateway}: the resolver is handed the request's
 * `Ctx`, whose principal is the authenticated account the platform stamped on the root.
 */
export function gatewayRoutes(resolve: GatewayResolver): Record<string, RouteHandler> {
	return {
		"GET /api/ai-gateway/status": async (_request, response, ctx) => {
			const gateway = await resolve(ctx);
			const health = await gateway.health(ctx);
			sendJson(response, 200, { ...health, storage: gateway.snapshot.value.storage });
		},
		"GET /api/ai-gateway/health": async (_request, response, ctx) => {
			const gateway = await resolve(ctx);
			sendJson(response, 200, await gateway.health(ctx));
		},
		"GET /api/ai-gateway/config": async (_request, response, ctx) => {
			const gateway = await resolve(ctx);
			sendJson(response, 200, gateway.snapshot.value);
		},
		"GET /api/ai-gateway/providers": async (_request, response, ctx) => {
			const gateway = await resolve(ctx);
			sendJson(response, 200, { providers: gateway.snapshot.value.providers });
		},
		"GET /api/ai-gateway/presets": async (_request, response, ctx) => {
			const gateway = await resolve(ctx);
			sendJson(response, 200, { presets: gateway.snapshot.value.presets });
		},
		"GET /api/ai-gateway/models": async (request, response, ctx) => {
			const gateway = await resolve(ctx);
			const url = new URL(request.url ?? "/", "http://localhost");
			const providerId = url.searchParams.get("provider");
			const current = gateway.snapshot.value;
			if (providerId) {
				const provider = current.providers.find((candidate) => candidate.id === providerId);
				if (!provider) {
					sendJson(response, 404, { error: `unknown provider: ${providerId}` });
					return;
				}
				sendJson(response, 200, { providerId, models: provider.models });
				return;
			}
			sendJson(response, 200, {
				models: current.providers.flatMap((provider) =>
					provider.models.map((model) => ({ providerId: provider.id, providerName: provider.name, ...model })),
				),
			});
		},
		"POST /api/ai-gateway/discover": async (request, response, ctx) => {
			if (!sameOrigin(request)) {
				sendJson(response, 403, { error: "cross-origin request refused" });
				return;
			}
			try {
				let body: { providerId?: unknown } | undefined;
				try {
					body = (await readJson(request)) as { providerId?: unknown } | undefined;
				} catch (error) {
					// A malformed or oversized body is the caller's mistake, not a gateway failure.
					routeError(response, 400, invalid("args", errorMessage(error)));
					return;
				}
				const providerId = typeof body?.providerId === "string" ? body.providerId.trim() : "";
				if (!providerId) {
					sendJson(response, 400, { error: "providerId is required" });
					return;
				}
				const gateway = await resolve(ctx);
				sendJson(response, 200, await gateway.discoverModels({ id: providerId }, ctx));
			} catch (error) {
				// A user-fixable configuration error is a 400; a failed upstream is a gateway error.
				routeError(response, isChordError(error) && error.code === "invalid" ? 400 : 502, error);
			}
		},
		"POST /api/ai-gateway/reload": async (request, response, ctx) => {
			if (!sameOrigin(request)) {
				sendJson(response, 403, { error: "cross-origin request refused" });
				return;
			}
			try {
				const gateway = await resolve(ctx);
				sendJson(response, 200, await gateway.reloadFromDisk(ctx));
			} catch (error) {
				routeError(response, 400, error);
			}
		},
	};
}
