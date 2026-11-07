import type { Schema } from "@earendil-works/pi-schema";

/**
 * The schema layer contracts are written with.
 *
 * Chord 1.5.0 describes contracts as JSON Schema and validates them through
 * `@earendil-works/pi-schema`; the builders below are that package's, re-exported so a
 * plugin still needs one dependency for contracts. `Static` and `Schema` are its types
 * (the old `TSchema` name is gone with TypeBox).
 *
 * Two forms cannot be taken from pi-schema unchanged, because a contract's fingerprint is
 * computed from its schema's JSON and the upstream builders emit different JSON:
 *
 * - {@link literal}: pi-schema's `lit(value)` emits `{ const: value }` without `type`;
 *   chord's migration table asks for `{ type: typeof value, const: value }`.
 * - {@link record}: pi-schema's `map(value)` emits `additionalProperties`, while a record
 *   is `patternProperties` — and chord's compatibility check treats the two differently.
 *
 * Use those two helpers inside contracts. Outside a contract (validating an HTTP body or a
 * data file, say) `lit` and `map` are fine; add `@earendil-works/pi-schema` directly.
 */
export {
	arr,
	bool,
	bytes,
	compile,
	int,
	nul,
	nullable,
	num,
	obj,
	oneOf,
	opt,
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
} from "@earendil-works/pi-schema";

/**
 * A literal in its fingerprint-stable JSON-Schema form.
 *
 * `typeof null` is `"object"`, so `null` takes the schema type `"null"`.
 */
export function literal<const V extends string | number | boolean | null>(value: V): Schema<V> {
	const type = value === null ? "null" : typeof value;
	return { type, const: value } as Schema<V>;
}

/**
 * A record (`Record<string, T>`) in its fingerprint-stable form.
 *
 * `patternProperties` with a match-everything pattern, not `additionalProperties`.
 */
export function record<T>(value: Schema<T>): Schema<Record<string, T>> {
	return { type: "object", patternProperties: { "^.*$": value } } as Schema<Record<string, T>>;
}
