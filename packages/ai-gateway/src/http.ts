import type { IncomingMessage, ServerResponse } from "node:http";
import { invalid, isChordError, type RouteHandler } from "@moonan_ai/sdk";
import type { GatewayService } from "./service.js";
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

/**
 * The HTTP face of the same service the browser uses. It is intentionally read-mostly:
 * all writes go through Chord, so the panel does not have two competing mutation paths.
 * The exceptions are discovery (a network probe with no persistence) and reload-from-disk
 * (an explicit recovery action), both of which are also available as Chord methods.
 */
export function gatewayRoutes(getService: () => GatewayService): Record<string, RouteHandler> {
	const snapshot = () => getService().snapshot();

	return {
		"GET /api/ai-gateway/status": (_request, response) => {
			sendJson(response, 200, {
				...getService().health(),
				storage: getService().storageInfo(),
			});
		},
		"GET /api/ai-gateway/health": (_request, response) => {
			sendJson(response, 200, getService().health());
		},
		"GET /api/ai-gateway/config": (_request, response) => {
			sendJson(response, 200, snapshot());
		},
		"GET /api/ai-gateway/providers": (_request, response) => {
			sendJson(response, 200, { providers: snapshot().providers });
		},
		"GET /api/ai-gateway/presets": (_request, response) => {
			sendJson(response, 200, { presets: snapshot().presets });
		},
		"GET /api/ai-gateway/models": (request, response) => {
			const url = new URL(request.url ?? "/", "http://localhost");
			const providerId = url.searchParams.get("provider");
			const current = snapshot();
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
				const result = await getService().discover(providerId, ctx);
				sendJson(response, 200, result);
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
				sendJson(response, 200, await getService().reloadFromDisk(ctx));
			} catch (error) {
				routeError(response, 400, error);
			}
		},
	};
}
