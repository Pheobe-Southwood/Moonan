import type { Facet, FacetLoader } from "@earendil-works/chord";

/**
 * Chord ships only a Node loader, so the browser needs its own. It copies `nodeLoader`'s
 * three contracts exactly:
 *
 * - a facet's **name is its URL without the query**, because `host.reload([url])` finds
 *   facets by name and a name carrying a cache-busting query could never be replaced (this
 *   loader also drops the hash, which `nodeLoader` keeps);
 * - every import is cache-busted with a fresh query, under chord's own parameter name
 *   (`chord2-reload`), so a reload loads new code instead of reusing the module the page has;
 * - a module whose default export is not a facet is refused with the same message.
 *
 * The fourth thing `nodeLoader` does cannot be copied: it carries the reload query into the
 * facet's *relative* imports through a `node:module` hook, and browsers have no module hooks.
 * So a facet here is expected to be a single file — the plugin format already says `web.js`
 * is the browser facet.
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
			url.searchParams.set("chord2-reload", String((sequence += 1)));
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
