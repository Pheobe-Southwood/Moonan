import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHost, hostNamed, method, remote, webSocketLink } from "@earendil-works/chord";
import { Type } from "typebox";
import { createMoonan, type Moonan } from "@moonan_ai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { builtinPlugins, VERSION } from "../src/plugins/index.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

/** Same name, version and members as the plugin's copy: descriptions must match. */
const HelloContract = remote("test.hello", {
	version: 1,
	input: Type.Object({}),
	host: hostNamed("moonan"),
	variants: {
		v1: {
			state: { count: Type.Number() },
			methods: { bump: method() },
		},
	},
});

const PLUGIN = `
import { readFileSync } from "node:fs";
import { defineFacet, hostNamed, method, remote } from "@earendil-works/chord";
import { Type } from "typebox";

export const Hello = remote("test.hello", {
	version: 1,
	input: Type.Object({}),
	host: hostNamed("moonan"),
	variants: {
		v1: {
			state: { count: Type.Number() },
			methods: { bump: method() },
		},
	},
});

export default defineFacet((api) => {
	api.serve(Hello, (_input, _principal, self) => {
		// Read at factory time: a reload re-runs the factory over the kept cells, so
		// changing this file proves which code version is answering.
		const step = Number(readFileSync(new URL("./step.txt", import.meta.url), "utf8").trim());
		const count = self.state("count", Type.Number(), 0);
		return {
			variant: "v1",
			count,
			bump: (ctx) => {
				count.change(ctx, (value) => value + step);
			},
		};
	});
});
`;

let dataDir: string;
let moonan: Moonan;
let host: ReturnType<typeof createHost>;
let socket: WebSocket;
let serverPath: string;

async function waitFor<T>(probe: () => T | undefined | false, timeoutMs = 15_000, label = "condition"): Promise<T> {
	const started = Date.now();
	for (;;) {
		const value = probe();
		if (value) return value;
		if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

beforeAll(async () => {
	dataDir = await mkdtemp(join(packageRoot, ".tmp-hot-reload-"));
	const dir = join(dataDir, "plugins", "hello");
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, "plugin.json"),
		JSON.stringify({ id: "hello", name: "Hello", version: "1.0.0", server: "server.mjs" }),
	);
	serverPath = join(dir, "server.mjs");
	await writeFile(serverPath, PLUGIN);
	await writeFile(join(dir, "step.txt"), "1");

	moonan = await createMoonan({ dataDir, port: 0, version: VERSION, builtinPlugins: builtinPlugins() });
	socket = new WebSocket(`ws://127.0.0.1:${moonan.port}/ws`);
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("websocket failed")), { once: true });
	});
	host = createHost({ kind: "client", self: { id: "test" } });
	host.connect(webSocketLink(socket as never), { principal: { id: "test" } });
}, 60_000);

afterAll(async () => {
	await host?.close().catch(() => undefined);
	socket?.close();
	await moonan?.close().catch(() => undefined);
	await rm(dataDir, { recursive: true, force: true });
});

describe("hot reload", () => {
	it("serves a disk plugin and keeps its state across a reload", async () => {
		const ref = await host.get(HelloContract, {});
		expect(ref.count.value).toBe(0);
		await ref.bump();
		await waitFor(() => ref.count.value === 1, 5_000, "the first bump");

		await writeFile(join(dataDir, "plugins", "hello", "step.txt"), "10");
		const report = (await moonan.chordHost.reload([serverPath])) as { codeVersion: number; changed: string[] };
		expect(report.codeVersion).toBeGreaterThan(0);
		expect(report.changed).toContain("test.hello");

		// Same object, same cell, new code: the value survives and the new code runs.
		expect(ref.count.value).toBe(1);
		await ref.bump();
		await waitFor(() => ref.count.value === 11, 10_000, "the new code's bump");
	}, 60_000);

	it("keeps the app contract and the plugin list after a reload", async () => {
		const { AppContract } = await import("@moonan_ai/contracts");
		const app = await moonan.chordHost.get(AppContract, {});
		// Panels are a browser concern now: the kernel only reports which plugins loaded.
		expect("panels" in app).toBe(false);
		expect(app.plugins.value.map((plugin) => plugin.id)).toContain("chat");
		expect(app.plugins.value.some((plugin) => plugin.id === "hello")).toBe(true);

		await moonan.chordHost.reload([serverPath]);
		const again = await moonan.chordHost.get(AppContract, {});
		expect(again.plugins.value.map((plugin) => plugin.id)).toContain("chat");
	}, 60_000);
});
