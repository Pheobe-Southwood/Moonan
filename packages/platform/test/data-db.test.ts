import { chmod, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { DataStoreDatabase, defaultDataDb } from "../src/data.js";

const dirs: string[] = [];
const stores: DataStoreDatabase[] = [];

/** The data store is owner-scoped; these stand in for two signed-in accounts. */
const ALPHA = "user:alpha";
const BETA = "user:beta";

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

function codecTable(entries: [string, number][]) {
	return {
		table: () =>
			new Map(
				entries.map(([namespace, version]) => [
					namespace,
					{
						namespace,
						version,
						migrate: (value: unknown, from: number) => `${String(value)}@${from}`,
						export: (value: unknown) => String(value),
						import: (value: unknown) => String(value),
					},
				]),
			),
	};
}

function bundle(datasets: { namespace: string; version: number; value: unknown }[], revision = 1) {
	return {
		format: "moonan.data" as const,
		formatVersion: 1 as const,
		createdAt: new Date().toISOString(),
		revision,
		datasets,
	};
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
		// Schema v2 introduced the (owner, namespace) partition; the store contract is v3.
		expect(empty.schemaVersion).toBe(2);
		expect(empty.journalMode).toBe("wal");
		expect(store.revision).toBe(0);
		expect(store.datasetCount).toBe(0);
		expect(await store.read(ALPHA, "test/value")).toBeUndefined();

		await store.write(ALPHA, "test/value", 1, "hello");
		const info = await store.info();
		expect(info.mode).toBe("0600");
		expect((await stat(file)).mode & 0o777).toBe(0o600);
		expect((await stat(dir)).mode & 0o777).toBe(0o700);
		expect(info.revision).toBe(1);
		expect(info.datasets).toBe(1);
		expect(info.sizeBytes).toBeGreaterThan(0);
		expect(info.lastSavedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(await store.read(ALPHA, "test/value")).toEqual({ value: "hello", version: 1 });

		const reopened = await openStore(file);
		expect(reopened.revision).toBe(1);
		expect(reopened.datasetCount).toBe(1);
		expect(await reopened.read(ALPHA, "test/value")).toEqual({ value: "hello", version: 1 });
	});

	it("serializes concurrent updates", async () => {
		const { file } = await tempDb();
		const store = await openStore(file);
		await store.write(ALPHA, "test/value", 1, "0");

		const updates = Array.from({ length: 8 }, (_, index) =>
			store.update(ALPHA, "test/value", 1, (current) => ({
				value: `${String(current?.value ?? "")}${index}`,
				version: 1,
			})),
		);
		await Promise.all(updates);

		expect(await store.read(ALPHA, "test/value")).toEqual({ value: "001234567", version: 1 });
		expect(store.revision).toBe(9);
		expect(store.datasetCount).toBe(1);
	});

	it("rejects a store call made from inside an update callback", async () => {
		const { file } = await tempDb();
		const store = await openStore(file);
		await store.write(ALPHA, "test/value", 1, "kept");

		await expect(
			store.update(ALPHA, "test/value", 1, async (current) => {
				// The callback runs on the single connection's transaction; re-entering the store
				// would wait for its own transaction forever. The guard turns that into an error.
				await store.read(ALPHA, "test/value");
				return current ?? { value: "changed", version: 1 };
			}),
		).rejects.toThrow(/cannot be used from inside/);
		expect(store.revision).toBe(1);
		expect(await store.read(ALPHA, "test/value")).toEqual({ value: "kept", version: 1 });
	});

	it("partitions read, write, update and remove by owner", async () => {
		const { file } = await tempDb();
		const store = await openStore(file);
		// The same namespace is not a shared bucket: the owner is the partition key.
		await store.write(ALPHA, "test/value", 1, "alpha");
		await store.write(BETA, "test/value", 1, "beta");

		expect(await store.read(ALPHA, "test/value")).toEqual({ value: "alpha", version: 1 });
		expect(await store.read(BETA, "test/value")).toEqual({ value: "beta", version: 1 });
		expect(store.datasetCount).toBe(2);

		await store.update(BETA, "test/value", 1, () => ({ value: "beta-2", version: 1 }));
		expect(await store.read(ALPHA, "test/value")).toEqual({ value: "alpha", version: 1 });
		expect(await store.read(BETA, "test/value")).toEqual({ value: "beta-2", version: 1 });

		await store.remove(ALPHA, "test/value");
		expect(await store.read(ALPHA, "test/value")).toBeUndefined();
		expect(await store.read(BETA, "test/value")).toEqual({ value: "beta-2", version: 1 });
		expect(store.datasetCount).toBe(1);
	});

	it("removes every dataset of one owner", async () => {
		const { file } = await tempDb();
		const store = await openStore(file);
		await store.write(ALPHA, "test/one", 1, "alpha-1");
		await store.write(ALPHA, "test/two", 1, "alpha-2");
		await store.write(BETA, "test/one", 1, "beta-1");
		expect(store.datasetCount).toBe(3);

		const info = await store.removeOwner(ALPHA);
		expect(info.datasets).toBe(1);
		expect(store.datasetCount).toBe(1);
		expect(await store.read(ALPHA, "test/one")).toBeUndefined();
		expect(await store.read(ALPHA, "test/two")).toBeUndefined();
		expect(await store.read(BETA, "test/one")).toEqual({ value: "beta-1", version: 1 });

		// Removing an owner with no datasets is a no-op, not a revision bump.
		const revision = store.revision;
		const untouched = await store.removeOwner("user:gamma");
		expect(untouched.revision).toBe(revision);
		expect(untouched.datasets).toBe(1);
	});

	it("exports codec-owned datasets, migrating older rows", async () => {
		const { file } = await tempDb();
		const store = await openStore(file);
		await store.write(ALPHA, "test/value", 1, "stored");
		await store.write(ALPHA, "test/unowned", 1, { plugin: true });
		// Another owner's dataset must not leak into this export.
		await store.write(BETA, "test/value", 1, "beta-stored");

		const codecs = codecTable([["test/value", 2]]);

		const bundle = await store.exportAll(codecs, undefined, ALPHA, false);
		expect(bundle.format).toBe("moonan.data");
		expect(bundle.revision).toBe(3);
		expect(bundle.datasets).toEqual([{ namespace: "test/value", version: 2, value: "stored@1" }]);
		// A namespace without a codec is not portable: it is reported, not exported.
		expect(bundle.skipped).toEqual(["test/unowned"]);

		const betaBundle = await store.exportAll(codecs, undefined, BETA, false);
		expect(betaBundle.datasets).toEqual([{ namespace: "test/value", version: 2, value: "beta-stored@1" }]);
	});

	it("imports atomically and refuses a missing codec or a duplicate namespace", async () => {
		const { file } = await tempDb();
		const store = await openStore(file);
		await store.write(ALPHA, "test/value", 1, "keep");

		const codecs = codecTable([
			["test/value", 1],
			["test/second", 1],
		]);

		await expect(
			store.importAll(codecs, undefined, ALPHA, bundle([{ namespace: "missing/value", version: 1, value: "x" }])),
		).rejects.toThrow(/no codec/);
		expect(await store.read(ALPHA, "test/value")).toEqual({ value: "keep", version: 1 });
		expect(store.revision).toBe(1);

		await expect(
			store.importAll(
				codecs,
				undefined,
				ALPHA,
				bundle([
					{ namespace: "test/value", version: 1, value: "first" },
					{ namespace: "test/value", version: 1, value: "second" },
				]),
			),
		).rejects.toThrow(/duplicate/);
		expect(await store.read(ALPHA, "test/value")).toEqual({ value: "keep", version: 1 });

		const report = await store.importAll(
			codecs,
			undefined,
			ALPHA,
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
		expect(await store.read(ALPHA, "test/value")).toEqual({ value: "imported", version: 1 });
		expect(await store.read(ALPHA, "test/second")).toEqual({ value: "second", version: 1 });
	});

	it("imports into the importing owner only", async () => {
		const { file } = await tempDb();
		const store = await openStore(file);
		await store.write(ALPHA, "test/value", 1, "alpha");
		await store.write(BETA, "test/value", 1, "beta");
		const codecs = codecTable([["test/value", 1]]);

		// The same bundle imported by a different owner is their own dataset, not a shared one.
		await store.importAll(codecs, undefined, BETA, bundle([{ namespace: "test/value", version: 1, value: "beta-import" }]));
		expect(await store.read(ALPHA, "test/value")).toEqual({ value: "alpha", version: 1 });
		expect(await store.read(BETA, "test/value")).toEqual({ value: "beta-import", version: 1 });
	});

	it("rolls back every row when a codec throws mid-import", async () => {
		const { file } = await tempDb();
		const store = await openStore(file);
		await store.write(ALPHA, "test/value", 1, "keep");

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
			store.importAll(codecs, undefined, ALPHA, {
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
		expect(await store.read(ALPHA, "test/value")).toEqual({ value: "keep", version: 1 });
		expect(await store.read(ALPHA, "test/boom")).toBeUndefined();
		expect(store.revision).toBe(1);
		expect(store.datasetCount).toBe(1);
	});

	it("refuses an import from a newer dataset version", async () => {
		const { file } = await tempDb();
		const store = await openStore(file);
		const codecs = codecTable([["test/value", 1]]);

		await expect(
			store.importAll(codecs, undefined, ALPHA, {
				format: "moonan.data" as const,
				formatVersion: 1 as const,
				createdAt: new Date().toISOString(),
				revision: 1,
				datasets: [{ namespace: "test/value", version: 2, value: "future" }],
			}),
		).rejects.toThrow(/newer than/);
		expect(await store.read(ALPHA, "test/value")).toBeUndefined();
		expect(store.revision).toBe(0);
	});

	it("quarantines a corrupt database and starts empty with a notice", async () => {
		const { dir, file } = await tempDb();
		const store = await openStore(file);
		await store.write(ALPHA, "test/value", 1, "good");
		await store.close();
		await writeFile(file, "this is not a SQLite database", "utf8");

		const recovered = await openStore(file);
		const info = await recovered.info();
		expect(info.notice).toMatch(/data\.corrupt-\d+\.db/);
		expect(info.revision).toBe(0);
		expect(info.datasets).toBe(0);
		expect(await recovered.read(ALPHA, "test/value")).toBeUndefined();
		const entries = await readdir(dir);
		expect(entries.some((entry) => /^data\.corrupt-\d+\.db$/.test(entry))).toBe(true);

		// The notice is cleared by the next successful mutation, as it was for the JSON store.
		await recovered.write(ALPHA, "test/value", 1, "after recovery");
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

	it("migrates a v1 database, dropping rows that predate data ownership", async () => {
		const { file } = await tempDb();
		// A v1 data database: the schema and dataset table from before the owner column.
		const legacy = new DatabaseSync(file);
		try {
			legacy.exec(`
				CREATE TABLE moonan_data_meta (
					singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
					format TEXT NOT NULL,
					revision INTEGER NOT NULL CHECK (revision >= 0),
					datasets INTEGER NOT NULL CHECK (datasets >= 0),
					updated_at TEXT
				) STRICT;
				CREATE TABLE moonan_data_datasets (
					namespace TEXT PRIMARY KEY,
					version INTEGER NOT NULL CHECK (version >= 1),
					value TEXT NOT NULL CHECK (json_valid(value)),
					updated_at TEXT NOT NULL
				) STRICT;
				CREATE TABLE moonan_data_schema (
					singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
					version INTEGER NOT NULL CHECK (version >= 0)
				) STRICT;
				INSERT INTO moonan_data_meta (singleton, format, revision, datasets, updated_at)
					VALUES (1, 'moonan.data', 7, 1, '2026-01-01T00:00:00.000Z');
				INSERT INTO moonan_data_datasets (namespace, version, value, updated_at)
					VALUES ('legacy/value', 1, '"before-accounts"', '2026-01-01T00:00:00.000Z');
				INSERT INTO moonan_data_schema (singleton, version) VALUES (1, 1);
			`);
		} finally {
			legacy.close();
		}

		const store = await openStore(file);
		const info = await store.info();
		// The v2 migration is deliberately destructive: there is no correct owner to invent
		// for a row that predates accounts.
		expect(info.schemaVersion).toBe(2);
		expect(info.revision).toBe(7);
		expect(info.datasets).toBe(0);
		expect(await store.read(ALPHA, "legacy/value")).toBeUndefined();
		// The new table really has the owner partition: a fresh write and read works.
		await store.write(ALPHA, "legacy/value", 1, "after-migration");
		expect(await store.read(ALPHA, "legacy/value")).toEqual({ value: "after-migration", version: 1 });

		await store.close();
		const check = new DatabaseSync(file, { readOnly: true });
		try {
			const columns = check
				.prepare("PRAGMA table_info(moonan_data_datasets)")
				.all()
				.map((row) => String(row.name));
			expect(columns).toEqual(["owner", "namespace", "version", "value", "updated_at"]);
			expect(
				check.prepare("SELECT COUNT(*) AS count FROM moonan_data_datasets").get(),
			).toEqual({ count: 1 });
		} finally {
			check.close();
		}
	});

	it("refuses a database with a newer schema version", async () => {
		const { dir, file } = await tempDb();
		const store = await openStore(file);
		await store.write(ALPHA, "test/value", 1, "kept");
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
		await store.write(ALPHA, "test/value", 1, "inside");

		const external = new DatabaseSync(file);
		try {
			external
				.prepare(
					`INSERT INTO moonan_data_datasets (owner, namespace, version, value, updated_at)
					 VALUES (?, ?, ?, ?, ?)`,
				)
				.run(ALPHA, "external/value", 1, JSON.stringify("outside"), new Date().toISOString());
			external
				.prepare("UPDATE moonan_data_meta SET revision = revision + 1, updated_at = ? WHERE singleton = 1")
				.run(new Date().toISOString());
		} finally {
			external.close();
		}

		expect(await store.read(ALPHA, "external/value")).toEqual({ value: "outside", version: 1 });
		// Another owner's row with the same namespace is not visible through the owner key.
		expect(await store.read(BETA, "external/value")).toBeUndefined();
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

		await store.write(ALPHA, "test/value", 1, "memory");
		expect(await store.read(ALPHA, "test/value")).toEqual({ value: "memory", version: 1 });
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
