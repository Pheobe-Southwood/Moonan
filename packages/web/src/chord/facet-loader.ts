import type { Facet, FacetLoader } from "@earendil-works/chord";

/**
 * Chord ships only a Node loader, so the browser needs its own. It mirrors chord's
 * `nodeLoader` in the two details that matter:
 *
 * - a facet's **name is its URL without a query**. `host.reload([url])` finds facets by
 *   name, so a name that carried `?v=…` could never be replaced;
 * - every import is cache-busted with a fresh `?v=<n>`, so a reload really loads new code
 *   instead of reusing the module the page already has.
 *
 * A relative import inside a browser facet is not rewritten (browsers have no module
 * hooks), so a facet is expected to be a single file — the plugin format already says
 * `web.js` is the browser facet.
 */
export function browserFacetLoader(): FacetLoader {
	let sequence = 0;
	return async (modules) => {
		const facets: Facet[] = [];
		for (const module of modules) {
			const base = new URL(String(module), location.href);
			base.search = "";
			base.hash = "";
			const name = base.href;

			const url = new URL(name);
			url.searchParams.set("v", String((sequence += 1)));
			const loaded = (await import(/* @vite-ignore */ url.href)) as { default?: Facet };
			const definition = loaded.default;
			if (definition === undefined || typeof definition.setup !== "function") {
				throw new TypeError(`${name}: default export must be a facet (defineFacet)`);
			}
			facets.push({
				name,
				setup: definition.setup,
				...(definition.uses ? { uses: definition.uses } : {}),
			});
		}
		return facets;
	};
}
