import type { IncomingMessage, ServerResponse } from "node:http";

/** Shared HTTP helpers for the platform's built-in JSON surfaces. */

/**
 * Moonan's origin policy, not a chord one.
 *
 * A browser sends `Origin`; a same-host origin is accepted, and so is an explicitly
 * configured one. No `Origin` means a non-browser client (tests, curl), which is allowed.
 * `Origin: null` and malformed values are refused. Reverse proxies that rewrite `Host` are
 * outside this check.
 */
export function sameOrigin(request: IncomingMessage, allowedOrigins: readonly string[]): boolean {
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

/** A browser-initiated cross-site request (`<img>`, `<form>`, a third-party frame). */
export function crossSite(request: IncomingMessage): boolean {
	return request.headers["sec-fetch-site"] === "cross-site";
}

export function sendJson(
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

export const MAX_JSON_BODY = 16 * 1024 * 1024;

export async function readJsonBody(
	request: IncomingMessage,
	limit = MAX_JSON_BODY,
): Promise<unknown> {
	let size = 0;
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.byteLength;
		if (size > limit) throw new Error("request body is too large");
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

/** Read one cookie from the request header. Duplicate names keep the first value. */
export function readCookie(request: IncomingMessage, name: string): string | undefined {
	const header = request.headers.cookie;
	if (header === undefined) return undefined;
	for (const part of header.split(";")) {
		const index = part.indexOf("=");
		if (index < 0) continue;
		if (part.slice(0, index).trim() !== name) continue;
		const value = part.slice(index + 1).trim();
		try {
			return decodeURIComponent(value);
		} catch {
			return value;
		}
	}
	return undefined;
}
