import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanPlugins } from "@moonan_ai/core";
import type { Logger } from "@moonan_ai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const logged: string[] = [];
const logger: Logger = {
	info: (message) => logged.push(`info ${message}`),
	warn: (message) => logged.push(`warn ${message}`),
	error: (message) => logged.push(`error ${message}`),
	child: () => logger,
};

let root: string;

async function writePlugin(name: string, manifest: unknown, files: Record<string, string>): Promise<string> {
	const dir = join(root, name);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "plugin.json"), JSON.stringify(manifest));
	for (const [file, content] of Object.entries(files)) await writeFile(join(dir, file), content);
	return dir;
}

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "moonan-plugins-"));
});

afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("scanPlugins", () => {
	it("returns nothing for a missing directory", () => {
		expect(scanPlugins(join(root, "nope"), logger)).toEqual([]);
	});

	it("accepts an ESM plugin and fills in the defaults", async () => {
		const dir = await writePlugin("good", { name: "Good" }, { "server.mjs": "export default {}" });
		const [plugin] = scanPlugins(root, logger);
		expect(plugin).toMatchObject({ id: "good", name: "Good", version: "0.0.0", dir });
		expect(plugin?.server.startsWith("file:")).toBe(true);
		expect(plugin?.web).toBeUndefined();
	});

	it("rejects a .js server without type: module, and says why", async () => {
		logged.length = 0;
		await writePlugin("cjs", { id: "cjs" }, { "server.js": "module.exports = {}" });
		const found = scanPlugins(root, logger).map((plugin) => plugin.id);
		expect(found).not.toContain("cjs");
		expect(logged.join("\n")).toContain('has no package.json with "type": "module"');
	});

	it("accepts a .js server inside a type: module package", async () => {
		await writePlugin(
			"esm-js",
			{ id: "esm-js", server: "server.js" },
			{ "package.json": JSON.stringify({ type: "module" }), "server.js": "export default {}" },
		);
		expect(scanPlugins(root, logger).map((plugin) => plugin.id)).toContain("esm-js");
	});

	it("skips a plugin whose entry file is missing", async () => {
		logged.length = 0;
		await writePlugin("broken", { id: "broken" }, {});
		const found = scanPlugins(root, logger).map((plugin) => plugin.id);
		expect(found).not.toContain("broken");
		expect(logged.join("\n")).toContain("no server entry");
	});
});
