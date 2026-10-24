import type { Facet, FacetLoader } from "@earendil-works/chord";

/**
 * Chord ships only a Node loader: browsers are not reload participants, so a browser
 * facet is imported once per page load. The query string defeats the module cache when
 * a reconnect builds a fresh host, which is what keeps two hosts from sharing facets.
 *
 * Experimental: this is Moonan's own extension of chord, not part of its protocol.
 */
export function browserFacetLoader(generation: number): FacetLoader {
	return async (modules) => {
		const facets: Facet[] = [];
		for (const module of modules) {
			const url = new URL(String(module), location.href);
			url.searchParams.set("v", String(generation));
			const loaded = (await import(/* @vite-ignore */ url.href)) as { default?: Facet };
			const definition = loaded.default;
			if (definition === undefined || typeof definition.setup !== "function") {
				throw new TypeError(`${url.href}: default export must be a facet (defineFacet)`);
			}
			facets.push({
				name: url.href,
				setup: definition.setup,
				...(definition.uses ? { uses: definition.uses } : {}),
			});
		}
		return facets;
	};
}
