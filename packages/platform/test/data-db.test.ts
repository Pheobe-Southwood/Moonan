import { chmod, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { DataStoreDatabase, defaultDataDb } from "../src/data.js";

const dirs: string[] = [];
const stores: DataStoreDatabase[] = [];

async function tempDb(name = "data.db"): Promise<{ dir: string; file: string }> {
	const dir = await mkdtemp(join(tmpdir(), "moonan-data-db-"));
	dirs.push(dir);
	return { dir, file: join(dir, name) };
}

async function openStore(file: string): Promise<DataStoreDatabase> {
	const store = await DataStoreDatabase.open(file);
	stores.push(store);
	return store;
}

afterEach(async () => {
	await Promise.all(stores.splice(0).map((store) => store.close().catch(() => undefined)));
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("DataStoreDatabase", () => {
	it("starts empty, creates a private database, and reads it back", async () => {
		const { dir, file } = await tempDb();
		// `open` has to tighten a directory that already exists with wider permissions.
		await chmod(dir, 0o755);
		const store = await openStore(file);

		const empty = await store.info();
		expect(empty.database).toBe(file);
		expect(empty.exists).toBe(true);
		expect(empty.mode).toBe("0600");
		expect(empty.writable).toBe(true);
		expect(empty.revision).toBe(0);
		expect(empty.datasets).toBe(0);
		expect(empty.schemaVersion).toBe(1);
		expect(empty.journalMode).toBe("wal");
		expect(store.revision).toBe(0);
		expect(store.datasetCount).toBe(0);
		expect(await store.read("test/value")).toBeUndefined();

		await store.write("test/value", 1, "hello");
		const info = await store.info();
		expect(info.mode).toBe("0600");
		expect((await stat(file)).mode & 0o777).toBe(0o600);
		expect((await stat(dir)).mode & 0o777).toBe(0o700);
		expect(info.revision).toBe(1);
		expect(info.datasets).toBe(1);
		expect(info.sizeBytes).toBeGreaterThan(0);
		expect(info.lastSavedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(await store.read("test/value")).toEqual({ value: "hello", version: 1 });

		const reopened = await openStore(file);
		expect(reopened.revision).toBe(1);
		expect(reopened.datasetCount).toBe(1);
		expect(await reopened.read("test/value")).toEqual({ value: "hello", version: 1 });
	});

	it("serializes concurrent updates", async () => {
		const { file } = await tempDb();
		const store = await openStore(file);
		await store.write("test/value", 1, "0");

		const updates = Array.from({ length: 8 }, (_, index) =>
			store.update("test/value", 1, (current) => ({
				value: `${String(current?.value ?? "")}${index}`,
				version: 1,
			})),
		);
		await Promise.all(updates);

		expect(await store.read("test/value")).toEqual({ value: "001234567", version: 1 });
		expect(store.revision).toBe(9);
		expect(store.datasetCount).toBe(1);
	});

	it("rejects a store call made from inside an update callback", async () => {
		const { file } = await tempDb();
		const store = await openStore(file);
		await store.write("test/value", 1, "kept");

		await expect(
			store.update("test/value", 1, async (current) => {
				// The callback runs on the single connection's transaction; re-entering the store
				// would wait for its own transaction forever. The guard turns that into an error.
				await store.read("test/value");
				return current ?? { value: "changed", version: 1 };
			}),
		).rejects.toThrow(/cannot be used from inside/);
		expect(store.revision).toBe(1);
		expect(await store.read("test/value")).toEqual({ value: "kept", version: 1 });
	});

	it("exports codec-owned datasets, migrating older rows", async () => {
		const { file } = await tempDb();
		const store = await openStore(file);
		await store.write("test/value", 1, "stored");
		await store.write("test/unowned", 1, { plugin: true });

		const codecs = {
			table: () =>
				new Map([
					[
						"test/value",
						{
							namespace: "test/value",
							version: 2,
							migrate: (value: unknown, from: number) => `${String(value)}@${from}`,
							export: (value: unknown) => String(value),
							import: (value: unknown) => String(value),
						},
					],
				]),
		};

		const bundle = await store.exportAll(codecs, undefined, false);
		expect(bundle.format).toBe("moonan.data");
		expect(bundle.revision).toBe(2);
		expect(bundle.datasets).toEqual([{ namespace: "test/value", version: 2, value: "stored@1" }]);
		// A namespace without a codec is not portable: it is reported, not exported.
		expect(bundle.skipped).toEqual(["test/unowned"]);
	});

	it("imports atomically and refuses a missing codec or a duplicate namespace", async () => {
		const { file } = await tempDb();
		const store = await openStore(file);
		await store.write("test/value", 1, "keep");

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
					[
						"test/second",
						{
							namespace: "test/second",
							version: 1,
							migrate: (value: unknown) => String(value),
							export: (value: unknown) => String(value),
							import: (value: unknown) => String(value),
						},
					],
				]),
		};
		const bundle = (datasets: { namespace: string; version: number; value: unknown }[]) => ({
			format: "moonan.data" as const,
			formatVersion: 1 as const,
			createdAt: new Date().toISOString(),
			revision: 1,
			datasets,
		});

		await expect(
			store.importAll(codecs, undefined, bundle([{ namespace: "missing/value", version: 1, value: "x" }])),
		).rejects.toThrow(/no codec/);
		expect(await store.read("test/value")).toEqual({ value: "keep", version: 1 });
		expect(store.revision).toBe(1);

		await expect(
			store.importAll(
				codecs,
				undefined,
				bundle([
					{ namespace: "test/value", version: 1, value: "first" },
					{ namespace: "test/value", version: 1, value: "second" },
				]),
			),
		).rejects.toThrow(/duplicate/);
		expect(await store.read("test/value")).toEqual({ value: "keep", version: 1 });

		const report = await store.importAll(
			codecs,
			undefined,
			bundle([
				{ namespace: "test/value", version: 1, value: "imported" },
				{ namespace: "test/second", version: 1, value: "second" },
			]),
		);
		expect(report.imported).toEqual(["test/second", "test/value"]);
		// Two rows, one committed mutation: the revision counts imports, not rows.
		expect(report.revision).toBe(2);
		expect(store.revision).toBe(2);
		expect(store.datasetCount).toBe(2);
		expect(await store.read("test/value")).toEqual({ value: "imported", version: 1 });
		expect(await store.read("test/second")).toEqual({ value: "second", version: 1 });
	});

	it("rolls back every row when a codec throws mid-import", async () => {
		const { file } = await tempDb();
		const store = await openStore(file);
		await store.write("test/value", 1, "keep");

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
					[
						"test/boom",
						{
							namespace: "test/boom",
							version: 1,
							migrate: (value: unknown) => String(value),
							export: (value: unknown) => String(value),
							import: (value: unknown): string => {
								throw new Error("codec boom");
							},
						},
					],
				]),
		};

		await expect(
			store.importAll(codecs, undefined, {
				format: "moonan.data" as const,
				formatVersion: 1 as const,
				createdAt: new Date().toISOString(),
				revision: 1,
				datasets: [
					{ namespace: "test/value", version: 1, value: "changed" },
					{ namespace: "test/boom", version: 1, value: "x" },
				],
			}),
		).rejects.toThrow(/codec boom/);

		// The first row was already upserted inside the transaction; the rollback undoes it.
		expect(await store.read("test/value")).toEqual({ value: "keep", version: 1 });
		expect(await store.read("test/boom")).toBeUndefined();
		expect(store.revision).toBe(1);
		expect(store.datasetCount).toBe(1);
	});

	it("refuses an import from a newer dataset version", async () => {
		const { file } = await tempDb();
		const store = await openStore(file);
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

		await expect(
			store.importAll(codecs, undefined, {
				format: "moonan.data" as const,
				formatVersion: 1 as const,
				createdAt: new Date().toISOString(),
				revision: 1,
				datasets: [{ namespace: "test/value", version: 2, value: "future" }],
			}),
		).rejects.toThrow(/newer than/);
		expect(await store.read("test/value")).toBeUndefined();
		expect(store.revision).toBe(0);
	});

	it("quarantines a corrupt database and starts empty with a notice", async () => {
		const { dir, file } = await tempDb();
		const store = await openStore(file);
		await store.write("test/value", 1, "good");
		await store.close();
		await writeFile(file, "this is not a SQLite database", "utf8");

		const recovered = await openStore(file);
		const info = await recovered.info();
		expect(info.notice).toMatch(/data\.corrupt-\d+\.db/);
		expect(info.revision).toBe(0);
		expect(info.datasets).toBe(0);
		expect(await recovered.read("test/value")).toBeUndefined();
		const entries = await readdir(dir);
		expect(entries.some((entry) => /^data\.corrupt-\d+\.db$/.test(entry))).toBe(true);

		// The notice is cleared by the next successful mutation, as it was for the JSON store.
		await recovered.write("test/value", 1, "after recovery");
		expect((await recovered.info()).notice).toBeUndefined();
	});

	it("refuses a foreign SQLite database without changing journal mode or permissions", async () => {
		const { dir, file } = await tempDb();
		await chmod(dir, 0o755);
		const foreign = new DatabaseSync(file);
		try {
			foreign.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY, value TEXT)");
		} finally {
			foreign.close();
		}
		const probe = new DatabaseSync(file, { readOnly: true });
		let journalMode: string;
		try {
			journalMode = (
				probe.prepare("PRAGMA journal_mode").get() as { journal_mode: string }
			).journal_mode;
		} finally {
			probe.close();
		}
		expect(journalMode).toBe("delete");
		const beforeFileMode = (await stat(file)).mode & 0o777;
		const beforeDirMode = (await stat(dir)).mode & 0o777;

		await expect(DataStoreDatabase.open(file)).rejects.toThrow(/not a Moonan data store/);

		// Refusing must happen before Chord opens the file: a failed open would otherwise set
		// WAL in the header, and hardening must not chmod a database that is not ours.
		expect((await stat(file)).mode & 0o777).toBe(beforeFileMode);
		expect((await stat(dir)).mode & 0o777).toBe(beforeDirMode);
		expect((await readdir(dir)).sort()).toEqual(["data.db"]);

		const check = new DatabaseSync(file, { readOnly: true });
		try {
			expect(check.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
			const names = check
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
				.all()
				.map((row) => String(row.name));
			expect(names).toEqual(["unrelated"]);
		} finally {
			check.close();
		}
	});

	it("refuses a foreign application id without opening the database", async () => {
		const { dir, file } = await tempDb();
		await chmod(dir, 0o755);
		const foreign = new DatabaseSync(file);
		try {
			foreign.exec("PRAGMA application_id = 305419896");
		} finally {
			foreign.close();
		}
		const beforeFileMode = (await stat(file)).mode & 0o777;
		const beforeDirMode = (await stat(dir)).mode & 0o777;

		await expect(DataStoreDatabase.open(file)).rejects.toThrow(/not a Moonan data store/);

		expect((await stat(file)).mode & 0o777).toBe(beforeFileMode);
		expect((await stat(dir)).mode & 0o777).toBe(beforeDirMode);
		const check = new DatabaseSync(file, { readOnly: true });
		try {
			expect(check.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
			expect(check.prepare("PRAGMA application_id").get()).toEqual({
				application_id: 305419896,
			});
		} finally {
			check.close();
		}
	});

	it("refuses a database with a newer schema version", async () => {
		const { dir, file } = await tempDb();
		const store = await openStore(file);
		await store.write("test/value", 1, "kept");
		await store.close();

		const database = new DatabaseSync(file);
		try {
			database.exec("UPDATE moonan_data_schema SET version = 99 WHERE singleton = 1");
		} finally {
			database.close();
		}

		await expect(DataStoreDatabase.open(file)).rejects.toThrow(/newer than supported/);
		// A version mismatch is not corruption: the file must not be quarantined.
		const entries = await readdir(dir);
		expect(entries.some((entry) => entry.startsWith("data.corrupt-"))).toBe(false);
	});

	it("sees an external writer immediately and reloads its metadata", async () => {
		const { file } = await tempDb();
		const store = await openStore(file);
		await store.write("test/value", 1, "inside");

		const external = new DatabaseSync(file);
		try {
			external
				.prepare(
					"INSERT INTO moonan_data_datasets (namespace, version, value, updated_at) VALUES (?, ?, ?, ?)",
				)
				.run("external/value", 1, JSON.stringify("outside"), new Date().toISOString());
			external
				.prepare("UPDATE moonan_data_meta SET revision = revision + 1, updated_at = ? WHERE singleton = 1")
				.run(new Date().toISOString());
		} finally {
			external.close();
		}

		expect(await store.read("external/value")).toEqual({ value: "outside", version: 1 });
		const reloaded = await store.reload();
		expect(reloaded.revision).toBe(2);
		expect(reloaded.datasets).toBe(2);
		expect(store.revision).toBe(2);
		expect(store.datasetCount).toBe(2);
	});

	it("reports a memory database as writable without a file", async () => {
		const store = await openStore(":memory:");
		const info = await store.info();
		expect(info.database).toBe(":memory:");
		expect(info.exists).toBe(false);
		expect(info.writable).toBe(true);
		expect(info.sizeBytes).toBeUndefined();

		await store.write("test/value", 1, "memory");
		expect(await store.read("test/value")).toEqual({ value: "memory", version: 1 });
	});
});

describe("defaultDataDb", () => {
	it("defaults to data.db and ignores the retired MOONAN_DATA_FILE", () => {
		expect(defaultDataDb({ MOONAN_DATA_DB: "/tmp/custom.db" })).toBe("/tmp/custom.db");
		expect(defaultDataDb({ MOONAN_HOME: "/tmp/moonan-home" })).toBe(
			join("/tmp/moonan-home", "data.db"),
		);
		expect(defaultDataDb({ MOONAN_DATA_FILE: "/tmp/old-data.json" })).toBe(
			join(homedir(), ".moonan", "data.db"),
		);
	});
});
