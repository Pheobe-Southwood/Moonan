import {
	DataBundleSchema,
	DataImportReportSchema,
	DataStore,
	DataStoreStorageInfoSchema,
	FacetSetSchema,
	StoredDatasetSchema,
	WebFacetCatalog,
	WebFacetSchema,
} from "@moonan_ai/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { WebFacetCatalogSnapshotSchema } from "../src/web-facet-catalog.js";
import { appFor, cleanup } from "./support.js";

afterEach(cleanup);

/**
 * Canonical JSON, the same shape chord hashes into a contract fingerprint: object keys
 * sorted, `undefined` members dropped. A schema that keeps this string keeps its
 * fingerprint (chord 1.5.0: "fingerprints ... unchanged for schemas with the same JSON").
 */
function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record)
		.filter((key) => record[key] !== undefined)
		.sort();
	return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

/**
 * The schema layer's migration guard.
 *
 * Chord 1.5.0 replaces TypeBox with `@earendil-works/pi-schema`, and the JSON a builder
 * emits is what a contract's fingerprint is computed from. These snapshots are captured
 * against the TypeBox formulas and must stay byte-identical after the rewrite: a diff here
 * means an already-loaded browser tab or a prebuilt plugin would meet `contract_mismatch`
 * for no semantic reason.
 */
describe("contract schema JSON", () => {
	it("keeps every published schema's JSON", () => {
		expect({
			StoredDatasetSchema: canonical(StoredDatasetSchema),
			DataStoreStorageInfoSchema: canonical(DataStoreStorageInfoSchema),
			DataBundleSchema: canonical(DataBundleSchema),
			DataImportReportSchema: canonical(DataImportReportSchema),
			WebFacetSchema: canonical(WebFacetSchema),
			FacetSetSchema: canonical(FacetSetSchema),
			WebFacetCatalogSnapshotSchema: canonical(WebFacetCatalogSnapshotSchema),
		}).toMatchSnapshot();
	});
});

/** The identity chord actually compares: `Ref.shape.contract`, plus the member list. */
describe("contract fingerprints", () => {
	it("keeps the platform contracts' fingerprints", async () => {
		const app = await appFor([]);
		const data = await app.host.get(DataStore, {});
		const catalog = await app.host.get(WebFacetCatalog, {});
		try {
			expect({
				data: data.shape,
				catalog: catalog.shape,
			}).toMatchSnapshot();
		} finally {
			data.release();
			catalog.release();
		}
	});
});
