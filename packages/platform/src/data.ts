import { AsyncLocalStorage } from "node:async_hooks";
import { access, constants, open as openFile, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
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
import { hardenPermissions, silenceSqliteExperimentalWarning } from "./sqlite-support.js";
import type { Principal } from "./types.js";

/** The database's own schema version; one migration per raise. */
const DATA_SCHEMA_VERSION = 2;
/** SQLite's `application_id`: ASCII "MOON", so a file says what wrote it. */
const DATA_APPLICATION_ID = 0x4d4f4f4e;
const SCHEMA_TABLE = "moonan_data_schema";
const META_TABLE = "moonan_data_meta";
const DATASET_TABLE = "moonan_data_datasets";
const MEMORY_PATH = ":memory:";
/** Marks the async context of a store transaction, so re-entrant calls fail instead of hanging. */
const transactionScope = new AsyncLocalStorage<DataStoreDatabase>();

/**
 * The database schema.
 *
 * `moonan_data_meta` is a singleton row: the store's identity (`format`), revision and
 * dataset count, plus the last write time. Keeping the count in the same transaction as the
 * row changes is what lets `info()` stay cheap as the dataset table grows.
 *
 * `moonan_data_datasets` is one row per owner and namespace. The value stays a JSON
 * document: the platform still knows nothing about a plugin's schema, and `DataCodec` still
 * owns migration and redaction. SQLite's job is the container, transactions, and a bounded
 * write path.
 *
 * Schema v2 introduces the `owner` partition. It is a deliberate breaking change: this
 * project has no users yet, so the migration drops v1 rows instead of inventing an owner
 * for them (there is no correct owner to invent).
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
	{
		version: 2,
		statements: [
			`DROP TABLE ${DATASET_TABLE}`,
			`CREATE TABLE ${DATASET_TABLE} (
				owner TEXT NOT NULL CHECK (length(owner) BETWEEN 1 AND 200),
				namespace TEXT NOT NULL,
				version INTEGER NOT NULL CHECK (version >= 1),
				value TEXT NOT NULL CHECK (json_valid(value)),
				updated_at TEXT NOT NULL,
				PRIMARY KEY (owner, namespace)
			) STRICT`,
			`UPDATE ${META_TABLE} SET datasets = 0 WHERE singleton = 1`,
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

function checkOwner(owner: string): void {
	if (typeof owner !== "string" || owner.trim().length === 0) {
		throw invalid("data", "dataset owner must not be empty");
	}
	if (owner.length > 200) throw invalid("data", "dataset owner is too long");
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

async function datasetExists(
	executor: SqliteExecutor,
	owner: string,
	namespace: string,
): Promise<boolean> {
	const row = await executor.get<{ present: number }>(
		`SELECT 1 AS present FROM ${DATASET_TABLE} WHERE owner = ? AND namespace = ?`,
		owner,
		namespace,
	);
	return row !== undefined;
}

async function readDataset(
	executor: SqliteExecutor,
	owner: string,
	namespace: string,
): Promise<StoredDataset | undefined> {
	const row = await executor.get<DatasetValueRow>(
		`SELECT version, value FROM ${DATASET_TABLE} WHERE owner = ? AND namespace = ?`,
		owner,
		namespace,
	);
	if (row === undefined) return undefined;
	return { version: row.version, value: parseStoredValue(namespace, row.value) };
}

async function upsertDataset(
	executor: SqliteExecutor,
	owner: string,
	namespace: string,
	version: number,
	value: JsonValue,
	at: string,
): Promise<void> {
	await executor.run(
		`INSERT INTO ${DATASET_TABLE} (owner, namespace, version, value, updated_at)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(owner, namespace) DO UPDATE SET
			version = excluded.version,
			value = excluded.value,
			updated_at = excluded.updated_at`,
		owner,
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
function isDatabaseCorruption(error: unknown, depth = 0): boolean {
	if (depth > 8 || typeof error !== "object" || error === null) return false;
	if (error instanceof AggregateError) {
		return error.errors.some((inner) => isDatabaseCorruption(inner, depth + 1));
	}
	const { errcode, message, cause } = error as {
		errcode?: unknown;
		message?: unknown;
		cause?: unknown;
	};
	if (errcode === 11 || errcode === 26) return true;
	if (
		typeof message === "string" &&
		/not a database|database disk image is malformed|file is encrypted/i.test(message)
	) {
		return true;
	}
	return cause !== undefined && cause !== error && isDatabaseCorruption(cause, depth + 1);
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

/**
 * Refuses a foreign database before Chord opens it.
 *
 * Chord's Node adapter always turns WAL on when it opens a database, and the platform narrows
 * the file mode before migrations. Doing either to a mistyped `--data-db` target would modify
 * somebody else's database even though the open is refused, so inspect the header first and
 * let `assertMoonanDatabase` remain the authoritative check after opening.
 *
 * A WAL database is left to the post-open check: opening it read-only creates `-wal`/`-shm`
 * sidecars, while Chord's open cannot change a journal mode that is already WAL. Everything
 * else is inspected through a read-only connection, which does not write.
 */
async function assertNotForeignDatabase(
	path: string,
	databaseClass: new (path: string, options: { readOnly: boolean }) => DatabaseSync,
): Promise<void> {
	if (path === MEMORY_PATH) return;
	let size: number;
	try {
		size = (await stat(path)).size;
	} catch {
		return;
	}
	if (size < 100) return;
	let handle;
	try {
		handle = await openFile(path, "r");
	} catch {
		return;
	}
	let header: Buffer;
	try {
		header = Buffer.alloc(100);
		const { bytesRead } = await handle.read(header, 0, 100, 0);
		if (bytesRead < 100) return;
	} finally {
		await handle.close();
	}
	// The 16-byte magic of a SQLite database; anything else is handled by the corruption path.
	if (header.toString("latin1", 0, 16) !== "SQLite format 3\u0000") return;
	const applicationId = header.readUInt32BE(68);
	if (applicationId !== 0 && applicationId !== DATA_APPLICATION_ID) {
		throw invalid("data", `the SQLite database at ${path} is not a Moonan data store`);
	}
	// 1 is the rollback journal, 2 is WAL (offsets 18/19 are the write/read format versions).
	if (header.readUInt8(18) === 2 || header.readUInt8(19) === 2) return;
	let probe: DatabaseSync;
	try {
		probe = new databaseClass(path, { readOnly: true });
	} catch {
		return;
	}
	try {
		let tables: { name: string }[];
		try {
			tables = probe
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
				.all() as { name: string }[];
		} catch {
			return;
		}
		if (tables.length > 0 && !tables.some((row) => row.name === SCHEMA_TABLE)) {
			throw invalid("data", `the SQLite database at ${path} is not a Moonan data store`);
		}
	} finally {
		probe.close();
	}
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

	async read(owner: string, namespace: string): Promise<StoredDataset | undefined> {
		this.assertOutsideTransaction();
		checkOwner(owner);
		checkNamespace(namespace);
		const stored = await readDataset(this.database, owner, namespace);
		return stored === undefined ? undefined : clone(stored);
	}

	async write(owner: string, namespace: string, version: number, value: JsonValue): Promise<StoredDataset> {
		this.assertOutsideTransaction();
		checkOwner(owner);
		checkNamespace(namespace);
		checkVersion(version);
		checkJson(value);
		const stored = clone({ value, version });
		await this.commit(async (transaction) => {
			const at = nowIso();
			const meta = await readMeta(transaction);
			const existed = await datasetExists(transaction, owner, namespace);
			await upsertDataset(transaction, owner, namespace, version, value, at);
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
	 *
	 * The callback runs on the transaction's connection: calling any DataStore method from
	 * inside it would wait for the transaction that is already running. Use `current` instead.
	 */
	async update(
		owner: string,
		namespace: string,
		version: number,
		update: (current: StoredDataset | undefined) => StoredDataset | Promise<StoredDataset>,
	): Promise<StoredDataset> {
		this.assertOutsideTransaction();
		checkOwner(owner);
		checkNamespace(namespace);
		checkVersion(version);
		return this.commit(async (transaction) => {
			const current = await readDataset(transaction, owner, namespace);
			const produced = await update(current === undefined ? undefined : clone(current));
			checkVersion(produced.version);
			checkJson(produced.value);
			const at = nowIso();
			const meta = await readMeta(transaction);
			await upsertDataset(transaction, owner, namespace, produced.version, produced.value, at);
			meta.revision += 1;
			meta.datasets += current === undefined ? 1 : 0;
			meta.updated_at = at;
			await writeMeta(transaction, meta);
			return { result: clone(produced), meta };
		});
	}

	async remove(owner: string, namespace: string): Promise<DataStoreStorageInfo> {
		this.assertOutsideTransaction();
		checkOwner(owner);
		checkNamespace(namespace);
		const removed = await this.database.transaction((transaction) =>
			transactionScope.run(this, async () => {
				const meta = await readMeta(transaction);
				const changes = await transaction.runCounted(
					`DELETE FROM ${DATASET_TABLE} WHERE owner = ? AND namespace = ?`,
					owner,
					namespace,
				);
				if (changes === 0) return { removed: false, meta };
				const at = nowIso();
				meta.revision += 1;
				meta.datasets = Math.max(0, meta.datasets - changes);
				meta.updated_at = at;
				await writeMeta(transaction, meta);
				return { removed: true, meta };
			}),
		);
		if (removed.removed) {
			this.publish(removed.meta);
			await hardenPermissions(this.path).catch(() => undefined);
		}
		return this.info();
	}

	/** Delete every dataset of one owner. Used when an account is removed. */
	async removeOwner(owner: string): Promise<DataStoreStorageInfo> {
		this.assertOutsideTransaction();
		checkOwner(owner);
		const removed = await this.database.transaction((transaction) =>
			transactionScope.run(this, async () => {
				const meta = await readMeta(transaction);
				const changes = await transaction.runCounted(
					`DELETE FROM ${DATASET_TABLE} WHERE owner = ?`,
					owner,
				);
				if (changes === 0) return { removed: false, meta };
				const at = nowIso();
				meta.revision += 1;
				meta.datasets = Math.max(0, meta.datasets - changes);
				meta.updated_at = at;
				await writeMeta(transaction, meta);
				return { removed: true, meta };
			}),
		);
		if (removed.removed) {
			this.publish(removed.meta);
			await hardenPermissions(this.path).catch(() => undefined);
		}
		return this.info();
	}

	async reload(): Promise<DataStoreStorageInfo> {
		this.assertOutsideTransaction();
		const meta = await this.database.transaction((transaction) =>
			transactionScope.run(this, async () => {
				const current = await readMeta(transaction);
				const actual = await countDatasets(transaction);
				if (actual !== current.datasets) {
					current.datasets = actual;
					await writeMeta(transaction, current);
				}
				return current;
			}),
		);
		this.publish(meta);
		await hardenPermissions(this.path).catch(() => undefined);
		return this.info();
	}

	async exportAll(
		codecs: { table(ctx?: Ctx): ReadonlyMap<string, DatasetCodec> },
		ctx: Ctx | undefined,
		owner: string,
		includeSecrets: boolean,
	): Promise<DataBundle> {
		this.assertOutsideTransaction();
		checkOwner(owner);
		// One short transaction gives the codecs a consistent row set and revision; the codec
		// work itself runs after it commits so a slow export does not hold a write transaction.
		const snapshot = await this.database.transaction(async (transaction) => {
			const meta = await readMeta(transaction);
			const rows = await transaction.all<DatasetValueRow & { namespace: string }>(
				`SELECT namespace, version, value FROM ${DATASET_TABLE} WHERE owner = ? ORDER BY namespace`,
				owner,
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
		owner: string,
		// `DataBundle` with `unknown` values: a contract input types values as `unknown`, and
		// every row is asserted to be strict JSON below before a codec sees it.
		bundle: Omit<DataBundle, "datasets"> & {
			readonly datasets: readonly { readonly namespace: string; readonly version: number; readonly value: unknown }[];
		},
	): Promise<DataImportReport> {
		this.assertOutsideTransaction();
		checkOwner(owner);
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
			checkVersion(item.version);
			if (item.version > codec.version) {
				throw invalid(
					"data",
					`imported dataset "${item.namespace}" is version ${item.version}, newer than codec version ${codec.version}`,
				);
			}
			checkJson(item.value);
			items.push({ namespace: item.namespace, version: item.version, value: item.value, codec });
		}
		if (items.length === 0) {
			const meta = await readMeta(this.database);
			return { imported: [], revision: meta.revision };
		}
		const report = await this.database.transaction((transaction) =>
			transactionScope.run(this, async () => {
				const meta = await readMeta(transaction);
				const at = nowIso();
				const imported: string[] = [];
				let inserted = 0;
				for (const item of items) {
					const current = await readDataset(transaction, owner, item.namespace);
					const value = item.codec.import(item.value, item.version, current?.value);
					checkJson(value);
					await upsertDataset(transaction, owner, item.namespace, item.codec.version, value, at);
					if (current === undefined) inserted += 1;
					imported.push(item.namespace);
				}
				meta.revision += 1;
				meta.datasets += inserted;
				meta.updated_at = at;
				await writeMeta(transaction, meta);
				return { imported: imported.sort(), meta };
			}),
		);
		this.publish(report.meta);
		await hardenPermissions(this.path).catch(() => undefined);
		return { imported: report.imported, revision: report.meta.revision };
	}

	async close(): Promise<void> {
		this.assertOutsideTransaction();
		await this.database.close();
	}

	private assertOutsideTransaction(): void {
		if (transactionScope.getStore() === this) {
			throw invalid(
				"data",
				"the data store cannot be used from inside a transaction callback; use the value passed to update instead",
			);
		}
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
		const { result, meta } = await this.database.transaction((transaction) =>
			transactionScope.run(this, () => task(transaction)),
		);
		// The transaction is already committed; a permission repair must not turn a durable
		// write into an error. Publish first so the cached revision cannot lag a failed repair.
		this.publish(meta);
		await hardenPermissions(this.path).catch(() => undefined);
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
				if (quarantined === undefined) {
					throw invalid(
						"data",
						`the data database at ${this.path} is unreadable (${errorMessage(error)}) and could not be moved aside`,
					);
				}
				this.notice = `数据数据库无法读取（${errorMessage(error)}）。已保留为 ${quarantined}，从空数据库开始。`;
			}
		}
		await this.initialize();
	}

	private async initialize(): Promise<void> {
		silenceSqliteExperimentalWarning();
		const [{ openNodeSqliteDatabase }, { DatabaseSync: Database }] = await Promise.all([
			import("@earendil-works/chord/sqlite/node"),
			import("node:sqlite"),
		]);
		await assertNotForeignDatabase(this.path, Database);
		const database = await openNodeSqliteDatabase(this.path);
		try {
			await assertMoonanDatabase(database, this.path);
			// The adapter created the file/directory with the process umask; narrow them before
			// any table or WAL sidecar is written. Identity is checked first so a foreign file is
			// never chmodded.
			await hardenPermissions(this.path);
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
						read: (args: { owner: string; namespace: string }) =>
							database.value.read(args.owner, args.namespace),
						write: async (args, ctx) => {
							checkJson(args.value);
							const stored = await database.value.write(
								args.owner,
								args.namespace,
								args.version,
								args.value,
							);
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
							const stored = await database.value.update(
								args.owner,
								args.namespace,
								args.version,
								update,
							);
							publish(ctx, await database.value.info());
							return stored;
						},
						remove: async (args: { owner: string; namespace: string }, ctx) => {
							publish(ctx, await database.value.remove(args.owner, args.namespace));
						},
						removeOwner: async (args: { owner: string }, ctx) => {
							const info = await database.value.removeOwner(args.owner);
							publish(ctx, info);
							return info;
						},
						reload: async (ctx) => {
							const info = await database.value.reload();
							publish(ctx, info);
							return info;
						},
						exportAll: (args: { owner: string; includeSecrets?: boolean }, ctx) =>
							database.value.exportAll(codecs, ctx, args.owner, args.includeSecrets ?? false),
						importAll: async (args, ctx) => {
							const report = await database.value.importAll(codecs, ctx, args.owner, args.bundle);
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
