import type { UserAdminMutation, UserAdminSnapshot, UserAdminUser } from "@moonan_ai/sdk";
import { userDataOwner } from "@moonan_ai/sdk";
import { afterEach, describe, expect, it } from "vitest";
import type { Moonan } from "../src/index.js";
import {
	appFor,
	cleanup,
	cookieFor,
	createUser,
	loginAs,
	pluginDir,
	rawFetch,
	request,
} from "./support.js";

const ADMIN_PASSWORD = "moonan-test-password";
const BOB_PASSWORD = "moonan-bob-password";
const NEW_PASSWORD = "moonan-new-password";

/**
 * A dataset plugin whose HTTP route writes the caller's own partition. Account deletion has
 * to purge exactly that owner's rows.
 */
const PURGE_PLUGIN = `
import { DataCodecs, DataStore, Routes, dataOwner, defineFacet, local, obj } from "@moonan_ai/sdk";

const Root = local("test.purge.root", { version: 1, input: obj({}, { open: true }), members: {} });

export default defineFacet((api) => {
	api.serve(Root, (_input, _principal, self) => {
		const data = self.get(DataStore, {});
		const namespace = "test.purge";
		self.register(DataCodecs, {
			[namespace]: {
				namespace,
				version: 1,
				migrate: (stored) => String(stored),
				export: (stored) => stored,
				import: (stored) => String(stored),
			},
		});
		self.register(Routes, {
			"POST /api/purge": async (request, response, ctx) => {
				let body = "";
				for await (const chunk of request) body += chunk;
				const next = String(JSON.parse(body).value ?? "");
				await data.update(
					{
						owner: dataOwner(ctx.principal),
						namespace,
						version: 1,
						update: () => ({ value: next, version: 1 }),
					},
					ctx,
				);
				response.writeHead(200);
				response.end("ok");
			},
		});
		return {};
	}, { lifetime: "host" });
}, { uses: [DataStore] });
`;

afterEach(cleanup);

interface AdminResult {
	status: number;
	body: Record<string, unknown>;
}

/** One account-API request; without a cookie it uses the bootstrapped administrator. */
async function adminRequest(
	app: Moonan,
	path: string,
	options: { method?: string; body?: unknown; cookie?: string } = {},
): Promise<AdminResult> {
	const response = await request(`${app.url}${path}`, {
		method: options.method ?? "GET",
		...(options.cookie === undefined ? {} : { cookie: options.cookie }),
		...(options.body === undefined
			? {}
			: {
					headers: { "content-type": "application/json", origin: app.url },
					body: JSON.stringify(options.body),
				}),
	});
	return {
		status: response.status,
		body: response.body === "" ? {} : (JSON.parse(response.body) as Record<string, unknown>),
	};
}

function adminGet(app: Moonan, path: string, cookie?: string): Promise<AdminResult> {
	return adminRequest(app, path, cookie === undefined ? {} : { cookie });
}

function adminPost(app: Moonan, path: string, body: unknown, cookie?: string): Promise<AdminResult> {
	return adminRequest(app, path, {
		method: "POST",
		body,
		...(cookie === undefined ? {} : { cookie }),
	});
}

function mutation(result: AdminResult): UserAdminMutation {
	return result.body as unknown as UserAdminMutation;
}

function user(result: AdminResult): UserAdminUser {
	const created = mutation(result).user;
	if (created === undefined) throw new Error("mutation returned no user");
	return created;
}

async function snapshot(app: Moonan, cookie?: string): Promise<UserAdminSnapshot> {
	const result = await adminGet(app, "/api/v1/users", cookie);
	expect(result.status).toBe(200);
	return result.body as unknown as UserAdminSnapshot;
}

async function authStatus(
	app: Moonan,
	cookie?: string,
): Promise<{ authenticated: boolean; user?: { id: string; username: string; role: string } }> {
	const response = await rawFetch(
		`${app.url}/api/auth/status`,
		cookie === undefined ? undefined : { headers: { cookie } },
	);
	expect(response.status).toBe(200);
	return (await response.json()) as {
		authenticated: boolean;
		user?: { id: string; username: string; role: string };
	};
}

async function credentials(
	app: Moonan,
	username: string,
	password: string,
): Promise<{ status: number; cookie?: string }> {
	const response = await rawFetch(`${app.url}/api/auth/login`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ username, password }),
	});
	if (response.status !== 200) return { status: response.status };
	const first = (response.headers.get("set-cookie") ?? "").split(";")[0]?.trim();
	if (first === undefined || first.length === 0) throw new Error("login set no cookie");
	return { status: response.status, cookie: first };
}

async function writeDataset(app: Moonan, value: string, cookie?: string): Promise<void> {
	const response = await request(`${app.url}/api/purge`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ value }),
		...(cookie === undefined ? {} : { cookie }),
	});
	expect(response.status).toBe(200);
}

describe("user administration API", () => {
	it("lists accounts without leaking credentials", async () => {
		const app = await appFor([]);
		const listed = await snapshot(app);
		expect(listed.api).toBe(1);
		expect(listed.users).toHaveLength(1);
		expect(listed.users[0]).toMatchObject({ username: "admin", role: "admin" });
		expect(listed.users[0]!.id).toBe(listed.currentUserId);
		expect(listed.users[0]!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(listed.users[0]!.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		// The public record has exactly the account identity: no hash, no salt, no token.
		const record = JSON.stringify(listed);
		expect(record).not.toMatch(/password|salt|scrypt|token/i);
		expect(Object.keys(listed.users[0]!).sort()).toEqual(["createdAt", "id", "role", "updatedAt", "username"]);
	});

	it("requires an administrator for account management", async () => {
		const app = await appFor([]);
		const anonymous = await request(`${app.url}/api/v1/users`, { cookie: null });
		expect(anonymous.status).toBe(401);
		expect(JSON.parse(anonymous.body)).toMatchObject({ code: "unauthorized" });

		await createUser(app, { username: "viewer" });
		const viewerCookie = await loginAs(app, "viewer");
		const deniedList = await adminGet(app, "/api/v1/users", viewerCookie);
		expect(deniedList.status).toBe(403);
		expect(deniedList.body).toMatchObject({ code: "admin_required" });
		const deniedCreate = await adminPost(
			app,
			"/api/v1/users/create",
			{ username: "nobody", password: BOB_PASSWORD },
			viewerCookie,
		);
		expect(deniedCreate.status).toBe(403);
		expect(deniedCreate.body).toMatchObject({ code: "admin_required" });
		const deniedRemove = await adminPost(
			app,
			"/api/v1/users/remove",
			{ id: (await snapshot(app)).currentUserId },
			viewerCookie,
		);
		expect(deniedRemove.status).toBe(403);

		// The administrator keeps full access.
		expect((await snapshot(app)).users).toHaveLength(2);
	});

	it("creates accounts and validates the input", async () => {
		const app = await appFor([]);
		const created = await adminPost(app, "/api/v1/users/create", {
			username: "bob",
			password: BOB_PASSWORD,
			role: "user",
		});
		expect(created.status).toBe(200);
		const bob = user(created);
		expect(bob).toMatchObject({ username: "bob", role: "user" });
		expect(bob.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(bob.id.length).toBeGreaterThan(0);
		expect((await credentials(app, "bob", BOB_PASSWORD)).status).toBe(200);

		const listed = await snapshot(app);
		expect(listed.users.map((account) => account.username)).toEqual(["admin", "bob"]);

		// Usernames are unique case-insensitively: the database collation is the authority.
		const duplicate = await adminPost(app, "/api/v1/users/create", {
			username: "BOB",
			password: BOB_PASSWORD,
		});
		expect(duplicate.status).toBe(409);
		expect(duplicate.body).toMatchObject({ code: "username_taken" });

		for (const [index, body] of [
			{ username: "", password: BOB_PASSWORD },
			{ username: "-leading-dash", password: BOB_PASSWORD },
			{ username: "bob2", password: "short" },
			{ username: "bob2", password: BOB_PASSWORD, role: "owner" },
		].entries()) {
			const invalid = await adminPost(app, "/api/v1/users/create", body);
			expect(invalid.status, `invalid case ${index}`).toBe(400);
			expect(invalid.body, `invalid case ${index}`).toMatchObject({ code: "invalid_body" });
		}
		// The role is optional and defaults to the least-privileged account.
		const noRole = await adminPost(app, "/api/v1/users/create", {
			username: "carol",
			password: BOB_PASSWORD,
		});
		expect(user(noRole).role).toBe("user");
		const adminRole = await adminPost(app, "/api/v1/users/create", {
			username: "dave",
			password: BOB_PASSWORD,
			role: "admin",
		});
		expect(user(adminRole).role).toBe("admin");
	});

	it("resets a password and revokes the account's sessions", async () => {
		const app = await appFor([]);
		const bob = await createUser(app, { username: "bob" });
		const bobCookie = await loginAs(app, "bob");
		expect((await authStatus(app, bobCookie)).authenticated).toBe(true);

		const reset = await adminPost(app, "/api/v1/users/password", {
			id: bob.id,
			password: NEW_PASSWORD,
		});
		expect(reset.status).toBe(200);
		expect(user(reset)).toMatchObject({ id: bob.id, username: "bob" });

		// The old session and the old password are both dead.
		expect((await authStatus(app, bobCookie)).authenticated).toBe(false);
		expect((await credentials(app, "bob", BOB_PASSWORD)).status).toBe(401);
		const relogin = await credentials(app, "bob", NEW_PASSWORD);
		expect(relogin.status).toBe(200);
		expect((await authStatus(app, relogin.cookie)).authenticated).toBe(true);

		const missing = await adminPost(app, "/api/v1/users/password", {
			id: "00000000-0000-0000-0000-000000000000",
			password: NEW_PASSWORD,
		});
		expect(missing.status).toBe(404);
		expect(missing.body).toMatchObject({ code: "unknown_user" });
	});

	it("changes a role and refuses to demote the last administrator", async () => {
		const app = await appFor([]);
		const before = await snapshot(app);
		const demote = await adminPost(app, "/api/v1/users/role", {
			id: before.currentUserId,
			role: "user",
		});
		expect(demote.status).toBe(409);
		expect(demote.body).toMatchObject({ code: "last_admin" });
		expect((await snapshot(app)).users[0]?.role).toBe("admin");

		const carol = await createUser(app, { username: "carol", role: "admin" });
		const carolCookie = await loginAs(app, "carol");
		const changed = await adminPost(app, "/api/v1/users/role", { id: carol.id, role: "user" });
		expect(changed.status).toBe(200);
		expect(user(changed)).toMatchObject({ id: carol.id, role: "user" });
		// A role change revokes the account's sessions: the panel has to log in again.
		expect((await authStatus(app, carolCookie)).authenticated).toBe(false);
		const relogin = await loginAs(app, "carol");
		expect((await authStatus(app, relogin)).user?.role).toBe("user");

		// With two administrators, demoting one is allowed.
		const dave = await createUser(app, { username: "dave", role: "admin" });
		const demoted = await adminPost(app, "/api/v1/users/role", { id: dave.id, role: "user" });
		expect(demoted.status).toBe(200);
		expect(user(demoted).role).toBe("user");
	});

	it("refuses to delete the last administrator and lets an administrator delete themselves", async () => {
		const app = await appFor([]);
		const before = await snapshot(app);
		const adminId = before.currentUserId;
		const refused = await adminPost(app, "/api/v1/users/remove", { id: adminId });
		expect(refused.status).toBe(409);
		expect(refused.body).toMatchObject({ code: "last_admin" });
		expect((await snapshot(app)).users).toHaveLength(1);

		// The first administrator creates a successor and removes their own account.
		const carol = await createUser(app, { username: "carol", role: "admin" });
		const removed = await adminPost(app, "/api/v1/users/remove", { id: adminId });
		expect(removed.status).toBe(200);
		expect(mutation(removed)).toMatchObject({ ok: true });
		expect(mutation(removed).warning).toBeUndefined();

		// The deleted administrator's session is revoked; the successor still manages accounts.
		expect((await authStatus(app, cookieFor(app))).authenticated).toBe(false);
		const carolCookie = await loginAs(app, "carol");
		const after = await snapshot(app, carolCookie);
		expect(after.users.map((account) => account.username)).toEqual(["carol"]);
		expect(after.currentUserId).toBe(carol.id);
		expect((await authStatus(app, carolCookie)).user?.role).toBe("admin");

		const missing = await adminPost(app, "/api/v1/users/remove", { id: carol.id }, carolCookie);
		// Deleting the last remaining administrator is still refused, even by that administrator.
		expect(missing.status).toBe(409);
		expect(missing.body).toMatchObject({ code: "last_admin" });
	});

	it("deletes an account and purges exactly that account's datasets", async () => {
		const dir = await pluginDir(PURGE_PLUGIN);
		const app = await appFor([dir]);
		const admin = await snapshot(app);
		const bob = await createUser(app, { username: "bob" });
		const bobCookie = await loginAs(app, "bob");

		await writeDataset(app, "admin-dataset");
		await writeDataset(app, "bob-dataset", bobCookie);
		const bobBefore = await app.exportData(userDataOwner(bob.id));
		expect(bobBefore.datasets).toContainEqual({
			namespace: "test.purge",
			version: 1,
			value: "bob-dataset",
		});

		const removed = await adminPost(app, "/api/v1/users/remove", { id: bob.id });
		expect(removed.status).toBe(200);
		expect(mutation(removed).warning).toBeUndefined();

		// The deleted account is gone (login and session alike) and its datasets were purged.
		expect((await credentials(app, "bob", BOB_PASSWORD)).status).toBe(401);
		expect((await authStatus(app, bobCookie)).authenticated).toBe(false);
		expect((await app.exportData(userDataOwner(bob.id))).datasets).toEqual([]);
		// Another account's dataset is untouched.
		const adminAfter = await app.exportData(userDataOwner(admin.currentUserId));
		expect(adminAfter.datasets).toContainEqual({
			namespace: "test.purge",
			version: 1,
			value: "admin-dataset",
		});
	});
});
