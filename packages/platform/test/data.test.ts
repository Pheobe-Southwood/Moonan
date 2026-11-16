import { DataStore } from "@moonan_ai/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { appFor, cleanup, createUser, loginAs, pluginDir, request } from "./support.js";

/**
 * A dataset plugin that scopes every read and write to the signed-in caller.
 *
 * Host objects activate as the host principal, so a host-lifetime store reference cannot
 * know who is calling: the route uses `ctx.principal` for the owner on each request, which
 * is also what the platform's own `/api/data/*` endpoints do.
 */
const PLUGIN = `
import { DataCodecs, DataStore, Routes, dataOwner, defineFacet, local, obj } from "@moonan_ai/sdk";

const Root = local("test.data-root", {
	version: 1,
	input: obj({}, { open: true }),
	members: {},
});

export default defineFacet((api) => {
	api.serve(
		Root,
		(_input, _principal, self) => {
			const data = self.get(DataStore, {});
			const namespace = "test.data";

			self.register(DataCodecs, {
				"test.data": {
					namespace,
					version: 1,
					migrate: (stored, from) => {
						if (from !== 1) throw new Error("unsupported test.data version");
						return String(stored);
					},
					export: (stored) => stored,
					import: (stored, from) => {
						if (from !== 1) throw new Error("unsupported test.data version");
						return String(stored);
					},
				},
			});

			const ownerOf = (ctx) => dataOwner(ctx.principal);
			const send = (response, text) => {
				response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
				response.end(text);
			};

			self.register(Routes, {
				"GET /api/data-test": async (_request, response, ctx) => {
					const stored = await data.read({ owner: ownerOf(ctx), namespace }, ctx);
					send(response, stored === undefined ? "empty" : String(stored.value));
				},
				"POST /api/data-test": async (request, response, ctx) => {
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
					send(response, "ok");
				},
				// Proves the route really sees the signed-in account, not the host principal.
				"GET /api/data-test/principal": async (_request, response, ctx) => {
					const principal = ctx.principal;
					response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
					response.end(
						JSON.stringify({
							owner: ownerOf(ctx),
							kind: principal?.kind,
							username: principal?.username,
							role: principal?.role,
						}),
					);
				},
			});

			return {};
		},
		{ lifetime: "host" },
	);
}, { uses: [DataStore] });
`;

afterEach(cleanup);

async function readValue(url: string, cookie?: string): Promise<string> {
	const response = await request(`${url}/api/data-test`, cookie === undefined ? {} : { cookie });
	expect(response.status).toBe(200);
	return response.body;
}

async function setValue(url: string, value: string, cookie?: string): Promise<void> {
	const response = await request(`${url}/api/data-test`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ value }),
		...(cookie === undefined ? {} : { cookie }),
	});
	expect(response.status).toBe(200);
}

async function principalOf(url: string, cookie?: string): Promise<{ owner: string; kind: string; username: string }> {
	const response = await request(`${url}/api/data-test/principal`, cookie === undefined ? {} : { cookie });
	expect(response.status).toBe(200);
	return JSON.parse(response.body) as { owner: string; kind: string; username: string };
}

async function authStatus(url: string, cookie?: string): Promise<{ user?: { id: string; username: string; role: string } }> {
	const response = await request(`${url}/api/auth/status`, cookie === undefined ? {} : { cookie });
	expect(response.status).toBe(200);
	return JSON.parse(response.body) as { user?: { id: string; username: string; role: string } };
}

interface Bundle {
	format: string;
	datasets: { namespace: string; version: number; value: unknown }[];
}

async function exportData(url: string, cookie?: string): Promise<Bundle> {
	const response = await request(`${url}/api/data/export`, cookie === undefined ? {} : { cookie });
	expect(response.status).toBe(200);
	return JSON.parse(response.body) as Bundle;
}

async function importData(url: string, bundle: unknown, cookie?: string): Promise<void> {
	const response = await request(`${url}/api/data/import`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(bundle),
		...(cookie === undefined ? {} : { cookie }),
	});
	expect(response.status).toBe(200);
}

describe("moonan:data", () => {
	it("exports a codec-owned dataset and imports it into a fresh instance", async () => {
		const dir = await pluginDir(PLUGIN);
		const first = await appFor([dir]);
		await setValue(first.url, "hello");

		const exported = await exportData(first.url);
		expect(exported.format).toBe("moonan.data");
		expect(exported.datasets).toContainEqual({
			namespace: "test.data",
			version: 1,
			value: "hello",
		});

		const second = await appFor([dir]);
		await importData(second.url, exported);
		expect(await readValue(second.url)).toBe("hello");
	});

	it("rejects an unknown dataset without changing the existing value", async () => {
		const dir = await pluginDir(PLUGIN);
		const app = await appFor([dir]);
		await setValue(app.url, "keep");

		const response = await request(`${app.url}/api/data/import`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				format: "moonan.data",
				formatVersion: 1,
				createdAt: new Date().toISOString(),
				revision: 1,
				datasets: [{ namespace: "missing/data", version: 1, value: "x" }],
			}),
		});
		expect(response.status).toBe(400);
		expect(await readValue(app.url)).toBe("keep");
	});

	it("exposes the unified data database through the platform status surface", async () => {
		const dir = await pluginDir(PLUGIN);
		const app = await appFor([dir]);
		const status = JSON.parse((await request(`${app.url}/api/data/status`)).body) as {
			database: string;
			datasets: number;
			schemaVersion: number;
		};
		expect(status.database).toBe(app.dataDb);
		expect(status.datasets).toBe(0);
		// The owner partition is data schema version 2 (DataStore itself is contract v3).
		expect(status.schemaVersion).toBe(2);
	});

	it("stamps the signed-in user on plugin routes", async () => {
		const dir = await pluginDir(PLUGIN);
		const app = await appFor([dir]);

		const admin = await authStatus(app.url);
		expect(admin.user).toBeDefined();
		const adminPrincipal = await principalOf(app.url);
		expect(adminPrincipal).toMatchObject({
			kind: "user",
			username: "admin",
			owner: `user:${admin.user!.id}`,
		});

		const bob = await createUser(app, { username: "bob" });
		const bobCookie = await loginAs(app, "bob");
		const bobPrincipal = await principalOf(app.url, bobCookie);
		expect(bobPrincipal).toMatchObject({
			kind: "user",
			username: "bob",
			owner: `user:${bob.id}`,
		});
		expect(bobPrincipal.owner).not.toBe(adminPrincipal.owner);
	});

	it("keeps every signed-in account's dataset separate for read, export and import", async () => {
		const dir = await pluginDir(PLUGIN);
		const app = await appFor([dir]);
		const admin = await authStatus(app.url);
		const bob = await createUser(app, { username: "bob" });
		const bobCookie = await loginAs(app, "bob");

		await setValue(app.url, "admin-value");
		await setValue(app.url, "bob-value", bobCookie);

		// Same namespace, two owners: each session reads its own value.
		expect(await readValue(app.url)).toBe("admin-value");
		expect(await readValue(app.url, bobCookie)).toBe("bob-value");

		const adminBundle = await exportData(app.url);
		expect(adminBundle.datasets).toEqual([{ namespace: "test.data", version: 1, value: "admin-value" }]);
		const bobBundle = await exportData(app.url, bobCookie);
		expect(bobBundle.datasets).toEqual([{ namespace: "test.data", version: 1, value: "bob-value" }]);

		// An import lands in the importer's own partition, never in someone else's.
		await importData(app.url, bobBundle, bobCookie);
		expect(await readValue(app.url)).toBe("admin-value");
		expect(await readValue(app.url, bobCookie)).toBe("bob-value");

		const adminOwner = admin.user!.id;
		expect(await principalOf(app.url)).toMatchObject({ owner: `user:${adminOwner}` });
		expect(await principalOf(app.url, bobCookie)).toMatchObject({ owner: `user:${bob.id}` });
	});

	it("refuses a non-function update callback from a local caller", async () => {
		const dir = await pluginDir(PLUGIN);
		const app = await appFor([dir]);
		const store = await app.host.get(DataStore, {});
		try {
			// The callback has no JSON representation; it only works because DataStore is a
			// local object. A caller that sends something else gets a Chord error, not a crash.
			await app.host.root(async (ctx) => {
				await expect(
					store.update({ owner: "user:test", namespace: "x/data", version: 1, update: null }, ctx),
				).rejects.toMatchObject({ code: "invalid", reason: "args" });
			});
		} finally {
			store.release();
		}
	});
});
