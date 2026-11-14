import { access, chmod, constants, mkdir, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	copyJson,
	defineFacet,
	invalid,
	isJsonValue,
	type Ctx,
	type Facet,
	type JsonValue,
} from "@earendil-works/chord";
import {
	applySqliteMigrations,
	type SqliteExecutor,
	type SqliteMigration,
} from "@earendil-works/chord/sqlite";
import type { NodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import {
	DataBundleSchema,
	DataCodecs,
	DataStore,
	DataStoreStorageInfoSchema,
	type DataBundle,
	type DatasetCodec,
	type DataImportReport,
	type DataStoreStorageInfo,
	type StoredDataset,
} from "@moonan_ai/sdk";
import { compile, num } from "@moonan_ai/sdk";
import { quarantinePath } from "./json-file.js";
import type { Principal } from "./types.js";

/** The database's own schema version; one migration per raise. */
const DATA_SCHEMA_VERSION = 1;
/** SQLite's `application_id`: ASCII "MOON", so a file says what wrote it. */
const DATA_APPLICATION_ID = 0x4d4f4f4e;
const SCHEMA_TABLE = "moonan_data_schema";
const META_TABLE = "moonan_data_meta";
const DATASET_TABLE = "moonan_data_datasets";
const MEMORY_PATH = ":memory:";

/**
 * The database schema.
 *
 * `moonan_data_meta` is a singleton row: the store's identity (`format`), revision and
 * dataset count, plus the last write time. Keeping the count in the same transaction as the
 * row changes is what lets `info()` stay cheap as the dataset table grows.
 *
 * `moonan_data_datasets` is one row per namespace. The value stays a JSON document: the
 * platform still knows nothing about a plugin's schema, and `DataCodec` still owns migration
 * and redaction. SQLite's job is the container, transactions, and a bounded write path.
 */
const MIGRATIONS: readonly SqliteMigration[] = [
	{
		version: 1,
		statements: [
			`CREATE TABLE ${META_TABLE} (
				singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
				format TEXT NOT NULL,
				revision INTEGER NOT NULL CHECK (revision >= 0),
				datasets INTEGER NOT NULL CHECK (datasets >= 0),
				updated_at TEXT
			) STRICT`,
			`CREATE TABLE ${DATASET_TABLE} (
				namespace TEXT PRIMARY KEY,
				version INTEGER NOT NULL CHECK (version >= 1),
				value TEXT NOT NULL CHECK (json_valid(value)),
				updated_at TEXT NOT NULL
			) STRICT`,
			`INSERT INTO ${META_TABLE} (singleton, format, revision, datasets, updated_at)
			 VALUES (1, 'moonan.data', 0, 0, NULL)`,
		],
	},
];

const bundleValidator = compile(DataBundleSchema);

interface MetaRow {
	format: string;
	revision: number;
	datasets: number;
	updated_at: string | null;
}

interface DatasetValueRow {
	version: number;
	value: string;
}

function nowIso(): string {
	return new Date().toISOString();
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Chord's strict-JSON deep copy; the caller already knows the shape. */
function clone<T>(value: T): T {
	return copyJson(value) as T;
}

function checkVersion(version: number): void {
	if (!Number.isInteger(version) || version < 1) {
		throw invalid("data", `dataset version must be a positive integer, got ${String(version)}`);
	}
}

function checkJson(value: unknown): asserts value is JsonValue {
	if (!isJsonValue(value)) throw invalid("data", "dataset value is not strict JSON");
}

function checkNamespace(namespace: string): void {
	if (namespace.trim().length === 0) throw invalid("data", "dataset namespace must not be empty");
}

function parseStoredValue(namespace: string, text: string): JsonValue {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw invalid("data", `dataset "${namespace}" is not valid JSON`);
	}
	checkJson(value);
	return value;
}

async function readMeta(executor: SqliteExecutor): Promise<MetaRow> {
	const row = await executor.get<MetaRow>(
		`SELECT format, revision, datasets, updated_at FROM ${META_TABLE} WHERE singleton = 1`,
	);
	if (row === undefined) throw invalid("data", "the data database is missing its meta row");
	return { ...row };
}

async function writeMeta(executor: SqliteExecutor, meta: MetaRow): Promise<void> {
	await executor.run(
		`UPDATE ${META_TABLE} SET revision = ?, datasets = ?, updated_at = ? WHERE singleton = 1`,
		meta.revision,
		meta.datasets,
		meta.updated_at,
	);
}

async function readApplicationId(executor: SqliteExecutor): Promise<number> {
	const row = await executor.get<{ application_id: number }>("PRAGMA application_id");
	return row?.application_id ?? 0;
}

async function readSchemaVersion(executor: SqliteExecutor): Promise<number> {
	const row = await executor.get<{ version: number }>(
		`SELECT version FROM ${SCHEMA_TABLE} WHERE singleton = 1`,
	);
	return row?.version ?? DATA_SCHEMA_VERSION;
}

async function readJournalMode(executor: SqliteExecutor): Promise<string | undefined> {
	const row = await executor.get<{ journal_mode: string }>("PRAGMA journal_mode");
	return row?.journal_mode;
}

async function countDatasets(executor: SqliteExecutor): Promise<number> {
	const row = await executor.get<{ count: number }>(
		`SELECT COUNT(*) AS count FROM ${DATASET_TABLE}`,
	);
	return row?.count ?? 0;
}

async function datasetExists(executor: SqliteExecutor, namespace: string): Promise<boolean> {
	const row = await executor.get<{ present: number }>(
		`SELECT 1 AS present FROM ${DATASET_TABLE} WHERE namespace = ?`,
		namespace,
	);
	return row !== undefined;
}

async function readDataset(
	executor: SqliteExecutor,
	namespace: string,
): Promise<StoredDataset | undefined> {
	const row = await executor.get<DatasetValueRow>(
		`SELECT version, value FROM ${DATASET_TABLE} WHERE namespace = ?`,
		namespace,
	);
	if (row === undefined) return undefined;
	return { version: row.version, value: parseStoredValue(namespace, row.value) };
}

async function upsertDataset(
	executor: SqliteExecutor,
	namespace: string,
	version: number,
	value: JsonValue,
	at: string,
): Promise<void> {
	await executor.run(
		`INSERT INTO ${DATASET_TABLE} (namespace, version, value, updated_at)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(namespace) DO UPDATE SET
			version = excluded.version,
			value = excluded.value,
			updated_at = excluded.updated_at`,
		namespace,
		version,
		JSON.stringify(value),
		at,
	);
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * A file that exists but is not a SQLite database, or a damaged one. `node:sqlite` reports
 * SQLite's primary result codes: 11 is `SQLITE_CORRUPT`, 26 is `SQLITE_NOTADB`.
 */
function isDatabaseCorruption(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const { errcode, message } = error as { errcode?: unknown; message?: unknown };
	if (errcode === 11 || errcode === 26) return true;
	return (
		typeof message === "string" &&
		/not a database|database disk image is malformed|file is encrypted/i.test(message)
	);
}

/** Moves a broken database (and its WAL sidecars) aside so the user still has the bytes. */
async function quarantineDatabase(path: string): Promise<string | undefined> {
	const at = Date.now();
	const target = quarantinePath(path, at);
	try {
		await rename(path, target);
	} catch {
		return undefined;
	}
	await rename(`${path}-wal`, `${target}-wal`).catch(() => undefined);
	await rename(`${path}-shm`, `${target}-shm`).catch(() => undefined);
	return target;
}

/**
 * The directory is `0700` and the database (and SQLite's WAL sidecars) `0600`: plugin data is
 * private to the user. SQLite creates `-wal`/`-shm` with 0644 on first write, so this runs
 * after every commit; the `0700` directory is the primary boundary, the file modes are the
 * second layer.
 */
async function hardenPermissions(path: string): Promise<void> {
	if (path === MEMORY_PATH) return;
	const directory = dirname(path);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await chmod(directory, 0o700).catch(() => undefined);
	await chmod(path, 0o600).catch(() => undefined);
	await chmod(`${path}-wal`, 0o600).catch(() => undefined);
	await chmod(`${path}-shm`, 0o600).catch(() => undefined);
}

/**
 * Refuses to write Moonan tables into somebody else's SQLite database.
 *
 * A fresh (empty) file is ours; an existing file must either announce our `application_id`
 * or already carry the migration table. This runs before migrations, so pointing
 * `--data-db` at an unrelated database fails instead of silently adding tables to it.
 */
async function assertMoonanDatabase(database: NodeSqliteDatabase, path: string): Promise<void> {
	const applicationId = await readApplicationId(database);
	if (applicationId !== 0 && applicationId !== DATA_APPLICATION_ID) {
		throw invalid("data", `the SQLite database at ${path} is not a Moonan data store`);
	}
	const tables = await database.all<{ name: string }>(
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
	);
	if (tables.length > 0 && !tables.some((row) => row.name === SCHEMA_TABLE)) {
		throw invalid("data", `the SQLite database at ${path} is not a Moonan data store`);
	}
}

let sqliteWarningFilterInstalled = false;

/**
 * Node 22 marks `node:sqlite` experimental and prints an ExperimentalWarning on first import.
 * That would be the first line of every `moonan` start (and would make the integration test's
 * "no stderr" assertion about a Node warning rather than about the app). Keep Node's default
 * printer for every other warning; drop only this known one.
 */
function silenceSqliteExperimentalWarning(): void {
	if (sqliteWarningFilterInstalled) return;
	sqliteWarningFilterInstalled = true;
	const listeners = process.listeners("warning");
	process.removeAllListeners("warning");
	process.on("warning", (warning) => {
		if (
			warning.name === "ExperimentalWarning" &&
			warning.message.includes("SQLite is an experimental feature")
		) {
			return;
		}
		for (const listener of listeners) (listener as (warning: Error) => void)(warning);
	});
}

/**
 * The platform's one SQLite database.
 *
 * Every plugin dataset is a row in `moonan_data_datasets`; the store revision, dataset count
 * and last write time live next to them in `moonan_data_meta`, in the same transaction as the
 * row change. The public `DataStore` contract hides the engine, so this class is the only
 * place that knows SQL.
 *
 * Writes are transactions: a failed write leaves both the rows and the revision untouched.
 * Chord's Node adapter serializes transactions on one connection, so `update` is still the
 * safe read-modify-write path.
 */
export class DataStoreDatabase {
	readonly path: string;

	private database!: NodeSqliteDatabase;
	private cachedRevision = 0;
	private cachedDatasets = 0;
	private cachedUpdatedAt: string | undefined;
	private cachedSchemaVersion = DATA_SCHEMA_VERSION;
	private cachedJournalMode: string | undefined;
	private notice: string | undefined;

	private constructor(path: string) {
		this.path = path;
	}

	static async open(path: string): Promise<DataStoreDatabase> {
		const store = new DataStoreDatabase(path);
		await store.connect();
		return store;
	}

	get revision(): number {
		return this.cachedRevision;
	}

	get datasetCount(): number {
		return this.cachedDatasets;
	}

	async info(): Promise<DataStoreStorageInfo> {
		let exists = false;
		let mode: string | undefined;
		let sizeBytes: number | undefined;
		if (this.path !== MEMORY_PATH) {
			try {
				const info = await stat(this.path);
				exists = true;
				mode = `0${(info.mode & 0o777).toString(8)}`;
				sizeBytes = info.size;
			} catch {
				/* opened from memory, or the file vanished after open */
			}
		}
		let writable = this.path === MEMORY_PATH;
		if (!writable) {
			try {
				await access(dirname(this.path), constants.W_OK);
				writable = true;
			} catch {
				/* SQLite needs the directory writable for WAL; report it */
			}
		}
		return {
			database: this.path,
			exists,
			...(mode === undefined ? {} : { mode }),
			writable,
			revision: this.cachedRevision,
			datasets: this.cachedDatasets,
			schemaVersion: this.cachedSchemaVersion,
			...(this.cachedJournalMode === undefined ? {} : { journalMode: this.cachedJournalMode }),
			...(sizeBytes === undefined ? {} : { sizeBytes }),
			...(this.cachedUpdatedAt === undefined ? {} : { lastSavedAt: this.cachedUpdatedAt }),
			...(this.notice === undefined ? {} : { notice: this.notice }),
		};
	}

	async read(namespace: string): Promise<StoredDataset | undefined> {
		const stored = await readDataset(this.database, namespace);
		return stored === undefined ? undefined : clone(stored);
	}

	async write(namespace: string, version: number, value: JsonValue): Promise<StoredDataset> {
		checkNamespace(namespace);
		checkVersion(version);
		checkJson(value);
		const stored = clone({ value, version });
		await this.commit(async (transaction) => {
			const at = nowIso();
			const meta = await readMeta(transaction);
			const existed = await datasetExists(transaction, namespace);
			await upsertDataset(transaction, namespace, version, value, at);
			meta.revision += 1;
			meta.datasets += existed ? 0 : 1;
			meta.updated_at = at;
			await writeMeta(transaction, meta);
			return { result: undefined, meta };
		});
		return stored;
	}

	/**
	 * Read-modify-write in one database transaction. This is the only safe way to update a
	 * dataset that another code version, an import, or another plugin may also touch.
	 */
	async update(
		namespace: string,
		version: number,
		update: (current: StoredDataset | undefined) => StoredDataset | Promise<StoredDataset>,
	): Promise<StoredDataset> {
		checkNamespace(namespace);
		checkVersion(version);
		return this.commit(async (transaction) => {
			const current = await readDataset(transaction, namespace);
			const produced = await update(current === undefined ? undefined : clone(current));
			checkVersion(produced.version);
			checkJson(produced.value);
			const at = nowIso();
			const meta = await readMeta(transaction);
			await upsertDataset(transaction, namespace, produced.version, produced.value, at);
			meta.revision += 1;
			meta.datasets += current === undefined ? 1 : 0;
			meta.updated_at = at;
			await writeMeta(transaction, meta);
			return { result: clone(produced), meta };
		});
	}

	async remove(namespace: string): Promise<DataStoreStorageInfo> {
		checkNamespace(namespace);
		const removed = await this.database.transaction(async (transaction) => {
			const meta = await readMeta(transaction);
			const changes = await transaction.runCounted(
				`DELETE FROM ${DATASET_TABLE} WHERE namespace = ?`,
				namespace,
			);
			if (changes === 0) return { removed: false, meta };
			const at = nowIso();
			meta.revision += 1;
			meta.datasets = Math.max(0, meta.datasets - 1);
			meta.updated_at = at;
			await writeMeta(transaction, meta);
			return { removed: true, meta };
		});
		if (removed.removed) {
			await hardenPermissions(this.path);
			this.publish(removed.meta);
		}
		return this.info();
	}

	async reload(): Promise<DataStoreStorageInfo> {
		const meta = await this.database.transaction(async (transaction) => {
			const current = await readMeta(transaction);
			const actual = await countDatasets(transaction);
			if (actual !== current.datasets) {
				current.datasets = actual;
				await writeMeta(transaction, current);
			}
			return current;
		});
		await hardenPermissions(this.path);
		this.publish(meta);
		return this.info();
	}

	async exportAll(
		codecs: { table(ctx?: Ctx): ReadonlyMap<string, DatasetCodec> },
		ctx: Ctx | undefined,
		includeSecrets: boolean,
	): Promise<DataBundle> {
		// One short transaction gives the codecs a consistent row set and revision; the codec
		// work itself runs after it commits so a slow export does not hold a write transaction.
		const snapshot = await this.database.transaction(async (transaction) => {
			const meta = await readMeta(transaction);
			const rows = await transaction.all<DatasetValueRow & { namespace: string }>(
				`SELECT namespace, version, value FROM ${DATASET_TABLE} ORDER BY namespace`,
			);
			return { revision: meta.revision, rows };
		});
		const table = codecs.table(ctx);
		const datasets: DataBundle["datasets"] = [];
		const skipped: string[] = [];
		for (const row of snapshot.rows) {
			const codec = table.get(row.namespace);
			if (codec === undefined || row.version > codec.version) {
				skipped.push(row.namespace);
				continue;
			}
			const stored = parseStoredValue(row.namespace, row.value);
			const value: unknown =
				row.version < codec.version ? codec.migrate(stored, row.version) : stored;
			const exported = codec.export(value, { includeSecrets });
			checkJson(exported);
			datasets.push({ namespace: row.namespace, version: codec.version, value: exported });
		}
		return {
			format: "moonan.data",
			formatVersion: 1,
			createdAt: nowIso(),
			revision: snapshot.revision,
			datasets,
			...(skipped.length === 0 ? {} : { skipped }),
		};
	}

	async importAll(
		codecs: { table(ctx?: Ctx): ReadonlyMap<string, DatasetCodec> },
		ctx: Ctx | undefined,
		// `DataBundle` with `unknown` values: a contract input types values as `unknown`, and
		// every row is asserted to be strict JSON below before a codec sees it.
		bundle: Omit<DataBundle, "datasets"> & {
			readonly datasets: readonly { readonly namespace: string; readonly version: number; readonly value: unknown }[];
		},
	): Promise<DataImportReport> {
		if (!bundleValidator.check(bundle)) {
			throw invalid("data", "import bundle does not match the moonan.data format");
		}
		const table = codecs.table(ctx);
		const seen = new Set<string>();
		const items: { namespace: string; version: number; value: JsonValue; codec: DatasetCodec }[] = [];
		for (const item of bundle.datasets) {
			checkNamespace(item.namespace);
			if (seen.has(item.namespace)) {
				throw invalid("data", `duplicate dataset in import bundle: ${item.namespace}`);
			}
			seen.add(item.namespace);
			const codec = table.get(item.namespace);
			if (codec === undefined) {
				throw invalid("data", `no codec registered for dataset "${item.namespace}"`);
			}
			checkJson(item.value);
			items.push({ namespace: item.namespace, version: item.version, value: item.value, codec });
		}
		if (items.length === 0) {
			const meta = await readMeta(this.database);
			return { imported: [], revision: meta.revision };
		}
		const report = await this.database.transaction(async (transaction) => {
			const meta = await readMeta(transaction);
			const at = nowIso();
			const imported: string[] = [];
			let inserted = 0;
			for (const item of items) {
				const current = await readDataset(transaction, item.namespace);
				const value = item.codec.import(item.value, item.version, current?.value);
				checkJson(value);
				await upsertDataset(transaction, item.namespace, item.codec.version, value, at);
				if (current === undefined) inserted += 1;
				imported.push(item.namespace);
			}
			meta.revision += 1;
			meta.datasets += inserted;
			meta.updated_at = at;
			await writeMeta(transaction, meta);
			return { imported: imported.sort(), meta };
		});
		await hardenPermissions(this.path);
		this.publish(report.meta);
		return { imported: report.imported, revision: report.meta.revision };
	}

	async close(): Promise<void> {
		await this.database.close();
	}

	private publish(meta: MetaRow): void {
		this.cachedRevision = meta.revision;
		this.cachedDatasets = meta.datasets;
		this.cachedUpdatedAt = meta.updated_at ?? undefined;
		this.notice = undefined;
	}

	private async commit<T>(
		task: (transaction: SqliteExecutor) => Promise<{ result: T; meta: MetaRow }>,
	): Promise<T> {
		const { result, meta } = await this.database.transaction(task);
		await hardenPermissions(this.path);
		this.publish(meta);
		return result;
	}

	private async connect(): Promise<void> {
		if (this.path !== MEMORY_PATH && (await fileExists(this.path))) {
			try {
				await this.initialize();
				return;
			} catch (error) {
				if (!isDatabaseCorruption(error)) throw error;
				const quarantined = await quarantineDatabase(this.path);
				this.notice =
					quarantined === undefined
						? `数据数据库无法读取（${errorMessage(error)}），且无法保留损坏文件。已从空数据库开始。`
						: `数据数据库无法读取（${errorMessage(error)}）。已保留为 ${quarantined}，从空数据库开始。`;
			}
		}
		await this.initialize();
	}

	private async initialize(): Promise<void> {
		silenceSqliteExperimentalWarning();
		const { openNodeSqliteDatabase } = await import("@earendil-works/chord/sqlite/node");
		const database = await openNodeSqliteDatabase(this.path);
		try {
			// The adapter has already created the file/directory with the process umask;
			// narrow them before any table or WAL sidecar is written.
			await hardenPermissions(this.path);
			await assertMoonanDatabase(database, this.path);
			await applySqliteMigrations(database, MIGRATIONS, { table: SCHEMA_TABLE });
			const meta = await readMeta(database);
			if (meta.format !== "moonan.data") {
				throw invalid("data", `the SQLite database at ${this.path} is not a Moonan data store`);
			}
			if ((await readApplicationId(database)) === 0) {
				await database.exec(`PRAGMA application_id = ${DATA_APPLICATION_ID}`);
			}
			await hardenPermissions(this.path);
			this.cachedSchemaVersion = await readSchemaVersion(database);
			this.cachedJournalMode = await readJournalMode(database);
			// Reconcile a count left stale by an external writer; opening is the one cheap moment.
			const actual = await countDatasets(database);
			if (actual !== meta.datasets) {
				meta.datasets = actual;
				await writeMeta(database, meta);
			}
			this.cachedRevision = meta.revision;
			this.cachedDatasets = meta.datasets;
			this.cachedUpdatedAt = meta.updated_at ?? undefined;
			this.database = database;
		} catch (error) {
			await database.close().catch(() => undefined);
			throw error;
		}
	}
}

export function defaultDataDb(env: NodeJS.ProcessEnv = process.env): string {
	const explicit = env.MOONAN_DATA_DB?.trim();
	if (explicit) return explicit;
	return join(env.MOONAN_HOME?.trim() || join(homedir(), ".moonan"), "data.db");
}

export interface DataFacetOptions {
	/** Absolute path of the unified data database. */
	readonly database: string;
}

/**
 * The platform's `moonan:data` facet.
 *
 * It serves only the local `DataStore`. Plugins reach it with `self.get(DataStore, {})`
 * and declare `uses: [DataStore]`; codecs are contributed to `DataCodecs` from their own
 * host-lifetime objects. The platform never imports a plugin and never interprets a
 * dataset.
 */
export function createDataFacet(options: DataFacetOptions): Facet<Principal> {
	return {
		name: "moonan:data",
		...defineFacet<Principal>((api) => {
			const codecs = api.registry(DataCodecs);
			api.serve(
				DataStore,
				(_input, _principal, self) => {
					const database = self.resource("database", {
						version: 1,
						open: () => DataStoreDatabase.open(options.database),
						close: (value) => value.close(),
					});
					const revision = self.state("revision", num(), {
						init: () => database.value.revision,
					});
					const storage = self.state("storage", DataStoreStorageInfoSchema, {
						init: () => database.value.info(),
					});
					const publish = (ctx: Ctx, info: DataStoreStorageInfo): void => {
						storage.replace(ctx, info);
						revision.replace(ctx, info.revision);
					};
					return {
						revision,
						storage,
						read: (args: { namespace: string }) => database.value.read(args.namespace),
						write: async (args, ctx) => {
							checkJson(args.value);
							const stored = await database.value.write(args.namespace, args.version, args.value);
							publish(ctx, await database.value.info());
							return stored;
						},
						update: async (args, ctx) => {
							// A local contract cannot describe a callback, so the schema types it `unknown`.
							// It therefore has to be checked here: the callback only exists in this process,
							// which is exactly why `DataStore` must stay a `local` contract.
							if (typeof args.update !== "function") {
								throw invalid(
									"args",
									"DataStore.update takes a same-process callback; the data store is local-only.",
								);
							}
							const update = args.update as (
								current: StoredDataset | undefined,
							) => StoredDataset | Promise<StoredDataset>;
							const stored = await database.value.update(args.namespace, args.version, update);
							publish(ctx, await database.value.info());
							return stored;
						},
						remove: async (args: { namespace: string }, ctx) => {
							publish(ctx, await database.value.remove(args.namespace));
						},
						reload: async (ctx) => {
							const info = await database.value.reload();
							publish(ctx, info);
							return info;
						},
						exportAll: (args: { includeSecrets?: boolean }, ctx) =>
							database.value.exportAll(codecs, ctx, args.includeSecrets ?? false),
						importAll: async (args, ctx) => {
							const report = await database.value.importAll(codecs, ctx, args.bundle);
							publish(ctx, await database.value.info());
							return report;
						},
					};
				},
				{ lifetime: "host" },
			);
		}),
	};
}
