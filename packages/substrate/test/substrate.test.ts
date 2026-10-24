import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHost, webSocketLink } from "@earendil-works/chord";
import { Manifest, type PluginEntry } from "@moonan_ai/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createSubstrate } from "../src/host.js";
import { start, type Moonan } from "../src/index.js";
import { silentLogger } from "../src/logger.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const clockDir = join(root, "examples", "clock-plugin");

let moonan: Moonan;
let pluginsDir: string;

beforeAll(async () => {
	pluginsDir = await mkdtemp(join(tmpdir(), "moonan-plugins-"));
	moonan = await start({
		port: 0,
		hostname: "127.0.0.1",
		plugins: [clockDir],
		pluginsDir,
		logger: silentLogger,
	});
});

afterAll(async () => {
	await moonan?.close();
	await rm(pluginsDir, { recursive: true, force: true });
});

describe("the substrate", () => {
	it("loads a directory plugin and publishes it in the manifest endpoint", async () => {
		const response = await fetch(`${moonan.url}/api/plugins`);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { experimental: boolean; plugins: PluginEntry[] };
		expect(body.experimental).toBe(true);
		const clock = body.plugins.find((plugin) => plugin.id === "clock");
		expect(clock).toBeDefined();
		expect(clock?.error).toBeUndefined();
		expect(clock?.web).toBe("/plugins/clock/web.js");
		expect(clock?.source).toBe("directory");
	});

	it("serves the plugin's HTTP route from the Routes registry", async () => {
		const response = await fetch(`${moonan.url}/api/clock`);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { now: number; label: string };
		expect(typeof body.now).toBe("number");
		expect(body.label).toMatch(/^\d{2}:\d{2}:\d{2}$/);
	});

	it("serves the browser facet as an importable module", async () => {
		const response = await fetch(`${moonan.url}/plugins/clock/web.js`);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toMatch(/javascript/);
		expect(await response.text()).toMatch(/defineFacet/);
	});

	it("refuses to read outside a plugin's directory", async () => {
		// The segment is percent-encoded so `new URL` cannot normalise it away before we see it.
		const response = await fetch(`${moonan.url}/plugins/clock/..%2f..%2fpackage.json`);
		expect(response.status).not.toBe(200);
	});

	it("does not fall through to a 200 for an unknown plugin", async () => {
		const response = await fetch(`${moonan.url}/plugins/nope/web.js`);
		expect(response.status).toBe(404);
	});

	it("gives a chord client the manifest over the websocket", async () => {
		const socket = new WebSocket(`${moonan.url.replace("http", "ws")}/ws`);
		// Connected before `open` on purpose: the server greets as soon as it accepts, and a
		// client that subscribes later loses that `hello`. See `connection.tsx` for what a
		// missing hello costs (no acknowledgements, so no flow control).
		const client = createHost({ kind: "client", self: { id: "browser" } });
		// `ws` speaks the structural WebSocketLike chord wants, event listeners included.
		client.connect(webSocketLink(socket as never), { principal: { id: "browser" } });
		await new Promise<void>((resolve, reject) => {
			socket.once("open", () => resolve());
			socket.once("error", (error) => reject(error));
		});
		try {
			const manifest = await client.get(Manifest, {});
			const entries = manifest.plugins.value as PluginEntry[];
			expect(entries.map((entry) => entry.id)).toContain("clock");
			expect(manifest.version.value).toEqual(expect.any(String));
			// What this proves: the handshake produced a link that still answers a second call a
			// moment later. It does not prove the ordering rule above — a client that missed the
			// hello stays connected, it just stops acknowledging (flow control), which no public
			// call surface exposes.
			await new Promise((resolve) => setTimeout(resolve, 150));
			expect(socket.readyState).toBe(WebSocket.OPEN);
			const again = await client.get(Manifest, {});
			expect(again.plugins.value.length).toBe(entries.length);
			again.release();
		} finally {
			await client.close().catch(() => undefined);
			socket.terminate();
		}
	});

	it("reloads one plugin by id", async () => {
		const response = await fetch(`${moonan.url}/api/plugins/reload`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: "clock" }),
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as { ok: boolean; reloadBrowser: boolean; revision: number; reloaded: string[] };
		expect(body.ok).toBe(true);
		expect(body.reloadBrowser).toBe(true);
		expect(body.revision).toBeGreaterThan(0);
		expect(body.reloaded).toContain("clock");
	});

	it("rejects a reload for an unknown plugin", async () => {
		const response = await fetch(`${moonan.url}/api/plugins/reload`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: "nope" }),
		});
		expect(response.status).toBe(400);
	});

	it("reports a broken plugin without taking the others down", async () => {
		const substrate = await createSubstrate({
			version: "test",
			plugins: [join(pluginsDir, "does-not-exist"), clockDir],
			logger: silentLogger,
		});
		try {
			const broken = substrate.plugins.find((plugin) => plugin.ref.includes("does-not-exist"));
			expect(broken?.error).toMatch(/no such directory/);
			const clock = substrate.plugins.find((plugin) => plugin.id === "clock");
			expect(clock?.loaded).toBe(true);
		} finally {
			await substrate.close();
		}
	});

	it("installs every facet before activating any host object", async () => {
		// The consumer's host object consumes a type that the *later* plugin serves. chord's
		// `load` installs the whole batch before it activates host objects; loading one URL at
		// a time would fail here with `unavailable/unknown_type`, decided by argument order.
		// The consumer also declares `uses: [Shared]`, the facet-level statement of the same
		// dependency: on a reload chord checks that the new provider still covers it.
		const dir = await mkdtemp(join(root, "packages", "substrate", ".batch-"));
		const write = async (name: string, text: string) => {
			await mkdir(join(dir, name), { recursive: true });
			await writeFile(join(dir, name, "server.mjs"), text);
			await writeFile(
				join(dir, name, "plugin.json"),
				JSON.stringify({ id: name, name, version: "0.0.0", server: "server.mjs" }),
			);
		};
		await write(
			"consumer",
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
		await write(
			"provider",
			`import { Type, defineFacet, local, method } from "@moonan_ai/sdk";
const Shared = local("test.shared", { version: 1, input: Type.Object({}), members: { ping: method() } });
export default defineFacet((api) => {
	api.serve(Shared, () => ({ ping: () => "pong" }), { lifetime: "host" });
});
`,
		);

		const substrate = await createSubstrate({
			version: "test",
			plugins: [join(dir, "consumer"), join(dir, "provider")],
			logger: silentLogger,
		});
		try {
			const consumer = substrate.plugins.find((plugin) => plugin.id === "consumer");
			const provider = substrate.plugins.find((plugin) => plugin.id === "provider");
			expect(provider?.loaded).toBe(true);
			expect(consumer?.error).toBeUndefined();
			expect(consumer?.loaded).toBe(true);
		} finally {
			await substrate.close();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("converges every manifest instance on the new code version", async () => {
		const current = (await (await fetch(`${moonan.url}/api/plugins`)).json()) as { revision: number };
		const socket = new WebSocket(`${moonan.url.replace("http", "ws")}/ws`);
		const client = createHost({ kind: "client", self: { id: "browser" } });
		client.connect(webSocketLink(socket as never), { principal: { id: "browser" } });
		await new Promise<void>((resolve, reject) => {
			socket.once("open", () => resolve());
			socket.once("error", (error) => reject(error));
		});
		// chord keys objects by principal, so this is a different object from the browser's:
		// the fan-out has to reach both, and neither is written by iterating a list here.
		const hostManifest = await moonan.host.get(Manifest, {});
		try {
			const manifest = await client.get(Manifest, {});
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
			const response = await fetch(`${moonan.url}/api/plugins/reload`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "clock" }),
			});
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
			await client.close().catch(() => undefined);
			socket.terminate();
		}
	});
});
