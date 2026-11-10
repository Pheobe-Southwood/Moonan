import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PluginRegistry } from "../src/plugin-registry.js";

const dirs: string[] = [];

async function tempFile(name = "plugins.json"): Promise<{ dir: string; file: string }> {
	const dir = await mkdtemp(join(tmpdir(), "moonan-plugin-registry-"));
	dirs.push(dir);
	return { dir, file: join(dir, name) };
}

afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("PluginRegistry", () => {
	it("starts empty, writes a private file, and reads it back", async () => {
		const { file } = await tempFile();
		const registry = await PluginRegistry.open(file);
		expect(registry.entries()).toEqual([]);
		expect(registry.warning()).toBeUndefined();

		await registry.replace([{ ref: "@moonan_ai/ai-gateway", enabled: true }]);
		expect(registry.entries()).toEqual([{ ref: "@moonan_ai/ai-gateway", enabled: true }]);
		expect((await stat(file)).mode & 0o777).toBe(0o600);

		const reopened = await PluginRegistry.open(file);
		expect(reopened.entries()).toEqual([{ ref: "@moonan_ai/ai-gateway", enabled: true }]);
		expect(reopened.warning()).toBeUndefined();
	});

	it("dedupes refs and normalizes whitespace", async () => {
		const { file } = await tempFile();
		const registry = await PluginRegistry.open(file);
		await registry.replace([
			{ ref: " a ", enabled: true },
			{ ref: "a", enabled: false },
			{ ref: "b", enabled: true },
		]);
		expect(registry.entries()).toEqual([
			{ ref: "a", enabled: true },
			{ ref: "b", enabled: true },
		]);
		const document = JSON.parse(await readFile(file, "utf8")) as { plugins: unknown[] };
		expect(document.plugins).toHaveLength(2);
	});

	it("moves a corrupt file aside and starts from the official defaults", async () => {
		const { dir, file } = await tempFile();
		await writeFile(file, "not json at all");
		const registry = await PluginRegistry.open(file);
		expect(registry.entries()).toEqual([]);
		expect(registry.warning()).toMatch(/无法读取/);
		const entries = await readdir(dir);
		expect(entries.some((name) => name.startsWith("plugins.corrupt-"))).toBe(true);
	});

	it("recovers from the .bak file when the main file is unreadable", async () => {
		const { file } = await tempFile();
		const registry = await PluginRegistry.open(file);
		await registry.replace([{ ref: "a", enabled: true }]);
		// The second write keeps the previous document as `.bak`.
		await registry.replace([{ ref: "b", enabled: false }]);
		await writeFile(file, "{broken");
		const recovered = await PluginRegistry.open(file);
		expect(recovered.entries()).toEqual([{ ref: "a", enabled: true }]);
		expect(recovered.warning()).toMatch(/备份/);
	});

	it("keeps the in-memory list when a save fails", async () => {
		const dir = await mkdtemp(join(tmpdir(), "moonan-plugin-registry-"));
		dirs.push(dir);
		const blocker = join(dir, "blocker");
		await writeFile(blocker, "");
		// `blocker/plugins.json` cannot even create its directory: a file is in the way.
		const registry = await PluginRegistry.open(join(blocker, "plugins.json"));
		await expect(registry.replace([{ ref: "a", enabled: true }])).rejects.toThrow();
		expect(registry.entries()).toEqual([]);
	});
});
