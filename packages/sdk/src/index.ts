/**
 * `@moonan_ai/sdk` — everything a plugin needs on either side of the wire.
 *
 * The root entry is shared by the server facet and the browser facet: contracts,
 * registries and the Chord primitives they are built from. Browser-only surface (the
 * `Panels` registry and the React hooks) lives in `@moonan_ai/sdk/web`, because it needs
 * React and the root entry must stay importable from a Node facet.
 */
export { Manifest, PluginEntrySchema, type PluginEntry } from "./manifest.js";
export { Routes, type RouteHandler } from "./routes.js";

/** Chord primitives, re-exported so a plugin needs two dependencies instead of three. */
export {
	defineFacet,
	defineRegistry,
	hostFamily,
	hostNamed,
	local,
	method,
	opaque,
	remote,
	type AnyContract,
	type Ctx,
	type Facet,
	type FacetApi,
	type Host,
	type JsonValue,
	type LocalContract,
	type Ref,
	type Registry,
	type RegistryTable,
	type RegistryView,
	type RemoteContract,
} from "@earendil-works/chord";

/** The schema builder every contract is written with. */
export { Type, type Static, type TSchema } from "typebox";
