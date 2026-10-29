import { defineRegistry, local, method, type JsonValue } from "@earendil-works/chord";
import { Type } from "typebox";

/**
 * One value in the platform's unified data store.
 *
 * `version` belongs to the dataset, not to the file and not to the contract. A plugin
 * raises it when the stored shape or meaning changes and supplies a migration through its
 * {@link DatasetCodec}; the platform never interprets the value.
 */
export const StoredDatasetSchema = Type.Object(
	{
		value: Type.Any(),
		version: Type.Number(),
	},
	{ additionalProperties: false },
);

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
export const DataStoreStorageInfoSchema = Type.Object(
	{
		file: Type.String(),
		backup: Type.String(),
		exists: Type.Boolean(),
		mode: Type.Optional(Type.String()),
		writable: Type.Boolean(),
		revision: Type.Number(),
		datasets: Type.Number(),
		lastSavedAt: Type.Optional(Type.String()),
		notice: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

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
export const DataBundleSchema = Type.Object(
	{
		format: Type.Literal("moonan.data"),
		formatVersion: Type.Literal(1),
		createdAt: Type.String(),
		revision: Type.Number(),
		datasets: Type.Array(
			Type.Object(
				{
					namespace: Type.String(),
					version: Type.Number(),
					value: Type.Any(),
				},
				{ additionalProperties: false },
			),
		),
		skipped: Type.Optional(Type.Array(Type.String())),
	},
	{ additionalProperties: false },
);

export type DataBundle = {
	format: "moonan.data";
	formatVersion: 1;
	createdAt: string;
	revision: number;
	datasets: { namespace: string; version: number; value: JsonValue }[];
	skipped?: string[];
};

export const DataImportReportSchema = Type.Object(
	{
		imported: Type.Array(Type.String()),
		revision: Type.Number(),
		skipped: Type.Optional(Type.Array(Type.String())),
	},
	{ additionalProperties: false },
);

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
 */
export const DataStore = local("moonan.data", {
	version: 1,
	input: Type.Object({}),
	members: {
		revision: Type.Number(),
		storage: DataStoreStorageInfoSchema,
		read: method(Type.Object({ namespace: Type.String() }), Type.Any()),
		write: method(
			Type.Object({ namespace: Type.String(), version: Type.Number(), value: Type.Any() }),
			StoredDatasetSchema,
		),
		update: method(
			Type.Object({ namespace: Type.String(), version: Type.Number(), update: Type.Any() }),
			StoredDatasetSchema,
		),
		remove: method(Type.Object({ namespace: Type.String() })),
		reload: method(undefined, DataStoreStorageInfoSchema),
		exportAll: method(
			Type.Object({ includeSecrets: Type.Optional(Type.Boolean()) }),
			DataBundleSchema,
		),
		importAll: method(Type.Object({ bundle: DataBundleSchema }), DataImportReportSchema),
	},
});
