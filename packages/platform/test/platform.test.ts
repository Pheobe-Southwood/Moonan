import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Manifest, type FacetSetEntry } from "@moonan_ai/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Moonan } from "../src/index.js";
import { silentLogger } from "../src/logger.js";
import { createPlatform } from "../src/platform.js";
import { resolvePluginRef } from "../src/plugins.js";
import { appFor, cleanup, closeClient, connectClient, pluginDir, tempDir } from "./support.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const clockDir = join(root, "examples", "clock-plugin");

let moonan: Moonan;

interface PluginsResponse {
	experimental: boolean;
	revision: number;
	plugins: FacetSetEntry[];
}

beforeAll(async () => {
	moonan = await appFor([clockDir]);
});

afterAll(cleanup);

describe("the platform", () => {
	it("loads a directory plugin and publishes its facets", async () => {
		const body = (await (await fetch(`${moonan.url}/api/plugins`)).json()) as PluginsResponse;
		expect(body.experimental).toBe(true);
		const clock = body.plugins.find((plugin) => plugin.name === "clock-plugin");
		expect(clock).toBeDefined();
		expect("id" in clock!).toBe(false);
		expect(clock?.error).toBeUndefined();
		expect(clock?.web?.url).toMatch(/^\/facets\/[0-9a-f]{12}\/web\.js$/);
		expect(clock?.source).toBe("directory");
	});

	it("serves the plugin's HTTP route from the Routes registry", async () => {
		const response = await fetch(`${moonan.url}/api/clock`);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { now: number; label: string };
		expect(typeof body.now).toBe("number");
		expect(body.label).toMatch(/^\d{2}:\d{2}:\d{2}$/);
	});

	it("refuses to read outside a facet's directory", async () => {
		const body = (await (await fetch(`${moonan.url}/api/plugins`)).json()) as PluginsResponse;
		const clock = body.plugins.find((plugin) => plugin.name === "clock-plugin");
		const base = clock!.web!.url.replace(/web\.js$/, "");
		// The segment is percent-encoded so `new URL` cannot normalise it away before we see it.
		const response = await fetch(`${moonan.url}${base}..%2f..%2fpackage.json`);
		expect(response.status).not.toBe(200);
	});

	it("does not fall through to a 200 for an unknown facet", async () => {
		const response = await fetch(`${moonan.url}/facets/nope/web.js`);
		expect(response.status).toBe(404);
	});

	it("reloads every server facet in one batch", async () => {
		const before = ((await (await fetch(`${moonan.url}/api/plugins`)).json()) as PluginsResponse).revision;
		const response = await fetch(`${moonan.url}/api/plugins/reload`, { method: "POST" });
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			ok: boolean;
			reloadBrowser: boolean;
			revision: number;
			report?: { codeVersion: number };
		};
		expect(body.ok).toBe(true);
		// The clock's server facet is reloaded, but its web file is unchanged. The browser
		// must not reload on a server-only code-version bump.
		expect(body.reloadBrowser).toBe(false);
		expect(body.revision).toBeGreaterThan(before);
		expect(body.report?.codeVersion).toBe(body.revision);
	});

	it("reports a resolution failure without taking the others down", async () => {
		const platform = await createPlatform({
			version: "test",
			plugins: [join(root, "does-not-exist"), clockDir],
			logger: silentLogger,
		});
		try {
			const broken = platform.plugins.find((plugin) => plugin.ref.includes("does-not-exist"));
			expect(broken?.error).toMatch(/no such directory/);
			const clock = platform.plugins.find((plugin) => plugin.name === "clock-plugin");
			expect(clock?.serverInstalled).toBe(true);
		} finally {
			await platform.close();
		}
	});

	it("installs every facet before activating any host object", async () => {
		// The consumer's host object consumes a type that the *later* plugin serves. chord's
		// `load` installs the whole batch before it activates host objects; loading one URL at
		// a time would fail here with `unavailable/unknown_type`, decided by argument order.
		// The consumer also declares `uses: [Shared]`, the facet-level statement of the same
		// dependency: on a reload chord checks that the new provider still covers it.
		const consumerDir = await pluginDir(
			`import { Type, defineFacet, local, method } from "@moonan_ai/sdk";
const Shared = local("test.shared", { version: 1, input: Type.Object({}), members: { ping: method() } });
const Consumer = local("test.consumer", { version: 1, input: Type.Object({}), members: { ping: method() } });
export default defineFacet((api) => {
	api.serve(Consumer, (_input, _principal, self) => {
		const shared = self.get(Shared, {});
		return { ping: (ctx) => shared.ping(ctx) };
	}, { lifetime: "host" });
}, { uses: [Shared] });
`,
		);
		const providerDir = await pluginDir(
			`import { Type, defineFacet, local, method } from "@moonan_ai/sdk";
const Shared = local("test.shared", { version: 1, input: Type.Object({}), members: { ping: method() } });
export default defineFacet((api) => {
	api.serve(Shared, () => ({ ping: () => "pong" }), { lifetime: "host" });
});
`,
		);

		const platform = await createPlatform({
			version: "test",
			plugins: [consumerDir, providerDir],
			logger: silentLogger,
		});
		try {
			// Both resolved and activated: the consumer's host object reached a type the
			// later plugin serves, so the batch really installed before activating.
			expect(platform.plugins.map((plugin) => plugin.error)).toEqual([undefined, undefined]);
			expect(platform.plugins.map((plugin) => plugin.serverInstalled)).toEqual([true, true]);
		} finally {
			await platform.close();
		}
	});

	it("reloads a breaking provider and its consumer together", async () => {
		const version = 1;
		const consumer = (v: number) => `import { Type, defineFacet, local, method } from "@moonan_ai/sdk";
const Shared = local("test.shared", { version: ${v}, input: Type.Object({}), members: { ping: method() } });
const Consumer = local("test.consumer", { version: 1, input: Type.Object({}), members: { ping: method() } });
export default defineFacet((api) => {
	api.serve(Consumer, (_input, _principal, self) => {
		const shared = self.get(Shared, {});
		return { ping: (ctx) => shared.ping(ctx) };
	}, { lifetime: "host" });
}, { uses: [Shared] });
`;
		const provider = (v: number) => `import { Type, defineFacet, local, method } from "@moonan_ai/sdk";
const Shared = local("test.shared", { version: ${v}, input: Type.Object({}), members: { ping: method() } });
export default defineFacet((api) => {
	api.serve(Shared, () => ({ ping: () => "pong" }), { lifetime: "host" });
});
`;
		const consumerDir = await pluginDir(consumer(version));
		const providerDir = await pluginDir(provider(version));

		const platform = await createPlatform({
			version: "test",
			plugins: [consumerDir, providerDir],
			logger: silentLogger,
		});
		try {
			const before = platform.revision;
			await writeFile(join(consumerDir, "server.mjs"), consumer(version + 1));
			await writeFile(join(providerDir, "server.mjs"), provider(version + 1));
			const report = await platform.reload();
			expect(report).toBeDefined();
			expect(platform.revision).toBe(before + 1);
			// Both files are in the batch: a breaking contract is not rejected just because the
			// provider's module came first.
			expect(report?.changed.length).toBeGreaterThan(0);
		} finally {
			await platform.close();
		}
	});

	it("lets a plugin resolve chord from its own tree, and fails startup on the import", async () => {
		// No process-wide shim: bare specifiers resolve from the plugin's own tree, like any Node
		// module. The fixture ships its own copy of chord that throws, so a copy forced by the
		// platform would show up here; this asserts the platform adds no copy of its own.
		const dir = await tempDir(".own-deps-");
		const own = join(dir, "node_modules", "@earendil-works", "chord");
		await mkdir(own, { recursive: true });
		await writeFile(
			join(own, "package.json"),
			JSON.stringify({ name: "@earendil-works/chord", version: "0.0.0", type: "module", exports: "./index.js" }),
		);
		await writeFile(join(own, "index.js"), 'throw new Error("the plugin imports its own chord");\n');
		await writeFile(join(dir, "server.mjs"), 'import "@earendil-works/chord";\nexport default { setup() {} };\n');

		await expect(createPlatform({ version: "test", plugins: [dir, clockDir], logger: silentLogger })).rejects.toThrow(
			/the plugin imports its own chord/,
		);
	});

	it("fails startup when a server facet throws during setup", async () => {
		const dir = await tempDir(".broken-");
		await writeFile(
			join(dir, "server.mjs"),
			`import { Type, defineFacet, local, method } from "@moonan_ai/sdk";
const Angry = local("test.angry", { version: 1, input: Type.Object({}), members: { ping: method() } });
export default defineFacet((api) => {
	api.serve(Angry, () => ({ ping: () => "ok" }), { lifetime: "host" });
	throw new Error("setup said no");
});
`,
		);

		// chord's install is not a rollback transaction: continuing would leave Angry's
		// service behind. The platform closes the host and refuses to start instead.
		await expect(createPlatform({ version: "test", plugins: [dir], logger: silentLogger })).rejects.toThrow(
			/setup said no/,
		);
	});

	it("starts with a web-only plugin and serves its facet", async () => {
		const dir = await tempDir(".web-only-");
		await writeFile(join(dir, "web.js"), "export default { setup() {} };\n");
		const app = await appFor([dir]);
		try {
			const plugin = app.plugins[0];
			expect(plugin?.server).toBeUndefined();
			expect(plugin?.web?.url).toMatch(/^\/facets\/[0-9a-f]{12}\/web\.js$/);
			expect(plugin?.error).toBeUndefined();
			expect(plugin?.serverInstalled).toBeFalsy();
			const response = await fetch(`${app.url}${plugin?.web?.url}`);
			expect(response.status).toBe(200);
			expect(await response.text()).toMatch(/setup/);
		} finally {
			await app.close();
		}
	});

	it("installs the manifest facet in the same batch, so a plugin host object can consume it", async () => {
		const dir = await tempDir(".manifest-batch-");
		await writeFile(
			join(dir, "server.mjs"),
			`import { Manifest, Type, defineFacet, local, method } from "@moonan_ai/sdk";
const Probe = local("test.probe", { version: 1, input: Type.Object({}), members: { revision: method(undefined, Type.Number()) } });
export default defineFacet((api) => {
	api.serve(Probe, (_input, _principal, self) => {
		const manifest = self.get(Manifest, {});
		return { revision: () => manifest.revision.value };
	}, { lifetime: "host" });
}, { uses: [Manifest] });
`,
		);

		const platform = await createPlatform({ version: "test", plugins: [dir], logger: silentLogger });
		try {
			// The assertion is that startup resolved: if the manifest facet were installed after
			// the plugin batch, Probe's activation would fail with `unknown_type`.
			expect(platform.plugins[0]?.serverInstalled).toBe(true);
		} finally {
			await platform.close();
		}
	});

	it("reloads a web-only plugin's facet when its content hash changes", async () => {
		const dir = await tempDir(".webhash-");
		await writeFile(join(dir, "web.js"), "export default { setup() {} };\n");
		const app = await appFor([dir]);
		try {
			const beforeHash = app.plugins[0]?.web?.hash;
			expect(beforeHash).toMatch(/^[0-9a-f]{12}$/);
			await writeFile(join(dir, "web.js"), "// changed\nexport default { setup() {} };\n");
			const response = await fetch(`${app.url}/api/plugins/reload`, { method: "POST" });
			expect(response.status).toBe(200);
			const body = (await response.json()) as { reloadBrowser: boolean; revision: number };
			expect(body.reloadBrowser).toBe(true);
			// A web-only change has no server commit; the code version is unchanged.
			expect(body.revision).toBe(app.revision);
			const afterHash = app.plugins[0]?.web?.hash;
			expect(afterHash).not.toBe(beforeHash);
		} finally {
			await app.close();
		}
	});

	it("aborts a route's ctx when the client disconnects", async () => {
		const dir = await tempDir(".abort-");
		const started = join(dir, "started");
		const aborted = join(dir, "aborted");
		await writeFile(
			join(dir, "server.mjs"),
			`import { writeFileSync } from "node:fs";
import { Routes, Type, defineFacet, local } from "@moonan_ai/sdk";
const Root = local("test.abort", { version: 1, input: Type.Object({}), members: {} });
const started = ${JSON.stringify(started)};
const aborted = ${JSON.stringify(aborted)};
export default defineFacet((api) => {
	api.serve(Root, (_input, _principal, self) => {
		self.register(Routes, {
			"GET /hang": async (_request, _response, ctx) => {
				writeFileSync(started, "started");
				await new Promise((resolve) => {
					if (ctx.signal.aborted) return resolve();
					ctx.signal.addEventListener("abort", () => {
						writeFileSync(aborted, "aborted");
						resolve();
					}, { once: true });
				});
			},
		});
		return {};
	}, { lifetime: "host" });
});
`,
		);
		const app = await appFor([dir]);
		try {
			const controller = new AbortController();
			const request = fetch(`${app.url}/hang`, { signal: controller.signal });
			let seen = false;
			for (let i = 0; i < 40; i += 1) {
				try {
					if ((await readFile(started, "utf8")) === "started") {
						seen = true;
						break;
					}
				} catch {
					await new Promise((resolve) => setTimeout(resolve, 25));
				}
			}
			expect(seen).toBe(true);
			controller.abort();
			await expect(request).rejects.toBeDefined();
			let content: string | undefined;
			for (let i = 0; i < 40; i += 1) {
				try {
					content = await readFile(aborted, "utf8");
					break;
				} catch {
					await new Promise((resolve) => setTimeout(resolve, 25));
				}
			}
			expect(content).toBe("aborted");
		} finally {
			await app.close();
		}
	});

	it("answers unknown /api paths with JSON 404, not the shell", async () => {
		const response = await fetch(`${moonan.url}/api/not-a-route`);
		expect(response.status).toBe(404);
		expect(response.headers.get("content-type")).toMatch(/application\/json/);
		expect(await response.json()).toEqual({ error: "not found" });
	});

	it("resolves package plugins from the working directory", async () => {
		const project = await tempDir(".pkg-");
		const pkgDir = join(project, "node_modules", "fake-plugin");
		await mkdir(pkgDir, { recursive: true });
		await writeFile(
			join(pkgDir, "package.json"),
			JSON.stringify({
				name: "fake-plugin",
				version: "1.2.3",
				type: "module",
				exports: { ".": "./index.js", "./web": "./web.js" },
			}),
		);
		await writeFile(join(pkgDir, "index.js"), "export default { setup() {} };\n");
		await writeFile(join(pkgDir, "web.js"), "export default { setup() {} };\n");
		const plugin = resolvePluginRef("fake-plugin", project);
		expect(plugin.error).toBeUndefined();
		expect(plugin.version).toBe("1.2.3");
		expect(plugin.server).toMatch(/node_modules\/fake-plugin\/index\.js$/);
		expect(plugin.web?.url).toMatch(/^\/facets\/[0-9a-f]{12}\/web\.js$/);
		expect(plugin.web?.hash).toMatch(/^[0-9a-f]{12}$/);
	});

	it("honors a parent package scope when a directory plugin uses .js", async () => {
		const parent = await tempDir(".scope-");
		await writeFile(join(parent, "package.json"), JSON.stringify({ type: "module" }));
		const entry = join(parent, "plugin");
		await mkdir(entry, { recursive: true });
		await writeFile(join(entry, "server.js"), "export default { setup() {} };\n");
		const plugin = resolvePluginRef(entry, parent);
		expect(plugin.error).toBeUndefined();
		expect(plugin.server).toMatch(/plugin\/server\.js$/);
	});

	it("converges every manifest instance on the new revision", async () => {
		const current = (await (await fetch(`${moonan.url}/api/plugins`)).json()) as PluginsResponse;
		const { socket, client } = await connectClient(moonan);
		// chord keys objects by principal, so this is a different object from the browser's:
		// the fan-out has to reach both, and neither is written by iterating a list here.
		const hostManifest = await moonan.host.get(Manifest, {});
		try {
			const manifest = await client.get(Manifest, {});
			expect(manifest.version.value).toEqual(expect.any(String));
			expect((manifest.facets.value as FacetSetEntry[]).map((facet) => facet.name)).toContain("clock-plugin");
			const before = manifest.revision.value as number;
			// A new instance starts at the current revision, not at zero: otherwise every
			// reconnect would look like a code change and make the shell reload for nothing.
			expect(before).toBe(current.revision);
			expect(hostManifest.revision.value).toBe(before);
			const watch = (ref: typeof manifest, from: number) =>
				new Promise<number>((resolve) => {
					const stop = ref.revision.subscribe((value: number) => {
						if (value > from) {
							stop();
							resolve(value);
						}
					});
				});
			const seen = watch(manifest, before);
			const hostSeen = watch(hostManifest, before);
			const response = await fetch(`${moonan.url}/api/plugins/reload`, { method: "POST" });
			expect(response.status).toBe(200);
			const body = (await response.json()) as { revision: number };
			expect(body.revision).toBeGreaterThan(before);
			// The response reports `host.codeVersion` directly — chord delivers a listener's
			// event through its publication queue, so the cells settle a moment later.
			await expect(seen).resolves.toBeGreaterThan(before);
			await expect(hostSeen).resolves.toBeGreaterThan(before);
			manifest.release();
		} finally {
			hostManifest.release();
			await closeClient(socket, client);
		}
	});
});
