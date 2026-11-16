import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { Moonan } from "../src/index.js";
import {
	appFor,
	cleanup,
	closeClient,
	connectClient,
	cookieFor,
	createUser,
	loginAs,
	rawFetch,
	request,
	wsUrl,
} from "./support.js";

const ADMIN_PASSWORD = "moonan-test-password";
const BOB_PASSWORD = "moonan-bob-password";

interface AuthUser {
	id: string;
	username: string;
	role: "admin" | "user";
}

interface AuthStatusBody {
	version: string;
	setupRequired: boolean;
	authenticated: boolean;
	user?: AuthUser;
}

interface AuthErrorBody {
	error: string;
	code?: string;
	retryAfter?: number;
}

interface LoginResult {
	status: number;
	body: AuthErrorBody & { user?: AuthUser };
	response: Response;
}

afterEach(cleanup);

async function authStatus(app: Moonan, cookie?: string): Promise<AuthStatusBody> {
	const response = await rawFetch(
		`${app.url}/api/auth/status`,
		cookie === undefined ? undefined : { headers: { cookie } },
	);
	expect(response.status).toBe(200);
	return (await response.json()) as AuthStatusBody;
}

async function login(app: Moonan, username: string, password = ADMIN_PASSWORD): Promise<LoginResult> {
	const response = await rawFetch(`${app.url}/api/auth/login`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ username, password }),
	});
	return {
		status: response.status,
		body: ((await response.json()) as AuthErrorBody & { user?: AuthUser }) ?? {},
		response,
	};
}

async function postJson(
	app: Moonan,
	path: string,
	body: unknown,
	cookie?: string,
): Promise<{ status: number; body: Record<string, unknown>; response: Response }> {
	const response = await rawFetch(`${app.url}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...(cookie === undefined ? {} : { cookie }) },
		body: JSON.stringify(body),
	});
	const parsed = (await response.json()) as Record<string, unknown>;
	return { status: response.status, body: parsed, response };
}

function setCookieHeader(response: Response): string {
	const header = response.headers.get("set-cookie");
	if (header === null) throw new Error("response set no cookie");
	return header;
}

/** The `name=value` half of the first Set-Cookie header, ready for a request header. */
function sessionCookie(response: Response): string {
	const first = setCookieHeader(response).split(";")[0]?.trim();
	if (first === undefined || !first.includes("=")) throw new Error("response set a malformed cookie");
	return first;
}

/** Resolves when the server closes the socket (or rejects it before it opens). */
function waitClose(socket: WebSocket, timeoutMs = 3_000): Promise<void> {
	return new Promise((resolve, reject) => {
		if (socket.readyState === WebSocket.CLOSED) {
			resolve();
			return;
		}
		const timer = setTimeout(() => reject(new Error("websocket did not close")), timeoutMs);
		const done = () => {
			clearTimeout(timer);
			resolve();
		};
		socket.once("close", done);
		socket.once("error", done);
	});
}

describe("accounts", () => {
	it("requires first-run setup and refuses a second setup", async () => {
		const app = await appFor([], { bootstrapAdmin: false });
		const before = await authStatus(app);
		expect(before).toMatchObject({ setupRequired: true, authenticated: false });
		expect(typeof before.version).toBe("string");
		expect(before.version.length).toBeGreaterThan(0);
		expect(before.user).toBeUndefined();

		// The first-run form is validated like any account creation.
		const weak = await postJson(app, "/api/auth/setup", { username: "root", password: "short" });
		expect(weak.status).toBe(400);
		expect(weak.body).toMatchObject({ code: "invalid_body" });

		const setup = await postJson(app, "/api/auth/setup", {
			username: "root",
			password: ADMIN_PASSWORD,
		});
		expect(setup.status).toBe(200);
		expect(setup.body.user).toMatchObject({ username: "root", role: "admin" });
		const cookie = sessionCookie(setup.response);
		const after = await authStatus(app, cookie);
		expect(after).toMatchObject({ setupRequired: false, authenticated: true });
		expect(after.user).toMatchObject({ username: "root", role: "admin" });

		// Once an administrator exists, setup is closed even if the database were reachable.
		const again = await postJson(app, "/api/auth/setup", {
			username: "another",
			password: ADMIN_PASSWORD,
		});
		expect(again.status).toBe(409);
		expect(again.body).toMatchObject({ code: "setup_complete" });
	});

	it("logs in with the right password and rejects the wrong one", async () => {
		const app = await appFor([]);

		const wrong = await login(app, "admin", "not-the-password");
		expect(wrong.status).toBe(401);
		expect(wrong.body).toMatchObject({ code: "invalid_credentials" });

		const ok = await login(app, "admin");
		expect(ok.status).toBe(200);
		expect(ok.body.user).toMatchObject({ username: "admin", role: "admin" });
		const status = await authStatus(app, sessionCookie(ok.response));
		expect(status).toMatchObject({ authenticated: true, setupRequired: false });
		expect(status.user?.username).toBe("admin");

		// An unknown username answers exactly like a wrong password: no account enumeration.
		const unknown = await login(app, "nobody");
		expect(unknown.status).toBe(401);
		expect(unknown.body).toMatchObject({ code: "invalid_credentials" });
	});

	it("sets an HttpOnly SameSite=Lax cookie, adding Secure only when configured", async () => {
		const app = await appFor([]);
		const loginResult = await login(app, "admin");
		const header = setCookieHeader(loginResult.response);
		expect(header).toMatch(/^moonan_session=/);
		expect(header).toContain("Path=/");
		expect(header).toContain("HttpOnly");
		expect(header).toContain("SameSite=Lax");
		expect(header).toContain("Max-Age=");
		expect(header).not.toContain("Secure");

		// Behind an HTTPS reverse proxy the operator opts the cookie into Secure.
		const secure = await appFor([], { secureCookies: true });
		const secureLogin = await login(secure, "admin");
		expect(setCookieHeader(secureLogin.response)).toContain("Secure");
	});

	it("reports status and refuses protected endpoints without a session", async () => {
		const app = await appFor([]);
		const anonymous = await authStatus(app);
		expect(anonymous).toMatchObject({ setupRequired: false, authenticated: false });
		expect(anonymous.user).toBeUndefined();
		const cookie = cookieFor(app);
		expect(cookie).toBeDefined();
		expect(await authStatus(app, cookie)).toMatchObject({ authenticated: true });

		// Every API is closed, including the self-service password endpoint.
		for (const [method, path] of [
			["GET", "/api/data/status"],
			["GET", "/api/plugins"],
			["GET", "/api/v1/plugins"],
			["GET", "/api/v1/users"],
			["POST", "/api/auth/password"],
		] as const) {
			const response = await request(`${app.url}${path}`, {
				method,
				...(method === "POST"
					? { headers: { "content-type": "application/json" }, body: JSON.stringify({}) }
					: {}),
				cookie: null,
			});
			expect(response.status, `${method} ${path}`).toBe(401);
			expect(JSON.parse(response.body), `${method} ${path}`).toMatchObject({
				code: "unauthorized",
			});
		}

		// The WebSocket is authenticated by the same cookie: no session, no link.
		const socket = new WebSocket(wsUrl(app));
		try {
			await waitClose(socket);
		} finally {
			socket.terminate();
		}
	});

	it("logs out: clears the cookie, revokes the session and closes its WebSocket", async () => {
		const app = await appFor([]);
		const cookie = cookieFor(app);
		const { socket, client } = await connectClient(app);
		try {
			const closed = waitClose(socket);
			const response = await rawFetch(`${app.url}/api/auth/logout`, {
				method: "POST",
				headers: { cookie: cookie!, origin: app.url },
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ ok: true });
			const cleared = setCookieHeader(response);
			expect(cleared).toMatch(/^moonan_session=;/);
			expect(cleared).toContain("Max-Age=0");
			await closed;

			// The server-side session is gone, so the old cookie authenticates nothing.
			expect((await authStatus(app, cookie)).authenticated).toBe(false);
			expect((await request(`${app.url}/api/data/status`, { cookie })).status).toBe(401);
		} finally {
			await closeClient(socket, client);
		}

		// A logout without a session is still a successful no-op with a cleared cookie.
		const anonymous = await postJson(app, "/api/auth/logout", {});
		expect(anonymous.status).toBe(200);
		expect(setCookieHeader(anonymous.response)).toContain("Max-Age=0");
	});

	it("changes the password, revoking every session of the account", async () => {
		const app = await appFor([]);
		const bob = await createUser(app, { username: "bob" });
		const bobCookie = await loginAs(app, "bob");
		const adminCookie = cookieFor(app)!;

		// Proving the current password is mandatory; a failure does not end the session.
		const wrong = await postJson(
			app,
			"/api/auth/password",
			{ currentPassword: "not-the-password", newPassword: BOB_PASSWORD },
			bobCookie,
		);
		expect(wrong.status).toBe(401);
		expect(wrong.body).toMatchObject({ code: "invalid_credentials" });
		expect((await authStatus(app, bobCookie)).authenticated).toBe(true);
		// The new password is validated by the account store, not the browser.
		const weak = await postJson(
			app,
			"/api/auth/password",
			{ currentPassword: ADMIN_PASSWORD, newPassword: "short" },
			bobCookie,
		);
		expect(weak.status).toBe(400);
		expect(weak.body).toMatchObject({ code: "invalid_body" });

		const { socket, client } = await connectClient(app, undefined, { cookie: bobCookie });
		try {
			const closed = waitClose(socket);
			const changed = await postJson(
				app,
				"/api/auth/password",
				{ currentPassword: ADMIN_PASSWORD, newPassword: BOB_PASSWORD },
				bobCookie,
			);
			expect(changed.status).toBe(200);
			expect(changed.body).toMatchObject({ ok: true, reauthenticate: true });
			expect(setCookieHeader(changed.response)).toContain("Max-Age=0");
			// The account store revoked every session; the open WebSocket is part of that.
			await closed;
			expect((await authStatus(app, bobCookie)).authenticated).toBe(false);
		} finally {
			await closeClient(socket, client);
		}

		expect((await login(app, "bob", ADMIN_PASSWORD)).status).toBe(401);
		const relogin = await login(app, "bob", BOB_PASSWORD);
		expect(relogin.status).toBe(200);
		expect((await authStatus(app, sessionCookie(relogin.response))).authenticated).toBe(true);
		// Only the account that changed its password is signed out.
		expect((await authStatus(app, adminCookie)).authenticated).toBe(true);
		expect((await authStatus(app, bobCookie)).authenticated).toBe(false);
	});

	it("revokes sessions when an administrator changes a role or deletes the account", async () => {
		const app = await appFor([]);
		const bob = await createUser(app, { username: "bob" });
		const bobCookie = await loginAs(app, "bob");
		const adminCookie = cookieFor(app)!;

		const roleChange = await postJson(
			app,
			"/api/v1/users/role",
			{ id: bob.id, role: "admin" },
			adminCookie,
		);
		expect(roleChange.status).toBe(200);
		expect(roleChange.body.user).toMatchObject({ id: bob.id, role: "admin" });
		// The old session was revoked, so its cookie no longer authenticates.
		expect((await authStatus(app, bobCookie)).authenticated).toBe(false);

		const bobAdminCookie = await loginAs(app, "bob");
		expect((await authStatus(app, bobAdminCookie)).user).toMatchObject({ id: bob.id, role: "admin" });
		const { socket, client } = await connectClient(app, undefined, { cookie: bobAdminCookie });
		try {
			const closed = waitClose(socket);
			const removed = await postJson(app, "/api/v1/users/remove", { id: bob.id }, adminCookie);
			expect(removed.status).toBe(200);
			expect(removed.body).toMatchObject({ ok: true });
			await closed;
			expect((await authStatus(app, bobAdminCookie)).authenticated).toBe(false);
		} finally {
			await closeClient(socket, client);
		}
		expect((await login(app, "bob")).status).toBe(401);
	});

	it("enforces the administrator role on admin-only endpoints", async () => {
		const app = await appFor([]);
		await createUser(app, { username: "viewer" });
		const viewerCookie = await loginAs(app, "viewer");
		for (const path of ["/api/plugins", "/api/v1/plugins", "/api/v1/users"]) {
			const response = await request(`${app.url}${path}`, { cookie: viewerCookie });
			expect(response.status, path).toBe(403);
			expect(JSON.parse(response.body), path).toMatchObject({ code: "admin_required" });
		}
		// The administrator account sees the same endpoints.
		for (const path of ["/api/plugins", "/api/v1/plugins", "/api/v1/users"]) {
			expect((await request(`${app.url}${path}`)).status, path).toBe(200);
		}
	});
});
