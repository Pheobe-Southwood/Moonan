import { afterEach, describe, expect, it } from "vitest";
import { appFor, cleanup, pluginDir } from "./support.js";

const PLUGIN = `
import { DataCodecs, DataStore, Routes, Type, defineFacet, local } from "@moonan_ai/sdk";

const Root = local("test.data-root", {
	version: 1,
	input: Type.Object({}),
	members: {},
});

export default defineFacet((api) => {
	api.serve(
		Root,
		(_input, _principal, self) => {
			const data = self.get(DataStore, {});
			const value = self.state("value", Type.String(), {
				init: async (ctx) => {
					const stored = await data.read({ namespace: "test.data" }, ctx);
					return stored === undefined ? "empty" : String(stored.value);
				},
			});

			self.register(DataCodecs, {
				"test.data": {
					namespace: "test.data",
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

			// Imports and explicit data reloads change the store revision; reconcile the projection.
			self.on("data-revision", data.revision, async (_revision, ctx) => {
				const stored = await data.read({ namespace: "test.data" }, ctx);
				const next = stored === undefined ? "empty" : String(stored.value);
				if (next !== value.value) value.replace(ctx, next);
			});

			self.register(Routes, {
				"GET /api/data-test": (_request, response) => {
					response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
					response.end(value.value);
				},
				"POST /api/data-test": async (request, response, ctx) => {
					let body = "";
					for await (const chunk of request) body += chunk;
					const next = String(JSON.parse(body).value ?? "");
					await data.update(
						{
							namespace: "test.data",
							version: 1,
							update: () => ({ value: next, version: 1 }),
						},
						ctx,
					);
					value.replace(ctx, next);
					response.writeHead(200);
					response.end("ok");
				},
			});

			return {};
		},
		{ lifetime: "host" },
	);
}, { uses: [DataStore] });
`;

afterEach(cleanup);

async function readValue(url: string): Promise<string> {
	return (await fetch(`${url}/api/data-test`)).text();
}

async function setValue(url: string, value: string): Promise<void> {
	const response = await fetch(`${url}/api/data-test`, {
		method: "POST",
		body: JSON.stringify({ value }),
	});
	expect(response.status).toBe(200);
}

describe("moonan:data", () => {
	it("exports a codec-owned dataset and imports it into a fresh instance", async () => {
		const dir = await pluginDir(PLUGIN);
		const first = await appFor([dir]);
		await setValue(first.url, "hello");

		const exported = (await (await fetch(`${first.url}/api/data/export`)).json()) as {
			format: string;
			datasets: { namespace: string; value: unknown }[];
		};
		expect(exported.format).toBe("moonan.data");
		expect(exported.datasets).toContainEqual({
			namespace: "test.data",
			version: 1,
			value: "hello",
		});

		const second = await appFor([dir]);
		const imported = await fetch(`${second.url}/api/data/import`, {
			method: "POST",
			body: JSON.stringify(exported),
		});
		expect(imported.status).toBe(200);
		expect(await readValue(second.url)).toBe("hello");
	});

	it("rejects an unknown dataset without changing the existing value", async () => {
		const dir = await pluginDir(PLUGIN);
		const app = await appFor([dir]);
		await setValue(app.url, "keep");

		const response = await fetch(`${app.url}/api/data/import`, {
			method: "POST",
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

	it("exposes the unified data file through the platform status surface", async () => {
		const dir = await pluginDir(PLUGIN);
		const app = await appFor([dir]);
		const status = (await (await fetch(`${app.url}/api/data/status`)).json()) as {
			file: string;
			datasets: number;
		};
		expect(status.file).toBe(app.dataFile);
		expect(status.datasets).toBe(0);
	});
});
