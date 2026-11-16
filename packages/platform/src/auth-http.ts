import type { IncomingMessage, ServerResponse } from "node:http";
import type { UserAdminUser, UserPrincipal } from "@moonan_ai/sdk";
import {
	AUTH_COOKIE_NAME,
	AuthError,
	principalFor,
	type AuthStore,
} from "./auth-store.js";
import { crossSite, readCookie, readJsonBody, sameOrigin, sendJson } from "./http-util.js";
import type { Logger } from "./logger.js";

/** The public half of `/api/auth/status`. */
export interface AuthStatus {
	readonly version: string;
	readonly setupRequired: boolean;
	readonly authenticated: boolean;
	readonly user?: {
		readonly id: string;
		readonly username: string;
		readonly role: "admin" | "user";
	};
}

/** What a successful login/setup hands back before the HTTP layer writes the cookie. */
export interface AuthSessionResult {
	readonly user: UserAdminUser;
	readonly token: string;
	readonly expiresAt: string;
}

export interface AuthServiceOptions {
	readonly store: AuthStore;
	readonly version: string;
	readonly secureCookies?: boolean;
	readonly logger: Logger;
}

interface LoginFailure {
	count: number;
	resetAt: number;
}

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const RATE_LIMIT_CAP = 1024;

/**
 * The account service behind the HTTP and WebSocket authentication points.
 *
 * It owns the cookie/session handshake and a small in-memory login rate limiter. The
 * database operations stay in `AuthStore`; Chord principal stamping is `principalFor`.
 */
export class AuthService {
	private readonly failures = new Map<string, LoginFailure>();

	constructor(private readonly options: AuthServiceOptions) {}

	get secureCookies(): boolean {
		return this.options.secureCookies === true;
	}

	async status(request: IncomingMessage): Promise<AuthStatus> {
		const setupRequired = !(await this.options.store.hasUsers());
		const principal = await this.authenticate(request).catch((error: unknown) => {
			this.options.logger.error("session lookup failed", error);
			return undefined;
		});
		return {
			version: this.options.version,
			setupRequired,
			authenticated: principal !== undefined,
			...(principal === undefined
				? {}
				: { user: { id: principal.id, username: principal.username, role: principal.role } }),
		};
	}

	/** Resolve the request's cookie to a Chord principal. Never trusts a client-supplied identity. */
	async authenticate(request: IncomingMessage): Promise<UserPrincipal | undefined> {
		const token = readCookie(request, AUTH_COOKIE_NAME);
		if (token === undefined) return undefined;
		const session = await this.options.store.findSession(token);
		return session === undefined ? undefined : principalFor(session.user, session.sessionId);
	}

	/** Verify credentials; `undefined` is the single "wrong username or password" answer. */
	async login(username: unknown, password: unknown, request: IncomingMessage): Promise<AuthSessionResult> {
		const key = this.rateKey(request, typeof username === "string" ? username : "");
		this.assertNotRateLimited(key);
		const user = await this.options.store.verifyLogin(username, password);
		if (user === undefined) {
			this.recordFailure(key);
			throw new AuthError("invalid_credentials", "用户名或密码错误", 401);
		}
		this.failures.delete(key);
		const session = await this.options.store.createSession(user.id);
		return { user, ...session };
	}

	async setup(
		username: unknown,
		password: unknown,
		request: IncomingMessage,
	): Promise<AuthSessionResult> {
		const key = `setup:${request.socket.remoteAddress ?? "unknown"}`;
		this.assertNotRateLimited(key);
		try {
			const user = await this.options.store.createFirstAdmin({ username, password });
			const session = await this.options.store.createSession(user.id);
			this.failures.delete(key);
			return { user, ...session };
		} catch (error) {
			if (error instanceof AuthError && error.code === "setup_complete") this.recordFailure(key);
			throw error;
		}
	}

	/** Drop the request's session. Returns who was signed out, so the caller can revoke their objects and links. */
	async logout(request: IncomingMessage): Promise<{ id: string; session: string } | undefined> {
		const token = readCookie(request, AUTH_COOKIE_NAME);
		if (token === undefined) return undefined;
		const session = await this.options.store.findSession(token);
		await this.options.store.deleteSessionByToken(token);
		return session === undefined ? undefined : { id: session.user.id, session: session.sessionId };
	}

	/** Change one's own password after proving the current one; all sessions are revoked by the store. */
	async changePassword(
		principal: UserPrincipal,
		currentPassword: unknown,
		newPassword: unknown,
	): Promise<void> {
		const check = await this.options.store.verifyLogin(principal.username, currentPassword);
		if (check === undefined || check.id !== principal.id) {
			throw new AuthError("invalid_credentials", "当前密码不正确", 401);
		}
		await this.options.store.changePassword(principal.id, newPassword);
	}

	/** Administrator account operations. The HTTP layer has already checked the role. */
	listUsersAsAdmin(): Promise<UserAdminUser[]> {
		return this.options.store.listUsers();
	}

	createUserAsAdmin(input: {
		username: unknown;
		password: unknown;
		role?: unknown;
	}): Promise<UserAdminUser> {
		return this.options.store.createUser(input);
	}

	getUserAsAdmin(id: string): Promise<UserAdminUser | undefined> {
		return this.options.store.getUser(id);
	}

	changePasswordAsAdmin(id: string, password: unknown): Promise<void> {
		return this.options.store.changePassword(id, password);
	}

	setRoleAsAdmin(id: string, role: unknown): Promise<UserAdminUser> {
		return this.options.store.setRole(id, role);
	}

	deleteUserAsAdmin(id: string): Promise<UserAdminUser> {
		return this.options.store.deleteUser(id);
	}

	private rateKey(request: IncomingMessage, username: string): string {
		return `${request.socket.remoteAddress ?? "unknown"}:${username.trim().toLowerCase()}`;
	}

	private assertNotRateLimited(key: string): void {
		const failure = this.failures.get(key);
		if (failure === undefined) return;
		if (failure.resetAt <= Date.now()) {
			this.failures.delete(key);
			return;
		}
		if (failure.count >= LOGIN_MAX_FAILURES) {
			const retryAfter = Math.max(1, Math.ceil((failure.resetAt - Date.now()) / 1000));
			throw new AuthError(
				"invalid_credentials",
				`尝试次数过多，请 ${retryAfter} 秒后再试`,
				429,
				retryAfter,
			);
		}
	}

	private recordFailure(key: string): void {
		const now = Date.now();
		const current = this.failures.get(key);
		if (current === undefined || current.resetAt <= now) {
			if (this.failures.size >= RATE_LIMIT_CAP) {
				const oldest = this.failures.keys().next().value;
				if (oldest !== undefined) this.failures.delete(oldest);
			}
			this.failures.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
			return;
		}
		current.count += 1;
	}
}

export function sessionCookie(token: string, expiresAt: string, secure: boolean): string {
	const maxAge = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
	return [
		`${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
		"Path=/",
		"HttpOnly",
		"SameSite=Lax",
		`Max-Age=${maxAge}`,
		...(secure ? ["Secure"] : []),
	].join("; ");
}

export function clearSessionCookie(secure: boolean): string {
	return [
		`${AUTH_COOKIE_NAME}=`,
		"Path=/",
		"HttpOnly",
		"SameSite=Lax",
		"Max-Age=0",
		"Expires=Thu, 01 Jan 1970 00:00:00 GMT",
		...(secure ? ["Secure"] : []),
	].join("; ");
}

export interface AuthHttpOptions {
	readonly service: AuthService;
	readonly allowedOrigins: readonly string[];
	readonly logger: Logger;
}

/** What one auth request asks the server to do after the response is sent. */
export interface AuthOutcome {
	/** Revoke one session only (`session` set) or all of the user's sessions. */
	readonly invalidate?: { readonly id: string; readonly session?: string };
}

function guardOrigin(
	request: IncomingMessage,
	response: ServerResponse,
	allowedOrigins: readonly string[],
): boolean {
	if (!sameOrigin(request, allowedOrigins) || crossSite(request)) {
		sendJson(response, 403, { error: "forbidden", code: "forbidden" });
		return true;
	}
	return false;
}

function readObject(body: unknown): Record<string, unknown> {
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		throw new AuthError("invalid_body", "请求体必须是 JSON 对象", 400);
	}
	return body as Record<string, unknown>;
}

function sendAuthError(response: ServerResponse, error: unknown, logger: Logger): void {
	if (error instanceof AuthError) {
		sendJson(
			response,
			error.status,
			{
				error: error.message,
				code: error.code,
				...(error.retryAfterSeconds === undefined
					? {}
					: { retryAfter: error.retryAfterSeconds }),
			},
			error.retryAfterSeconds === undefined
				? {}
				: { "retry-after": String(error.retryAfterSeconds) },
		);
		return;
	}
	logger.error("auth request failed", error);
	sendJson(response, 500, { error: "内部错误", code: "internal" });
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	let body: unknown;
	try {
		body = await readJsonBody(request, 64 * 1024);
	} catch (error) {
		throw new AuthError("invalid_body", error instanceof Error ? error.message : String(error), 400);
	}
	return readObject(body);
}

function setSession(
	response: ServerResponse,
	session: AuthSessionResult,
	secure: boolean,
): void {
	sendJson(
		response,
		200,
		{
			user: {
				id: session.user.id,
				username: session.user.username,
				role: session.user.role,
			},
		},
		{ "set-cookie": sessionCookie(session.token, session.expiresAt, secure) },
	);
}

/** Public endpoints: status, login, setup, logout. */
export async function handlePublicAuth(
	request: IncomingMessage,
	response: ServerResponse,
	pathname: string,
	method: string,
	options: AuthHttpOptions,
): Promise<AuthOutcome | undefined> {
	if (!pathname.startsWith("/api/auth/")) return undefined;

	if (pathname === "/api/auth/status") {
		if (method !== "GET") {
			sendJson(response, 405, { error: "method not allowed" });
			return {};
		}
		if (!sameOrigin(request, options.allowedOrigins)) {
			sendJson(response, 403, { error: "forbidden" });
			return {};
		}
		try {
			sendJson(response, 200, await options.service.status(request));
		} catch (error) {
			sendAuthError(response, error, options.logger);
		}
		return {};
	}

	if (pathname === "/api/auth/login" || pathname === "/api/auth/setup" || pathname === "/api/auth/logout") {
		if (method !== "POST") {
			sendJson(response, 405, { error: "method not allowed" });
			return {};
		}
		if (guardOrigin(request, response, options.allowedOrigins)) return {};
	}

	if (pathname === "/api/auth/login") {
		try {
			const body = await readBody(request);
			const session = await options.service.login(body.username, body.password, request);
			setSession(response, session, options.service.secureCookies);
		} catch (error) {
			sendAuthError(response, error, options.logger);
		}
		return {};
	}

	if (pathname === "/api/auth/setup") {
		try {
			const body = await readBody(request);
			const session = await options.service.setup(body.username, body.password, request);
			setSession(response, session, options.service.secureCookies);
		} catch (error) {
			sendAuthError(response, error, options.logger);
		}
		return {};
	}

	if (pathname === "/api/auth/logout") {
		try {
			const invalidate = await options.service.logout(request);
			sendJson(response, 200, { ok: true }, { "set-cookie": clearSessionCookie(options.service.secureCookies) });
			return invalidate === undefined ? {} : { invalidate };
		} catch (error) {
			sendAuthError(response, error, options.logger);
			return {};
		}
	}

	// A path under `/api/auth/` that is not one of the public endpoints is private (password)
	// or unknown; let the caller's auth/404 flow decide.
	return undefined;
}

/** Authenticated self-service endpoint: password change. */
export async function handlePrivateAuth(
	request: IncomingMessage,
	response: ServerResponse,
	pathname: string,
	method: string,
	principal: UserPrincipal,
	options: AuthHttpOptions,
): Promise<AuthOutcome | undefined> {
	if (pathname !== "/api/auth/password") return undefined;
	if (method !== "POST") {
		sendJson(response, 405, { error: "method not allowed" });
		return {};
	}
	if (guardOrigin(request, response, options.allowedOrigins)) return {};
	try {
		const body = await readBody(request);
		await options.service.changePassword(principal, body.currentPassword, body.newPassword);
		sendJson(
			response,
			200,
			{ ok: true, reauthenticate: true },
			{ "set-cookie": clearSessionCookie(options.service.secureCookies) },
		);
		return { invalidate: { id: principal.id } };
	} catch (error) {
		sendAuthError(response, error, options.logger);
		return {};
	}
}
