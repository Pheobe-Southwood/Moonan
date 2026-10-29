import { access, chmod, constants, copyFile, mkdir, open, readFile, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	invalid,
	isJsonValue,
	type Ctx,
	type Facet,
	type JsonValue,
} from "@earendil-works/chord";
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
import { Type } from "typebox";
import { Value } from "typebox/value";

const DATA_FORMAT = 1;
const MAX_DATA_FILE = 64 * 1024 * 1024;

const DatasetRowSchema = Type.Object(
	{
		version: Type.Number(),
		value: Type.Any(),
		updatedAt: Type.String(),
	},
	{ additionalProperties: false },
);

const DataDocumentSchema = Type.Object(
	{
		format: Type.Literal(DATA_FORMAT),
		revision: Type.Number(),
		updatedAt: Type.Optional(Type.String()),
		datasets: Type.Record(Type.String(), DatasetRowSchema),
	},
	{ additionalProperties: false },
);

interface DatasetRow {
	version: number;
	value: JsonValue;
	updatedAt: string;
}

interface DataDocument {
	format: typeof DATA_FORMAT;
	revision: number;
	updatedAt?: string;
	datasets: Record<string, DatasetRow>;
}

function emptyDocument(): DataDocument {
	return { format: DATA_FORMAT, revision: 0, datasets: {} };
}

function nowIso(): string {
	return new Date().toISOString();
}

function clone<T>(value: T): T {
	return structuredClone(value);
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

/**
 * One JSON file for every plugin's exportable data.
 *
 * The file is small by design in this alpha: plugin configuration and feature documents,
 * not chat transcripts or binary assets. Keeping one document gives the platform a single
 * atomic write and a single export envelope; the public `DataStore` contract hides the
 * format so a SQLite backend can replace it later.
 *
 * Every mutation runs through one queue. The in-memory document is copy-on-write: a failed
 * write leaves both the file and the published document untouched.
 */
export class DataFile {
	readonly path: string;
	readonly backup: string;
	readonly directory: string;

	private doc: DataDocument = emptyDocument();
	private mainHealthy = false;
	private notice: string | undefined;
	private queue: Promise<unknown> = Promise.resolve();

	private constructor(path: string) {
		this.path = path;
		this.backup = `${path}.bak`;
		this.directory = dirname(path);
	}

	static async open(path: string): Promise<DataFile> {
		const file = new DataFile(path);
		await file.load();
		return file;
	}

	get revision(): number {
		return this.doc.revision;
	}

	get datasetCount(): number {
		return Object.keys(this.doc.datasets).length;
	}

	async info(): Promise<DataStoreStorageInfo> {
		let exists = false;
		let mode: string | undefined;
		try {
			const info = await stat(this.path);
			exists = true;
			mode = `0${(info.mode & 0o777).toString(8)}`;
		} catch {
			/* not written yet */
		}
		let writable = false;
		try {
			await access(this.directory, constants.W_OK);
			writable = true;
		} catch {
			/* the first save creates the directory */
		}
		return {
			file: this.path,
			backup: this.backup,
			exists,
			...(mode === undefined ? {} : { mode }),
			writable,
			revision: this.doc.revision,
			datasets: this.datasetCount,
			...(this.doc.updatedAt === undefined ? {} : { lastSavedAt: this.doc.updatedAt }),
			...(this.notice === undefined ? {} : { notice: this.notice }),
		};
	}

	read(namespace: string): StoredDataset | undefined {
		const row = this.doc.datasets[namespace];
		return row === undefined ? undefined : clone({ value: row.value, version: row.version });
	}

	async write(namespace: string, version: number, value: JsonValue): Promise<StoredDataset> {
		return this.serialize(async () => {
			checkNamespace(namespace);
			checkVersion(version);
			checkJson(value);
			const next = clone(this.doc);
			next.datasets[namespace] = { version, value: clone(value), updatedAt: nowIso() };
			await this.persist(next);
			return clone({ value, version });
		});
	}

	/**
	 * Read-modify-write in the file's serial queue. This is the only safe way to update a
	 * dataset that another code version, an import, or another plugin may also touch.
	 */
	async update(
		namespace: string,
		version: number,
		update: (current: StoredDataset | undefined) => StoredDataset | Promise<StoredDataset>,
	): Promise<StoredDataset> {
		return this.serialize(async () => {
			checkNamespace(namespace);
			checkVersion(version);
			const current = this.read(namespace);
			const produced = await update(current);
			checkVersion(produced.version);
			checkJson(produced.value);
			const next = clone(this.doc);
			next.datasets[namespace] = {
				version: produced.version,
				value: clone(produced.value),
				updatedAt: nowIso(),
			};
			await this.persist(next);
			return clone(produced);
		});
	}

	async remove(namespace: string): Promise<DataStoreStorageInfo> {
		return this.serialize(async () => {
			checkNamespace(namespace);
			if (this.doc.datasets[namespace] === undefined) return this.info();
			const next = clone(this.doc);
			delete next.datasets[namespace];
			await this.persist(next);
			return this.info();
		});
	}

	async reload(): Promise<DataStoreStorageInfo> {
		return this.serialize(async () => {
			await this.load();
			return this.info();
		});
	}

	async exportAll(
		codecs: { table(ctx?: Ctx): ReadonlyMap<string, DatasetCodec> },
		ctx: Ctx | undefined,
		includeSecrets: boolean,
	): Promise<DataBundle> {
		return this.serialize(async () => {
			const table = codecs.table(ctx);
			const datasets: DataBundle["datasets"] = [];
			const skipped: string[] = [];
			for (const namespace of Object.keys(this.doc.datasets).sort()) {
				const row = this.doc.datasets[namespace]!;
				const codec = table.get(namespace);
				if (codec === undefined || row.version > codec.version) {
					skipped.push(namespace);
					continue;
				}
				let value: unknown = row.value;
				if (row.version < codec.version) value = codec.migrate(row.value, row.version);
				const exported = codec.export(value, { includeSecrets });
				checkJson(exported);
				datasets.push({ namespace, version: codec.version, value: exported });
			}
			return {
				format: "moonan.data",
				formatVersion: 1,
				createdAt: nowIso(),
				revision: this.doc.revision,
				datasets,
				...(skipped.length === 0 ? {} : { skipped }),
			};
		});
	}

	async importAll(
		codecs: { table(ctx?: Ctx): ReadonlyMap<string, DatasetCodec> },
		ctx: Ctx | undefined,
		bundle: DataBundle,
	): Promise<DataImportReport> {
		return this.serialize(async () => {
			if (!Value.Check(DataBundleSchema, bundle)) {
				throw invalid("data", "import bundle does not match the moonan.data format");
			}
			const table = codecs.table(ctx);
			const seen = new Set<string>();
			const rows = new Map<string, DatasetRow>();
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
				const current = this.doc.datasets[item.namespace]?.value;
				const value = codec.import(item.value, item.version, current);
				checkJson(value);
				rows.set(item.namespace, {
					version: codec.version,
					value: clone(value),
					updatedAt: nowIso(),
				});
			}
			if (rows.size === 0) return { imported: [], revision: this.doc.revision };
			const next = clone(this.doc);
			for (const [namespace, row] of rows) next.datasets[namespace] = row;
			await this.persist(next);
			return { imported: [...rows.keys()].sort(), revision: this.doc.revision };
		});
	}

	async close(): Promise<void> {
		await this.queue.catch(() => undefined);
	}

	private serialize<T>(task: () => Promise<T>): Promise<T> {
		const next = this.queue.then(task, task);
		this.queue = next.catch(() => undefined);
		return next;
	}

	private async load(): Promise<void> {
		const main = await this.readFile(this.path);
		if (main.kind === "missing") {
			this.mainHealthy = false;
			const backup = await this.readFile(this.backup);
			if (backup.kind === "ok") {
				this.doc = backup.value;
				this.notice = "主数据文件不存在，已从备份恢复。下次保存会重新写入主文件。";
				return;
			}
			this.doc = emptyDocument();
			this.notice = undefined;
			return;
		}
		if (main.kind === "ok") {
			this.doc = main.value;
			this.mainHealthy = true;
			this.notice = undefined;
			return;
		}
		this.mainHealthy = false;
		const backup = await this.readFile(this.backup);
		if (backup.kind === "ok") {
			this.doc = backup.value;
			this.notice = `主数据文件无法读取（${main.error}），已从备份恢复。下次保存会重新写入主文件。`;
			return;
		}
		const quarantine = `${this.path}.corrupt-${Date.now()}.json`;
		try {
			await rename(this.path, quarantine);
			this.notice = `主数据文件无法读取（${main.error}）。已保留为 ${quarantine}，从空数据开始。`;
		} catch (error) {
			this.notice = `主数据文件无法读取（${main.error}），且无法保留损坏文件：${String(error)}。从空数据开始。`;
		}
		this.doc = emptyDocument();
	}

	private async readFile(
		path: string,
	): Promise<{ kind: "missing" } | { kind: "ok"; value: DataDocument } | { kind: "bad"; error: string }> {
		let text: string;
		try {
			const info = await stat(path);
			if (info.size > MAX_DATA_FILE) return { kind: "bad", error: "file is too large" };
			text = await readFile(path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
			return { kind: "bad", error: String(error) };
		}
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch (error) {
			return { kind: "bad", error: `invalid JSON: ${String(error)}` };
		}
		if (!Value.Check(DataDocumentSchema, value)) return { kind: "bad", error: "data file does not match the moonan.data format" };
		return { kind: "ok", value: value as DataDocument };
	}

	private async persist(next: DataDocument): Promise<void> {
		next.updatedAt = nowIso();
		next.revision = this.doc.revision + 1;
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		await chmod(this.directory, 0o700).catch(() => undefined);
		const temporary = join(
			this.directory,
			`.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
		);
		const payload = `${JSON.stringify(next, null, 2)}\n`;
		const handle = await open(temporary, "w", 0o600);
		try {
			await handle.writeFile(payload, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await chmod(temporary, 0o600).catch(() => undefined);
		if (this.mainHealthy) {
			await copyFile(this.path, this.backup).catch(() => undefined);
			await chmod(this.backup, 0o600).catch(() => undefined);
		}
		await rename(temporary, this.path);
		await chmod(this.path, 0o600).catch(() => undefined);
		try {
			const directoryHandle = await open(this.directory, "r");
			try {
				await directoryHandle.sync();
			} finally {
				await directoryHandle.close();
			}
		} catch {
			/* best effort on platforms that cannot open a directory */
		}
		this.doc = next;
		this.mainHealthy = true;
		this.notice = undefined;
	}
}

export function defaultDataFile(env: NodeJS.ProcessEnv = process.env): string {
	const explicit = env.MOONAN_DATA_FILE?.trim();
	if (explicit) return explicit;
	return join(env.MOONAN_HOME?.trim() || join(homedir(), ".moonan"), "data.json");
}

export interface DataFacetOptions {
	/** Absolute path of the unified data file. */
	readonly file: string;
}

/**
 * The platform's `moonan:data` facet.
 *
 * It serves only the local `DataStore`. Plugins reach it with `self.get(DataStore, {})`
 * and declare `uses: [DataStore]`; codecs are contributed to `DataCodecs` from their own
 * host-lifetime objects. The platform never imports a plugin and never interprets a
 * dataset.
 */
export function createDataFacet(options: DataFacetOptions): Facet {
	return {
		name: "moonan:data",
		setup(api) {
			const codecs = api.registry(DataCodecs);
			api.serve(
				DataStore,
				(_input, _principal, self) => {
					const file = self.resource("file", {
						version: 1,
						open: () => DataFile.open(options.file),
						close: (value) => value.close(),
					});
					const revision = self.state("revision", Type.Number(), {
						init: () => file.value.revision,
					});
					const storage = self.state("storage", DataStoreStorageInfoSchema, {
						init: () => file.value.info(),
					});
					return {
						revision,
						storage,
						read: (args: { namespace: string }) => file.value.read(args.namespace),
						write: async (args: { namespace: string; version: number; value: JsonValue }, ctx) => {
							const stored = await file.value.write(args.namespace, args.version, args.value);
							const info = await file.value.info();
							storage.replace(ctx, info);
							revision.replace(ctx, info.revision);
							return stored;
						},
						update: async (
							args: {
								namespace: string;
								version: number;
								update: (current: StoredDataset | undefined) => StoredDataset | Promise<StoredDataset>;
							},
							ctx,
						) => {
							const stored = await file.value.update(args.namespace, args.version, args.update);
							const info = await file.value.info();
							storage.replace(ctx, info);
							revision.replace(ctx, info.revision);
							return stored;
						},
						remove: async (args: { namespace: string }, ctx) => {
							const info = await file.value.remove(args.namespace);
							storage.replace(ctx, info);
							revision.replace(ctx, info.revision);
						},
						reload: async (ctx) => {
							const info = await file.value.reload();
							storage.replace(ctx, info);
							revision.replace(ctx, info.revision);
							return info;
						},
						exportAll: (args: { includeSecrets?: boolean }, ctx) =>
							file.value.exportAll(codecs, ctx, args.includeSecrets ?? false),
						importAll: async (args: { bundle: DataBundle }, ctx) => {
							const report = await file.value.importAll(codecs, ctx, args.bundle);
							const info = await file.value.info();
							storage.replace(ctx, info);
							revision.replace(ctx, info.revision);
							return report;
						},
					};
				},
				{ lifetime: "host" },
			);
		},
	};
}
