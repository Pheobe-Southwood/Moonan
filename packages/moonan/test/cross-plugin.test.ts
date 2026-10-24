import { cp, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { local, method } from "@earendil-works/chord";
import { createMoonan, type Moonan } from "@moonan_ai/core";
import { Type } from "typebox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * A third copy of the contract, written from scratch: chord identifies a contract by
 * its fingerprint (name + version + input schema + members), never by module identity.
 * If this copy could not talk to the two example plugins, cross-plugin contracts would
 * only work inside one package — which is exactly what disk plugins cannot have.
 */
const Greeting = local("example.greeting", {
	version: 1,
	input: Type.Object({}),
	members: {
		text: method(Type.Object({}), Type.String()),
	},
});

// Inside the package on purpose: Vitest skips the shared-module hooks, so a plugin in
// the OS temp dir could not resolve `@earendil-works/chord`. Real installs get the hooks.
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const examples = join(packageRoot, "..", "..", "examples");

let dataDir: string;
let moonan: Moonan;

beforeAll(async () => {
	dataDir = await mkdtemp(join(packageRoot, ".tmp-cross-plugin-"));
	const plugins = join(dataDir, "plugins");
	await cp(join(examples, "clock-plugin"), join(plugins, "clock"), { recursive: true });
	await cp(join(examples, "greeter-plugin"), join(plugins, "greeter"), { recursive: true });
	moonan = await createMoonan({ dataDir, port: 0, version: "test", builtinPlugins: [] });
}, 60_000);

afterAll(async () => {
	await moonan?.close().catch(() => undefined);
	await rm(dataDir, { recursive: true, force: true });
});

describe("cross-plugin contracts", () => {
	it("serves a contract that another plugin consumes", async () => {
		const greeting = await moonan.chordHost.get(Greeting, {});
		const text = String(await greeting.text());
		expect(text).toContain("你好，现在是");
		// The clock's value is an ISO timestamp, so the provider really answered.
		expect(text).toMatch(/\d{4}-\d{2}-\d{2}T/);
	}, 30_000);

	it("keeps working when the provider is reloaded", async () => {
		await moonan.chordHost.reload([join(dataDir, "plugins", "clock", "server.mjs")]);
		const greeting = await moonan.chordHost.get(Greeting, {});
		expect(String(await greeting.text())).toContain("你好，现在是");
	}, 30_000);
});
