import { describe, expect, it } from "vitest";
import { gatewayOptions } from "../src/catalog.js";
import { API_IDS } from "../src/schema.js";

/**
 * The compat form is generated from pi-ai's own JSON Schemas, so a pi-ai upgrade can
 * change the UI without changing a single type. This snapshot is the canary: it records
 * which fields each API offers and what kind each field is.
 *
 * pi-ai 1.5.0 rebuilt those schemas with `@earendil-works/pi-schema`; the JSON is
 * documented as unchanged, and this test pins that claim for the nine APIs we ship.
 */
describe("compat form derived from pi-ai", () => {
	it("keeps every API's compat fields", () => {
		const options = gatewayOptions();
		expect(
			options.apis.map((api) => ({
				id: api.id,
				fields: api.compatFields.map((field) => `${field.key}:${field.kind}`),
			})),
		).toMatchSnapshot();
	});

	it("describes every API this build advertises", () => {
		const options = gatewayOptions();
		expect(options.apis.map((api) => api.id)).toEqual([...API_IDS]);
		expect(options.apis.every((api) => api.label.length > 0)).toBe(true);
	});
});
