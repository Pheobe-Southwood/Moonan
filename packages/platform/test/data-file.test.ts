import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DataFile } from "../src/data.js";

const dirs: string[] = [];

async function tempFile(name = "data.json"): Promise<{ dir: string; file: string }> {
	const dir = await mkdtemp(join(tmpdir(), "moonan-data-file-"));
	dirs.push(dir);
	return { dir, file: join(dir, name) };
}

afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const codecs = {
	table: () =>
		new Map([
			[
				"test/value",
				{
					namespace: "test/value",
					version: 1,
					migrate: (value: unknown) => String(value),
					export: (value: unknown) => String(value),
					import: (value: unknown) => String(value),
				},
			],
		]),
};

describe("DataFile", () => {
	it("starts empty, writes a private file, and reads it back", async () => {
		const { file } = await tempFile();
		const store = await DataFile.open(file);
		expect((await store.info()).exists).toBe(false);

		await store.write("test/value", 1, "hello");
		const info = await store.info();
		expect(info.exists).toBe(true);
		expect(info.mode).toBe("0600");
		expect(info.revision).toBe(1);
		expect(info.datasets).toBe(1);
		expect((await stat(file)).mode & 0o777).toBe(0o600);
		expect(store.read("test/value")).toEqual({ value: "hello", version: 1 });

		const reopened = await DataFile.open(file);
		expect(reopened.read("test/value")).toEqual({ value: "hello", version: 1 });
	});

	it("keeps the previous document as a backup", async () => {
		const { file } = await tempFile();
		const store = await DataFile.open(file);
		await store.write("test/value", 1, "first");
		await store.write("test/value", 1, "second");
		const backup = JSON.parse(await readFile(`${file}.bak`, "utf8")) as {
			datasets: Record<string, { value: string }>;
		};
		expect(backup.datasets["test/value"]?.value).toBe("first");
		expect((await stat(`${file}.bak`)).mode & 0o777).toBe(0o600);
	});

	it("recovers from the backup when the main file is corrupt", async () => {
		const { file } = await tempFile();
		const store = await DataFile.open(file);
		await store.write("test/value", 1, "good");
		await store.write("test/value", 1, "newer");
		await writeFile(file, "{ this is not json", "utf8");

		const recovered = await DataFile.open(file);
		expect(recovered.read("test/value")?.value).toBe("good");
		expect((await recovered.info()).notice).toMatch(/备份/);

		await recovered.write("test/value", 1, "after recovery");
		const backup = JSON.parse(await readFile(`${file}.bak`, "utf8")) as {
			datasets: Record<string, { value: string }>;
		};
		expect(backup.datasets["test/value"]?.value).toBe("good");
	});

	it("quarantines a file when both main and backup are unusable", async () => {
		const { file, dir } = await tempFile();
		const store = await DataFile.open(file);
		await store.write("test/value", 1, "good");
		await writeFile(file, "not json", "utf8");
		await writeFile(`${file}.bak`, "also not json", "utf8");

		const recovered = await DataFile.open(file);
		expect(recovered.read("test/value")).toBeUndefined();
		expect((await recovered.info()).notice).toMatch(/corrupt/);
		const entries = await readdir(dir);
		expect(entries.some((entry) => entry.startsWith("data.json.corrupt-"))).toBe(true);
	});

	it("serializes update and export", async () => {
		const { file } = await tempFile();
		const store = await DataFile.open(file);
		await store.write("test/value", 1, "0");

		const updates = Array.from({ length: 8 }, (_, index) =>
			store.update("test/value", 1, (current) => ({
				value: `${current?.value ?? ""}${index}`,
				version: 1,
			})),
		);
		await Promise.all(updates);
		expect(store.read("test/value")?.value).toBe("001234567");
		const bundle = await store.exportAll(codecs, undefined, false);
		expect(bundle.datasets).toEqual([{ namespace: "test/value", version: 1, value: "001234567" }]);
	});

	it("imports atomically and refuses a missing codec", async () => {
		const { file } = await tempFile();
		const store = await DataFile.open(file);
		await store.write("test/value", 1, "keep");

		await expect(
			store.importAll(codecs, undefined, {
				format: "moonan.data",
				formatVersion: 1,
				createdAt: new Date().toISOString(),
				revision: 1,
				datasets: [{ namespace: "missing/value", version: 1, value: "x" }],
			}),
		).rejects.toThrow(/no codec/);
		expect(store.read("test/value")?.value).toBe("keep");

		await store.importAll(codecs, undefined, {
			format: "moonan.data",
			formatVersion: 1,
			createdAt: new Date().toISOString(),
			revision: 1,
			datasets: [{ namespace: "test/value", version: 1, value: "imported" }],
		});
		expect(store.read("test/value")?.value).toBe("imported");
	});
});
