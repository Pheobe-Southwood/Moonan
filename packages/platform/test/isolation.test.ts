import {
	hostNamed,
	method,
	num,
	obj,
	remote,
	str,
	userDataOwner,
} from "@moonan_ai/sdk";
import { afterEach, describe, expect, it } from "vitest";
import type { Moonan } from "../src/index.js";
import {
	appFor,
	cleanup,
	closeClient,
	connectClient,
	createUser,
	loginAs,
	pluginDir,
	request,
} from "./support.js";

/**
 * The isolation fixture.
 *
 * A remote counter object is served once per (type, input, principal key): its factory sees
 * the caller's principal, so two signed-in accounts get two distinct objects. The data root
 * is host-lifetime (one shared HTTP route) and therefore scopes its DataStore calls from
 * `ctx.principal` on every request.
 */
const ISOLATION_PLUGIN = `
import {
	DataCodecs,
	DataStore,
	Routes,
	dataOwner,
	defineFacet,
	hostNamed,
	local,
	method,
	num,
	obj,
	remote,
	str,
} from "@moonan_ai/sdk";

const Counter = remote("test.isolation.counter", {
	version: 1,
	input: obj({}, { open: true }),
	host: hostNamed("moonan"),
	variants: {
		v1: {
			state: { count: num(), owner: str() },
			methods: {
				bump: method(undefined, num()),
				current: method(undefined, num()),
			},
		},
	},
});

const Root = local("test.isolation.root", { version: 1, input: obj({}, { open: true }), members: {} });

export default defineFacet((api) => {
	api.serve(Counter, (_input, principal, self) => {
		const count = self.state("count", num(), 0);
		// The factory runs for the caller's principal, so this state is per account/session.
		const owner = self.state("owner", str(), dataOwner(principal));
		const bump = (ctx) => {
			count.change(ctx, (value) => value + 1);
			return count.value;
		};
		return {
			variant: "v1",
			count,
			owner,
			bump,
			current: () => count.value,
		};
	});

	api.serve(Root, (_input, _principal, self) => {
		const data = self.get(DataStore, {});
		const namespace = "test.isolated";
		self.register(DataCodecs, {
			[namespace]: {
				namespace,
				version: 1,
				migrate: (stored) => String(stored),
				export: (stored) => stored,
				import: (stored) => String(stored),
			},
		});
		const ownerOf = (ctx) => dataOwner(ctx.principal);
		const valueOf = async (ctx) => {
			const stored = await data.read({ owner: ownerOf(ctx), namespace }, ctx);
			return stored === undefined ? "empty" : String(stored.value);
		};
		self.register(Routes, {
			"GET /api/isolated": async (_request, response, ctx) => {
				response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
				response.end(JSON.stringify({ owner: ownerOf(ctx), value: await valueOf(ctx) }));
			},
			"POST /api/isolated": async (request, response, ctx) => {
				let body = "";
				for await (const chunk of request) body += chunk;
				const next = String(JSON.parse(body).value ?? "");
				await data.update(
					{
						owner: ownerOf(ctx),
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

/** The same contract the fixture serves, so the test's client can reach the remote object. */
const Counter = remote("test.isolation.counter", {
	version: 1,
	input: obj({}, { open: true }),
	host: hostNamed("moonan"),
	variants: {
		v1: {
			state: { count: num(), owner: str() },
			methods: {
				bump: method(undefined, num()),
				current: method(undefined, num()),
			},
		},
	},
});

interface AuthUser {
	id: string;
	username: string;
	role: string;
}

interface DataBundleLike {
	format: string;
	datasets: { namespace: string; version: number; value: unknown }[];
}

afterEach(cleanup);

async function currentUser(app: Moonan): Promise<AuthUser> {
	const response = await request(`${app.url}/api/auth/status`);
	expect(response.status).toBe(200);
	const body = JSON.parse(response.body) as { user?: AuthUser };
	if (body.user === undefined) throw new Error("no signed-in user");
	return body.user;
}

async function setIsolated(url: string, value: string, cookie?: string): Promise<void> {
	const response = await request(`${url}/api/isolated`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ value }),
		...(cookie === undefined ? {} : { cookie }),
	});
	expect(response.status).toBe(200);
}

async function getIsolated(url: string, cookie?: string): Promise<{ owner: string; value: string }> {
	const response = await request(`${url}/api/isolated`, cookie === undefined ? {} : { cookie });
	expect(response.status).toBe(200);
	return JSON.parse(response.body) as { owner: string; value: string };
}

async function exportBundle(url: string, cookie?: string): Promise<DataBundleLike> {
	const response = await request(`${url}/api/data/export`, cookie === undefined ? {} : { cookie });
	expect(response.status).toBe(200);
	return JSON.parse(response.body) as DataBundleLike;
}

async function importBundle(url: string, bundle: unknown, cookie?: string): Promise<void> {
	const response = await request(`${url}/api/data/import`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(bundle),
		...(cookie === undefined ? {} : { cookie }),
	});
	expect(response.status).toBe(200);
}

describe("multi-user isolation", () => {
	it("gives each signed-in account its own remote object and state", async () => {
		const dir = await pluginDir(ISOLATION_PLUGIN);
		const app = await appFor([dir]);
		const adminUser = await currentUser(app);
		const bob = await createUser(app, { username: "bob" });
		const bobCookie = await loginAs(app, "bob");

		const admin = await connectClient(app);
		const bobClient = await connectClient(app, undefined, { cookie: bobCookie });
		try {
			const adminCounter = await admin.client.get(Counter, {});
			const bobCounter = await bobClient.client.get(Counter, {});
			try {
				// The factory saw each caller's principal: state ownership is per account.
				expect(adminCounter.owner.value).toBe(userDataOwner(adminUser.id));
				expect(bobCounter.owner.value).toBe(userDataOwner(bob.id));

				expect(await adminCounter.current()).toBe(0);
				expect(await bobCounter.current()).toBe(0);
				expect(await adminCounter.bump()).toBe(1);
				expect(await adminCounter.current()).toBe(1);
				// The other account's object is untouched: no shared host singleton.
				expect(await bobCounter.current()).toBe(0);
				expect(await bobCounter.bump()).toBe(1);
				expect(await bobCounter.bump()).toBe(2);
				expect(await bobCounter.current()).toBe(2);
				expect(await adminCounter.current()).toBe(1);
			} finally {
				adminCounter.release();
				bobCounter.release();
			}
		} finally {
			await closeClient(admin.socket, admin.client);
			await closeClient(bobClient.socket, bobClient.client);
		}
	});

	it("scopes route writes, exports and imports to the signed-in account", async () => {
		const dir = await pluginDir(ISOLATION_PLUGIN);
		const app = await appFor([dir]);
		const adminUser = await currentUser(app);
		const bob = await createUser(app, { username: "bob" });
		const bobCookie = await loginAs(app, "bob");

		await setIsolated(app.url, "admin-value");
		await setIsolated(app.url, "bob-value", bobCookie);
		expect(await getIsolated(app.url)).toEqual({
			owner: userDataOwner(adminUser.id),
			value: "admin-value",
		});
		expect(await getIsolated(app.url, bobCookie)).toEqual({
			owner: userDataOwner(bob.id),
			value: "bob-value",
		});

		// Export is scoped to the session's owner.
		const adminBundle = await exportBundle(app.url);
		expect(adminBundle.datasets).toEqual([
			{ namespace: "test.isolated", version: 1, value: "admin-value" },
		]);
		const bobBundle = await exportBundle(app.url, bobCookie);
		expect(bobBundle.datasets).toEqual([
			{ namespace: "test.isolated", version: 1, value: "bob-value" },
		]);

		// Import lands in the importer's own partition; the other account keeps its value.
		await importBundle(
			app.url,
			{
				...bobBundle,
				datasets: [{ namespace: "test.isolated", version: 1, value: "bob-imported" }],
			},
			bobCookie,
		);
		expect((await getIsolated(app.url)).value).toBe("admin-value");
		expect((await getIsolated(app.url, bobCookie)).value).toBe("bob-imported");
	});

	it("purges a deleted account's datasets and leaves other owners alone", async () => {
		const dir = await pluginDir(ISOLATION_PLUGIN);
		const app = await appFor([dir]);
		const adminUser = await currentUser(app);
		const bob = await createUser(app, { username: "bob" });
		const bobCookie = await loginAs(app, "bob");

		await setIsolated(app.url, "admin-value");
		await setIsolated(app.url, "bob-value", bobCookie);
		expect((await app.exportData(userDataOwner(bob.id))).datasets).toContainEqual({
			namespace: "test.isolated",
			version: 1,
			value: "bob-value",
		});

		const removed = await request(`${app.url}/api/v1/users/remove`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: app.url },
			body: JSON.stringify({ id: bob.id }),
		});
		expect(removed.status).toBe(200);

		expect((await app.exportData(userDataOwner(bob.id))).datasets).toEqual([]);
		expect((await app.exportData(userDataOwner(adminUser.id))).datasets).toContainEqual({
			namespace: "test.isolated",
			version: 1,
			value: "admin-value",
		});
	});
});
