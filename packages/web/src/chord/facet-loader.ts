import type { Facet, FacetLoader } from "@earendil-works/chord";

/**
 * Chord ships only a Node loader, so the browser needs its own. It mirrors the parts of
 * `nodeLoader` that are contract, not implementation detail:
 *
 * - a facet's **name is its URL without the query**, because `host.reload([url])` finds
 *   facets by name and a name carrying a cache-busting query could never be replaced (this
 *   loader also drops the hash, which `nodeLoader` keeps);
 * - every import is cache-busted with a fresh query, so a reload loads new code instead of
 *   reusing the module the page has;
 * - a module whose default export is not a facet is refused with the same message.
 *
 * The query parameter is this app's, not Chord's: `nodeLoader`'s parameter is a private
 * detail, and on the browser side any fresh query defeats the module cache. What cannot be
 * copied is `nodeLoader`'s resolve hook that carries the reload query into the facet's
 * *relative* imports (`node:module` has no browser equivalent). A browser facet is therefore
 * expected to be a single bundled file — the plugin format already says `web.js` is the
 * browser facet, and each plugin builds it with its shared runtime externalized.
 */
/**
 * The canonical facet name: absolute, no query, no hash.
 *
 * The loader names a facet by this string, and chord's `reload(..., { remove })` looks
 * removed facets up by **name**. The catalog publishes root-relative URLs (`/facets/...`),
 * so the shell must canonicalize before calling load/reload; otherwise an existing facet
 * silently fails to be removed because `/facets/x/web.js` and `http://host/facets/x/web.js`
 * are different names.
 */
export function facetUrl(url: string): string {
	const resolved = new URL(url, location.href);
	resolved.search = "";
	resolved.hash = "";
	return resolved.href;
}

export function browserFacetLoader(): FacetLoader {
	let sequence = 0;
	return async (modules) => {
		const facets: Facet[] = [];
		for (const module of modules) {
			const name = facetUrl(String(module));
			const url = new URL(name);
			url.searchParams.set("moonan-reload", String((sequence += 1)));
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
