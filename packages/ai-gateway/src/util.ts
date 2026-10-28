/** Small helpers shared by the gateway's server modules. */

export function nowIso(): string {
	return new Date().toISOString();
}

export function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

/**
 * A provider id ends up in URLs, logs and Chord addresses, so keep it to a portable
 * slug. Display names are free-form.
 */
export function isValidProviderId(id: string): boolean {
	return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id);
}

/** A privacy-preserving hint for an API key; never the key itself. */
export function keyHint(key: string | undefined): string | undefined {
	if (!key) return undefined;
	const trimmed = key.trim();
	if (trimmed.length === 0) return undefined;
	if (trimmed.length <= 8) return "••••";
	return `•••• ${trimmed.slice(-4)}`;
}

/** Deep clone through JSON so no undefined values or shared containers cross a boundary. */
export function cloneJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

export function normalizeBaseUrl(value: string): string {
	return value.trim().replace(/\/+$/, "");
}

export function isLocalEndpoint(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			url.hostname === "localhost" ||
			url.hostname === "127.0.0.1" ||
			url.hostname === "::1" ||
			url.hostname === "0.0.0.0" ||
			url.hostname.endsWith(".local")
		);
	} catch {
		return false;
	}
}

/** `openai/gpt-5` -> `openai-gpt-5`, used only for display suggestions. */
export function displayNameFromId(id: string): string {
	return id
		.replace(/^models\//, "")
		.replace(/[._/]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function normalizeHeaders(
	headers: Record<string, string | null> | undefined,
	authHeaders: Record<string, string | null> | undefined,
): Record<string, string> {
	// Provider headers are the user's explicit override; an auth header is the fallback.
	const merged: Record<string, string> = {};
	for (const [key, value] of Object.entries(authHeaders ?? {})) {
		if (value !== null) merged[key] = value;
	}
	for (const [key, value] of Object.entries(headers ?? {})) {
		if (value === null) delete merged[key];
		else merged[key] = value;
	}
	return merged;
}

/** The key as it appears in a redacted URL or log line. */
export function sanitizeEndpoint(url: string): string {
	try {
		const parsed = new URL(url);
		for (const name of ["key", "api_key", "api-key", "token"]) {
			if (parsed.searchParams.has(name)) parsed.searchParams.set(name, "••••");
		}
		return parsed.toString();
	} catch {
		return url.replace(/([?&](?:key|api_key|api-key|token)=)[^&]+/gi, "$1••••");
	}
}
