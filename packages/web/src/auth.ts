import type { MoonanUser } from "@moonan_ai/sdk";

/**
 * The browser's account client.
 *
 * The platform's session is an HttpOnly cookie: no token ever reaches this code, and the
 * shell must not keep identity anywhere else (no localStorage/sessionStorage/IndexedDB).
 * Every call therefore asks the server, which is the only source of truth for "who am I".
 */

/** The public, secret-free identity of a signed-in account. */
export type AuthUser = MoonanUser;

/** What `GET /api/auth/status` reports. */
export interface AuthStatus {
	/** The platform build, so the login page can name what it is talking to. */
	readonly version: string;
	/** True while the account table is empty: the shell shows the first-administrator setup page. */
	readonly setupRequired: boolean;
	readonly authenticated: boolean;
	/** Present only when `authenticated`. */
	readonly user?: AuthUser;
}

/** The platform's JSON error shape for the account endpoints. */
export interface AuthErrorBody {
	readonly error: string;
	readonly code?: string;
	readonly retryAfter?: number;
}

/** A refused or failed account request. `status` 0 means the request never reached the server. */
export class AuthRequestError extends Error {
	readonly status: number;
	readonly code: string | undefined;
	/** Seconds until a rate-limited login may be retried. */
	readonly retryAfter: number | undefined;

	constructor(status: number, code: string | undefined, message: string, retryAfter?: number) {
		super(message);
		this.name = "AuthRequestError";
		this.status = status;
		this.code = code;
		this.retryAfter = retryAfter;
	}
}

interface AuthSessionBody {
	readonly user: AuthUser;
}

interface AuthOkBody {
	readonly ok: boolean;
	readonly reauthenticate?: boolean;
}

function isAuthErrorBody(value: unknown): value is AuthErrorBody {
	if (typeof value !== "object" || value === null) return false;
	const body = value as Partial<AuthErrorBody> & Record<string, unknown>;
	if (typeof body.error !== "string") return false;
	if (body.code !== undefined && typeof body.code !== "string") return false;
	if (body.retryAfter !== undefined && typeof body.retryAfter !== "number") return false;
	return true;
}

async function readJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		// A proxy or a bare HTTP error may answer with no (or non-JSON) body; the status stands.
		return undefined;
	}
}

async function request<T>(path: string, body?: unknown): Promise<T> {
	const headers: Record<string, string> = { accept: "application/json" };
	const init: RequestInit = { credentials: "same-origin", headers };
	if (body !== undefined) {
		init.method = "POST";
		headers["content-type"] = "application/json";
		init.body = JSON.stringify(body);
	}

	let response: Response;
	try {
		response = await fetch(path, init);
	} catch {
		throw new AuthRequestError(0, "network", "无法连接 Moonan 服务，请稍后重试");
	}

	const payload = await readJson(response);
	if (!response.ok) {
		if (isAuthErrorBody(payload)) {
			throw new AuthRequestError(response.status, payload.code, payload.error, payload.retryAfter);
		}
		throw new AuthRequestError(response.status, undefined, `请求失败（HTTP ${response.status}）`);
	}
	return payload as T;
}

/** Reads the current session. The only call the shell makes before deciding what to mount. */
export function fetchAuthStatus(): Promise<AuthStatus> {
	return request<AuthStatus>("/api/auth/status");
}

/** Verifies credentials and starts a session; the cookie is set by the response. */
export async function login(username: string, password: string): Promise<AuthUser> {
	const body = await request<AuthSessionBody>("/api/auth/login", { username, password });
	return body.user;
}

/** Creates the first administrator. Only accepted while the account table is empty. */
export async function setup(username: string, password: string): Promise<AuthUser> {
	const body = await request<AuthSessionBody>("/api/auth/setup", { username, password });
	return body.user;
}

/** Ends this session. The server also revokes the Chord objects and closes the links. */
export async function logout(): Promise<void> {
	await request<AuthOkBody>("/api/auth/logout", {});
}

/**
 * Changes one's own password after proving the current one. The server clears the cookie
 * and deletes every session of the account, so the shell must return to login.
 */
export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
	await request<AuthOkBody>("/api/auth/password", { currentPassword, newPassword });
}

/** A human-readable message for anything thrown by this module or a form handler. */
export function authErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}
