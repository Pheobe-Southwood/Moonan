import { describe, expect, it } from "vitest";
import type { FacetApi } from "@moonan_ai/sdk";
import type { PanelContribution } from "@moonan_ai/sdk/web";
import facet from "../src/web/web.js";

/**
 * The browser shell decides which tabs to show from the `Panels` table this facet registers.
 * Boot the facet against a fake `FacetApi` and inspect what it would hand the shell.
 */
describe("plugin-manager web facet", () => {
	it("registers both administrator-only panels in order", () => {
		const tables: Record<string, PanelContribution>[] = [];
		const self = {
			register: (_registry: unknown, table: Record<string, PanelContribution>) => {
				tables.push(table);
			},
		};
		const api = {
			name: "test",
			signal: new AbortController().signal,
			serve: (_type: unknown, factory: unknown) => {
				(factory as (input: unknown, principal: unknown, object: typeof self) => unknown)(
					{},
					{ kind: "host" },
					self,
				);
			},
			root: () => Promise.reject(new Error("unused in this test")),
			registry: () => undefined,
		} as unknown as FacetApi;

		facet.setup(api);

		const panels = Object.assign({}, ...tables);
		expect(panels.plugins).toMatchObject({
			id: "plugins",
			title: "插件",
			order: 90,
			adminOnly: true,
		});
		expect(panels.users).toMatchObject({
			id: "users",
			title: "用户",
			order: 100,
			adminOnly: true,
		});
		expect(typeof panels.plugins?.component).toBe("function");
		expect(typeof panels.users?.component).toBe("function");
	});
});
