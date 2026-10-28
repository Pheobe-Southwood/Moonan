import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GatewayConfig } from "../src/schema.js";
import { ConfigStore, defaultSettings, emptyConfig } from "../src/store.js";

let dir: string;

function configWith(name: string, key = "sk-secret-12345678"): GatewayConfig {
	const config = emptyConfig();
	config.providers.push({
		id: "local",
		name,
		source: "custom",
		enabled: true,
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:1234/v1",
		apiKey: key,
		keyUpdatedAt: new Date().toISOString(),
		models: [],
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	});
	return config;
}

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "moonan-gateway-store-"));
});

afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("ConfigStore", () => {
	it("starts empty when the file does not exist", async () => {
		const store = new ConfigStore(join(dir, "empty", "config.json"));
		const loaded = await store.load();
		expect(loaded.recovered).toBe(false);
		expect(loaded.config.providers).toEqual([]);
		expect(loaded.config.settings).toEqual(defaultSettings());
	});

	it("writes a private, atomic JSON file and reads it back", async () => {
		const file = join(dir, "read-write", "config.json");
		const store = new ConfigStore(file);
		const saved = await store.save(configWith("Local"));
		expect(saved.mode).toBe("0600");

		const info = await stat(file);
		expect(info.mode & 0o777).toBe(0o600);
		const entries = await readdir(join(dir, "read-write"));
		expect(entries.some((entry) => entry.endsWith(".tmp"))).toBe(false);

		const loaded = await store.load();
		expect(loaded.recovered).toBe(false);
		expect(loaded.config.providers[0]?.name).toBe("Local");
		expect(loaded.config.providers[0]?.apiKey).toBe("sk-secret-12345678");
		expect(await store.writable()).toBe(true);
	});

	it("keeps the previous revision as a private backup", async () => {
		const root = join(dir, "backup");
		const file = join(root, "config.json");
		const store = new ConfigStore(file);
		await store.save(configWith("First"));
		await store.save(configWith("Second"));
		const backup = JSON.parse(await readFile(`${file}.bak`, "utf8")) as GatewayConfig;
		expect(backup.providers[0]?.name).toBe("First");
		expect((await stat(`${file}.bak`)).mode & 0o777).toBe(0o600);
	});

	it("recovers from the backup when the main file is corrupt", async () => {
		const root = join(dir, "recover");
		const file = join(root, "config.json");
		const store = new ConfigStore(file);
		await store.save(configWith("Good"));
		await store.save(configWith("Newer"));
		await writeFile(file, "{ this is not json", "utf8");

		const loaded = await store.load();
		expect(loaded.recovered).toBe(true);
		expect(loaded.config.providers[0]?.name).toBe("Good");
		expect(loaded.notice).toMatch(/备份/);

		// Saving after recovery must not copy the corrupt main over the good backup.
		await store.save(configWith("After recovery"));
		const backup = JSON.parse(await readFile(`${file}.bak`, "utf8")) as GatewayConfig;
		expect(backup.providers[0]?.name).toBe("Good");
	});

	it("quarantines the file when both main and backup are unusable", async () => {
		const root = join(dir, "corrupt");
		const file = join(root, "config.json");
		const store = new ConfigStore(file);
		await store.save(configWith("Good"));
		await writeFile(file, "not json", "utf8");
		await writeFile(`${file}.bak`, "also not json", "utf8");

		const loaded = await store.load();
		expect(loaded.recovered).toBe(true);
		expect(loaded.config.providers).toEqual([]);
		expect(loaded.notice).toMatch(/corrupt/);
		const entries = await readdir(root);
		expect(entries.some((entry) => entry.startsWith("config.json.corrupt-"))).toBe(true);
	});

	it("refuses to write a configuration that does not match the schema", async () => {
		const store = new ConfigStore(join(dir, "invalid", "config.json"));
		const broken = configWith("Broken") as unknown as GatewayConfig;
		broken.providers[0]!.models = [{ id: "", name: "x" } as never];
		expect(() => store.save(broken)).toThrow(/schema/);
	});
});
