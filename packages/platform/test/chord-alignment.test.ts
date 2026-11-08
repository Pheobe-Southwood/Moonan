import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHost, hostNamed, local, method, remote } from "@earendil-works/chord";
import { nodeLoader } from "@earendil-works/chord/node";
import { WebFacetCatalog, obj, num, str } from "@moonan_ai/sdk";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { appFor, cleanup, closeClient, connectClient, pluginDir, post, tempDir, wsUrl } from "./support.js";

const C1_SERVER = `
import { ChordError, Routes, defineFacet, local, obj, num, str } from "@moonan_ai/sdk";

const Root = local("test.flaky", { version: 1, input: obj({}, { open: true }), members: {} });
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
import { Routes, defineFacet, local, obj, num, str } from "@moonan_ai/sdk";

const Root = local("test.dev", { version: 1, input: obj({}, { open: true }), members: {} });

export default defineFacet((api) => {
	api.serve(Root, (_input, _principal, self) => {
		const value = self.state("value", obj({ n: num() }, { open: true }), { n: 0 });
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
import { Routes, defineFacet, hostNamed, local, method, remote, obj, num, str } from "@moonan_ai/sdk";

const Removable = remote("test.removable", {
	version: 1,
	input: obj({}, { open: true }),
	host: hostNamed("moonan"),
	variants: {
		v1: {
			state: { n: num() },
			methods: { noop: method() },
		},
	},
});

const Root = local("test.removable.root", { version: 1, input: obj({}, { open: true }), members: {} });

export default defineFacet((api) => {
	api.serve(Removable, (_input, _principal, self) => {
		const n = self.state("n", num(), 1);
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
import { defineFacet, local, obj, num, str } from "@moonan_ai/sdk";

const Root = local("test.b1", { version: 1, input: obj({}, { open: true }), members: {} });

export default defineFacet((api) => {
	api.serve(Root, () => ({}), { lifetime: "host" });
});
`;

const Removable = remote("test.removable", {
	version: 1,
	input: obj({}, { open: true }),
	host: hostNamed("moonan"),
	variants: {
		v1: {
			state: { n: num() },
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
			const catalog = await same.client.get(WebFacetCatalog, {});
			expect(catalog.version.value).toEqual(expect.any(String));
			catalog.release();
		} finally {
			await closeClient(same.socket, same.client);
		}

		const allowedApp = await appFor([], { allowedOrigins: ["http://allowed.example"] });
		const allowed = await connectClient(allowedApp, "http://allowed.example");
		try {
			const catalog = await allowed.client.get(WebFacetCatalog, {});
			expect(catalog.facets.value).toEqual(expect.any(Array));
			catalog.release();
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
	it("does not publish a catalog reset when the reload is refused", async () => {
		const dir = await pluginDir(B1_SERVER);
		const app = await appFor([dir]);
		const { socket, client } = await connectClient(app);
		try {
			const catalog = await client.get(WebFacetCatalog, {});
			const events: string[] = [];
			const stop = catalog.facets.events((event) => events.push(event.type));
			expect(events).toEqual(["snap"]);

			await writeFile(join(dir, "server.mjs"), 'export default { setup() { throw new Error("boom"); } };');
			const response = await post(`${app.url}/api/plugins/reload`);
			expect(response.status).toBe(400);

			await new Promise((resolve) => setTimeout(resolve, 200));
			// A refused reload keeps the old code; publishing a new snapshot would tell every
			// browser that a commit happened.
			expect(events).toEqual(["snap"]);

			stop();
			catalog.release();
		} finally {
			await closeClient(socket, client);
		}
	});
});

describe("official alignment: C6 client-local reload", () => {
	const ClientLocal = local("test.client-local", {
		version: 1,
		input: obj({}, { open: true }),
		members: { ping: method(undefined, str()) },
	});
	const clientFacet = (answer: string) => `import { defineFacet, local, method, obj, str } from "@moonan_ai/sdk";
const Local = local("test.client-local", { version: 1, input: obj({}, { open: true }), members: { ping: method(undefined, str()) } });
export default defineFacet((api) => {
	api.serve(Local, () => ({ ping: () => ${JSON.stringify(answer)} }), { lifetime: "host" });
});
`;

	it("reloads a client host's own facets without a parent link", async () => {
		// The browser shell reloads its facet set locally (`kind: "client"`). Chord does not
		// coordinate that through a parent, and its code version only moves on the client.
		const dir = await tempDir(".client-");
		const file = join(dir, "facet.mjs");
		await writeFile(file, clientFacet("v1"));
		const url = pathToFileURL(file).href;
		const client = createHost({
			kind: "client",
			self: { id: "browser" },
			loader: nodeLoader,
			onError: () => undefined,
		});
		try {
			await client.load([url]);
			const ref = await client.get(ClientLocal, {});
			try {
				expect(await ref.ping()).toBe("v1");
				const before = client.codeVersion;
				await writeFile(file, clientFacet("v2"));
				const report = await client.reload([url]);
				expect(report.codeVersion).toBe(client.codeVersion);
				expect(report.previous).toBe(before);
				expect(client.codeVersion).toBe(before + 1);
				expect(report.changed).toContain("test.client-local");
				// The held reference resolves members against the new code.
				expect(await ref.ping()).toBe("v2");
			} finally {
				ref.release();
			}
		} finally {
			await client.close().catch(() => undefined);
		}
	});
});
