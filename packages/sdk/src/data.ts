import { defineRegistry, local, method, type JsonValue } from "@earendil-works/chord";
import { arr, bool, literal, num, obj, opt, str, unknown } from "./schema.js";

/**
 * One value in the platform's unified data store.
 *
 * `version` belongs to the dataset, not to the file and not to the contract. A plugin
 * raises it when the stored shape or meaning changes and supplies a migration through its
 * {@link DatasetCodec}; the platform never interprets the value.
 */
export const StoredDatasetSchema = obj({
	value: unknown(),
	version: num(),
});

export type StoredDataset = {
	value: JsonValue;
	version: number;
};

/**
 * What every plugin must contribute to make its dataset exportable and importable.
 *
 * The codec is a registry value, not a Chord contract: it lives in the server host, can
 * carry functions, and never crosses a link. The platform calls it when an administrator
 * exports or imports the unified data file.
 */
export interface DatasetCodec<T = unknown> {
	/** Stable dataset key, conventionally `"<package>/<dataset>"`. */
	readonly namespace: string;
	/** Current stored shape version; see {@link StoredDataset.version}. */
	readonly version: number;
	/** Convert an older stored value to the current stored value. */
	migrate(value: JsonValue, fromVersion: number): T;
	/** Convert the current stored value to a portable export value (redact secrets here). */
	export(value: T, options: DatasetExportOptions): JsonValue;
	/**
	 * Convert an imported export value to the current stored value.
	 *
	 * `current` is the value already stored at this namespace, if any. A codec may use it
	 * to preserve secrets that a redacted export deliberately omitted.
	 */
	import(value: JsonValue, fromVersion: number, current: JsonValue | undefined): T;
}

export interface DatasetExportOptions {
	/** False by default on the HTTP surface; a codec must redact secrets when false. */
	readonly includeSecrets: boolean;
}

/** Identity helper; keeps the codec's type while documenting intent. */
export function defineDataset<T>(codec: DatasetCodec<T>): DatasetCodec<T> {
	return codec;
}

/**
 * The registry of dataset codecs.
 *
 * A contribution must come from an object of `lifetime: "host"`, like every other Chord
 * registry. The platform reads the table for the code version of the root that asks.
 */
export const DataCodecs = defineRegistry<DatasetCodec>("moonan.data-codecs", {
	conflict: "error",
});

/**
 * What the data store reports about its file. This is a state member, so a plugin can read
 * it synchronously once the store is live; the platform also exposes it over HTTP.
 */
export const DataStoreStorageInfoSchema = obj({
	file: str(),
	backup: str(),
	exists: bool(),
	mode: opt(str()),
	writable: bool(),
	revision: num(),
	datasets: num(),
	lastSavedAt: opt(str()),
	notice: opt(str()),
});

export type DataStoreStorageInfo = {
	file: string;
	backup: string;
	exists: boolean;
	mode?: string;
	writable: boolean;
	revision: number;
	datasets: number;
	lastSavedAt?: string;
	notice?: string;
};

/**
 * The wire/JSON envelope for a complete export. The file itself has a different, richer
 * shape (it also keeps per-dataset timestamps); this is the portable subset.
 */
export const DataBundleSchema = obj({
	format: literal("moonan.data"),
	formatVersion: literal(1),
	createdAt: str(),
	revision: num(),
	datasets: arr(
		obj({
			namespace: str(),
			version: num(),
			value: unknown(),
		}),
	),
	skipped: opt(arr(str())),
});

export type DataBundle = {
	format: "moonan.data";
	formatVersion: 1;
	createdAt: string;
	revision: number;
	datasets: { namespace: string; version: number; value: JsonValue }[];
	skipped?: string[];
};

export const DataImportReportSchema = obj({
	imported: arr(str()),
	revision: num(),
	skipped: opt(arr(str())),
});

export type DataImportReport = {
	imported: string[];
	revision: number;
	skipped?: string[];
};

/**
 * The platform's unified data service.
 *
 * It is local and host-lifetime: exactly one object exists for the server host, it owns
 * the only data file, and every plugin reads/writes through it. It is not a remote type;
 * browsers get data through plugin methods or the platform's export/import HTTP surface.
 *
 * `read` returns the raw `{ value, version }` and deliberately does not consult a codec:
 * a plugin's `config` cell may initialize before its codec registration is published, so
 * the plugin validates/migrates its own first value. `write` replaces a whole dataset;
 * `update` is the read-modify-write form that runs inside the store's serial queue.
 *
 * `read`'s result and `update`'s callback stay `unknown()`: `read` may return `undefined`
 * (not a JSON value) and a local contract's callback is a function, so neither can be
 * described as JSON Schema without changing the method's meaning.
 *
 * The callback is the reason this contract must stay `local`: it is passed in-process and
 * has no wire representation. The platform rejects a non-function at runtime, and no code
 * may turn `DataStore` into a `remote` type or hand it to another host.
 */
export const DataStore = local("moonan.data", {
	version: 1,
	input: obj({}, { open: true }),
	members: {
		revision: num(),
		storage: DataStoreStorageInfoSchema,
		read: method(obj({ namespace: str() }, { open: true }), unknown()),
		write: method(
			obj({ namespace: str(), version: num(), value: unknown() }, { open: true }),
			StoredDatasetSchema,
		),
		update: method(
			obj({ namespace: str(), version: num(), update: unknown() }, { open: true }),
			StoredDatasetSchema,
		),
		remove: method(obj({ namespace: str() }, { open: true })),
		reload: method(undefined, DataStoreStorageInfoSchema),
		exportAll: method(obj({ includeSecrets: opt(bool()) }, { open: true }), DataBundleSchema),
		importAll: method(obj({ bundle: DataBundleSchema }, { open: true }), DataImportReportSchema),
	},
});
