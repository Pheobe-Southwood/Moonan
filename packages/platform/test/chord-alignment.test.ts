import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hostNamed, method, remote } from "@earendil-works/chord";
import { Manifest } from "@moonan_ai/sdk";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { appFor, cleanup, closeClient, connectClient, pluginDir, post, wsUrl } from "./support.js";

const C1_SERVER = `
import { ChordError, Routes, Type, defineFacet, local } from "@moonan_ai/sdk";

const Root = local("test.flaky", { version: 1, input: Type.Object({}), members: {} });
let getCalls = 0;
let postCalls = 0;

function send(response, text) {
	response.writeHead(200, { "content-type": "text/plain" });
	response.end(text);
}

export default defineFacet((api) => {
	api.serve(Root, (_input, _principal, self) => {
		self.register(Routes, {
			"GET /api/flaky": (_request, response) => {
				getCalls += 1;
				if (getCalls === 1) throw new ChordError("upgrade_conflict", "gate");
				send(response, String(getCalls));
			},
			"POST /api/flaky": (_request, response) => {
				postCalls += 1;
				if (postCalls === 1) throw new ChordError("upgrade_conflict", "gate");
				send(response, String(postCalls));
			},
			"GET /api/bad": () => {
				throw new ChordError("invalid", "bad");
			},
		});
		return {};
	}, { lifetime: "host" });
});
`;

const DEV_SERVER = `
import { Routes, Type, defineFacet, local } from "@moonan_ai/sdk";

const Root = local("test.dev", { version: 1, input: Type.Object({}), members: {} });

export default defineFacet((api) => {
	api.serve(Root, (_input, _principal, self) => {
		const value = self.state("value", Type.Object({ n: Type.Number() }), { n: 0 });
		self.register(Routes, {
			"GET /api/dev-write": (_request, response, ctx) => {
				value.change(ctx, (draft) => {
					draft.n = "wrong";
				});
				response.writeHead(200);
				response.end("ok");
			},
		});
		return {};
	}, { lifetime: "host" });
});
`;

const REMOVABLE_SERVER = `
import { Routes, Type, defineFacet, hostNamed, local, method, remote } from "@moonan_ai/sdk";

const Removable = remote("test.removable", {
	version: 1,
	input: Type.Object({}),
	host: hostNamed("moonan"),
	variants: {
		v1: {
			state: { n: Type.Number() },
			methods: { noop: method() },
		},
	},
});

const Root = local("test.removable.root", { version: 1, input: Type.Object({}), members: {} });

export default defineFacet((api) => {
	api.serve(Removable, (_input, _principal, self) => {
		const n = self.state("n", Type.Number(), 1);
		return { variant: "v1", n, noop: () => {} };
	});
	api.serve(Root, (_input, _principal, self) => {
		self.register(Routes, {
			"GET /api/removable": (_request, response) => {
				response.writeHead(200);
				response.end("ok");
			},
		});
		return {};
	}, { lifetime: "host" });
});
`;

const B1_SERVER = `
import { Type, defineFacet, local } from "@moonan_ai/sdk";

const Root = local("test.b1", { version: 1, input: Type.Object({}), members: {} });

export default defineFacet((api) => {
	api.serve(Root, () => ({}), { lifetime: "host" });
});
`;

const Removable = remote("test.removable", {
	version: 1,
	input: Type.Object({}),
	host: hostNamed("moonan"),
	variants: {
		v1: {
			state: { n: Type.Number() },
			methods: { noop: method() },
		},
	},
});

afterEach(cleanup);

describe("official alignment: C1 retryable roots", () => {
	it("retries an idempotent request as a new root", async () => {
		const app = await appFor([await pluginDir(C1_SERVER)]);
		const response = await fetch(`${app.url}/api/flaky`);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("2");
	});

	it("answers a non-idempotent retryable request with 503 and Retry-After", async () => {
		const app = await appFor([await pluginDir(C1_SERVER)]);
		const response = await post(`${app.url}/api/flaky`);
		expect(response.status).toBe(503);
		expect(response.retryAfter).toBe("1");
		const body = JSON.parse(response.body) as { code?: string; retryable?: boolean };
		expect(body.code).toBe("upgrade_conflict");
		expect(body.retryable).toBe(true);
	});

	it("keeps non-retryable chord errors at 500", async () => {
		const app = await appFor([await pluginDir(C1_SERVER)]);
		const response = await fetch(`${app.url}/api/bad`);
		expect(response.status).toBe(500);
		expect((await response.json()) as { code?: string }).toMatchObject({ code: "invalid" });
	});
});

describe("official alignment: C2 origin policy", () => {
	it("refuses a cross-origin websocket and the cross-origin reload endpoint", async () => {
		const app = await appFor([]);

		const denied = new WebSocket(wsUrl(app), { origin: "http://evil.example" });
		const closed = new Promise<boolean>((resolve) => {
			denied.once("close", () => resolve(true));
			denied.once("error", () => undefined); // the close event follows
		});
		await expect(closed).resolves.toBe(true);

		const deniedPost = await post(`${app.url}/api/plugins/reload`, "http://evil.example");
		expect(deniedPost.status).toBe(403);

		const sameOrigin = await post(`${app.url}/api/plugins/reload`, app.url);
		expect(sameOrigin.status).toBe(200);

		const noOrigin = await post(`${app.url}/api/plugins/reload`);
		expect(noOrigin.status).toBe(200);
	});

	it("serves a same-origin browser and an explicitly allowed origin", async () => {
		const app = await appFor([]);
		const same = await connectClient(app, app.url);
		try {
			const manifest = await same.client.get(Manifest, {});
			expect(manifest.version.value).toEqual(expect.any(String));
			manifest.release();
		} finally {
			await closeClient(same.socket, same.client);
		}

		const allowedApp = await appFor([], { allowedOrigins: ["http://allowed.example"] });
		const allowed = await connectClient(allowedApp, "http://allowed.example");
		try {
			const manifest = await allowed.client.get(Manifest, {});
			expect(manifest.facets.value).toEqual(expect.any(Array));
			manifest.release();
		} finally {
			await closeClient(allowed.socket, allowed.client);
		}
	});
});

describe("official alignment: C3 dev validation", () => {
	it("validates cell writes only when dev is enabled", async () => {
		const devApp = await appFor([await pluginDir(DEV_SERVER)], { dev: true });
		const devResponse = await fetch(`${devApp.url}/api/dev-write`);
		expect(devResponse.status).toBe(500);
		expect((await devResponse.json()) as { code?: string }).toMatchObject({ code: "invalid" });

		const prodApp = await appFor([await pluginDir(DEV_SERVER)], { dev: false });
		const prodResponse = await fetch(`${prodApp.url}/api/dev-write`);
		expect(prodResponse.status).toBe(200);
	});
});

describe("official alignment: C5 removed facets", () => {
	it("removes a deleted server facet, releases its references, and reports the removed types", async () => {
		const dir = await pluginDir(REMOVABLE_SERVER);
		const app = await appFor([dir]);
		const { socket, client } = await connectClient(app);
		try {
			const removable = await client.get(Removable, {});
			expect(removable.n.value).toBe(1);
			const gone = new Promise<void>((resolve) => {
				if (removable.status === "gone") {
					resolve();
					return;
				}
				removable.onStatus((status) => {
					if (status === "gone") resolve();
				});
			});

			await rm(join(dir, "server.mjs"));
			const response = await post(`${app.url}/api/plugins/reload`);
			expect(response.status).toBe(200);
			const body = JSON.parse(response.body) as { report?: { removed?: string[] } };
			expect(body.report?.removed).toEqual(
				expect.arrayContaining(["test.removable", "test.removable.root"]),
			);

			await expect(
				Promise.race([
					gone,
					new Promise((_resolve, reject) =>
						setTimeout(() => reject(new Error("reference did not become gone")), 3_000),
					),
				]),
			).resolves.toBeUndefined();

			const route = await fetch(`${app.url}/api/removable`);
			expect(route.status).toBe(404);

			const plugins = (await (await fetch(`${app.url}/api/plugins`)).json()) as {
				plugins: { error?: string }[];
			};
			expect(plugins.plugins[0]?.error).toMatch(/no facet entry/);
		} finally {
			await closeClient(socket, client);
		}
	});
});

describe("official alignment: B1 failed reload", () => {
	it("does not publish a manifest reset when the reload is refused", async () => {
		const dir = await pluginDir(B1_SERVER);
		const app = await appFor([dir]);
		const { socket, client } = await connectClient(app);
		try {
			const manifest = await client.get(Manifest, {});
			const events: string[] = [];
			const stop = manifest.facets.events((event) => events.push(event.type));
			expect(events).toEqual(["snap"]);

			await writeFile(join(dir, "server.mjs"), 'export default { setup() { throw new Error("boom"); } };');
			const response = await post(`${app.url}/api/plugins/reload`);
			expect(response.status).toBe(400);

			await new Promise((resolve) => setTimeout(resolve, 200));
			// A refused reload keeps the old code; publishing a new snapshot would tell every
			// browser that a commit happened.
			expect(events).toEqual(["snap"]);

			stop();
			manifest.release();
		} finally {
			await closeClient(socket, client);
		}
	});
});
