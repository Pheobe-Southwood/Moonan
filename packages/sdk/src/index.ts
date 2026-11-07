/**
 * `@moonan_ai/sdk` — everything a plugin needs on either side of the wire.
 *
 * The root entry is shared by the server facet and the browser facet: contracts,
 * registries (including `DataCodecs`) and the Chord primitives they are built from. Browser-only surface (the `Panels` registry and the React hooks) lives
 * in `@moonan_ai/sdk/web`, because it needs React and the root entry must stay importable
 * from a Node facet.
 */
export {
	WebFacetCatalog,
	FacetSetSchema,
	WebFacetSchema,
	type FacetSetEntry,
	type WebFacet,
} from "./web-facet-catalog.js";
export {
	DataStore,
	DataCodecs,
	DataBundleSchema,
	DataImportReportSchema,
	DataStoreStorageInfoSchema,
	StoredDatasetSchema,
	defineDataset,
	type DataBundle,
	type DataImportReport,
	type DataStoreStorageInfo,
	type DatasetCodec,
	type DatasetExportOptions,
	type StoredDataset,
} from "./data.js";
export { Routes, type RouteHandler } from "./routes.js";

/** Chord primitives, re-exported so a plugin needs two dependencies instead of three. */
export {
	ChordError,
	defineFacet,
	defineRegistry,
	forbidden,
	hostFamily,
	hostNamed,
	invalid,
	isChordError,
	local,
	method,
	opaque,
	remote,
	type AnyContract,
	type Ctx,
	type Facet,
	type FacetApi,
	type Host,
	type InputOf,
	type JsonValue,
	type LocalContract,
	type Readable,
	type Ref,
	type RefStatus,
	type Registry,
	type RegistryTable,
	type RegistryView,
	type RemoteContract,
	type Shape,
} from "@earendil-works/chord";

/** Explicit cancellation/context helpers; browser-safe, same entry points as chord. */
export {
	BACKGROUND_CONTEXT,
	awaitWithContext,
	traceIn,
	withAbortSignal,
	withCancel,
	withoutAbortSignal,
	type Context,
} from "@earendil-works/chord/context";

/**
 * The schema layer every contract is written with (pi-schema's builders), plus the two
 * fingerprint-stable forms: `literal` and `record`. See `./schema.ts`.
 */
export {
	arr,
	bool,
	bytes,
	compile,
	int,
	literal,
	nul,
	nullable,
	num,
	obj,
	oneOf,
	opt,
	record,
	str,
	tuple,
	union,
	unknown,
	type Annotations,
	type JsonSchema,
	type Optional,
	type Schema,
	type Static,
	type StaticObject,
	type ValidationError,
} from "./schema.js";
