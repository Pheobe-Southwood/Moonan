import { describe, expect, it } from "vitest";
import { officialPlugins, parseOfficialPlugins } from "../src/official.js";

describe("parseOfficialPlugins", () => {
	it("reads the refs and the locked flag from a valid manifest", () => {
		expect(
			parseOfficialPlugins({
				moonan: {
					officialPlugins: [{ ref: "@moonan_ai/plugin-manager", locked: true }, { ref: "@moonan_ai/ai-gateway" }],
				},
			}),
		).toEqual([
			{ ref: "@moonan_ai/plugin-manager", locked: true },
			{ ref: "@moonan_ai/ai-gateway", locked: false },
		]);
	});

	it("returns an empty list when the manifest has no moonan section", () => {
		expect(parseOfficialPlugins({ name: "moonan" })).toEqual([]);
	});

	it("returns an empty list when the manifest is not an object", () => {
		expect(parseOfficialPlugins(undefined)).toEqual([]);
		expect(parseOfficialPlugins(null)).toEqual([]);
		expect(parseOfficialPlugins("moonan")).toEqual([]);
		expect(parseOfficialPlugins([])).toEqual([]);
	});

	it("returns an empty list when officialPlugins is not an array", () => {
		expect(parseOfficialPlugins({ moonan: { officialPlugins: "@moonan_ai/ai-gateway" } })).toEqual([]);
		expect(parseOfficialPlugins({ moonan: { officialPlugins: { ref: "@moonan_ai/ai-gateway" } } })).toEqual([]);
		expect(parseOfficialPlugins({ moonan: { officialPlugins: null } })).toEqual([]);
		expect(parseOfficialPlugins({ moonan: { officialPlugins: undefined } })).toEqual([]);
		// `moonan` itself must be an object before its field is read.
		expect(parseOfficialPlugins({ moonan: "official" })).toEqual([]);
	});

	it("skips malformed entries instead of failing", () => {
		const parsed = parseOfficialPlugins({
			moonan: {
				officialPlugins: [
					null,
					"@moonan_ai/ai-gateway",
					42,
					{ locked: true },
					{ ref: 7 },
					{ ref: "   " },
					{ ref: "" },
					{ ref: "@moonan_ai/plugin-manager", locked: true },
				],
			},
		});
		expect(parsed).toEqual([{ ref: "@moonan_ai/plugin-manager", locked: true }]);
	});

	it("trims refs and dedupes the first occurrence", () => {
		const parsed = parseOfficialPlugins({
			moonan: {
				officialPlugins: [
					{ ref: "  @moonan_ai/ai-gateway  ", locked: true },
					{ ref: "@moonan_ai/ai-gateway" },
					{ ref: "\t@moonan_ai/plugin-manager\n" },
					"@moonan_ai/plugin-manager",
				],
			},
		});
		expect(parsed).toEqual([
			{ ref: "@moonan_ai/ai-gateway", locked: true },
			{ ref: "@moonan_ai/plugin-manager", locked: false },
		]);
	});

	it("treats locked as true only for the literal boolean true", () => {
		const parsed = parseOfficialPlugins({
			moonan: {
				officialPlugins: [
					{ ref: "a", locked: "true" },
					{ ref: "b", locked: 1 },
					{ ref: "c", locked: false },
					{ ref: "d" },
					{ ref: "e", locked: true },
				],
			},
		});
		expect(parsed).toEqual([
			{ ref: "a", locked: false },
			{ ref: "b", locked: false },
			{ ref: "c", locked: false },
			{ ref: "d", locked: false },
			{ ref: "e", locked: true },
		]);
	});
});

describe("officialPlugins", () => {
	it("reads this package's manifest and locks the plugin manager", () => {
		const official = officialPlugins();
		expect(official.length).toBeGreaterThan(0);
		const manager = official.find((plugin) => plugin.ref === "@moonan_ai/plugin-manager");
		expect(manager).toMatchObject({ ref: "@moonan_ai/plugin-manager", locked: true });
	});
});
