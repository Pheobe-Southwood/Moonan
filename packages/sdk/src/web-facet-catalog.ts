import { hostNamed, remote } from "@earendil-works/chord";
import { Type, type Static } from "typebox";

/**
 * A browser facet: the module URL and a hash of its exact file contents.
 *
 * The URL alone cannot tell a client that the file changed; a server reload with the same
 * path would otherwise look identical. The hash is what makes a browser reload only when
 * its web code actually changed.
 */
export const WebFacetSchema = Type.Object({
	/** Absolute path on this server (`/facets/<key>/web.js`). */
	url: Type.String(),
	/** SHA-256 of the file contents, truncated for display. */
	hash: Type.String(),
});
export type WebFacet = Static<typeof WebFacetSchema>;

/**
 * One plugin's facets, as the browser needs to know them.
 *
 * `name` is a display label derived from the directory or package; it is not an identity.
 * The runtime identity of a facet is its module URL. A server-only plugin has no `web`, and
 * a plugin that failed to resolve carries `error` instead — the browser still receives it,
 * so the shell can report the failure rather than show a silently missing tab.
 */
export const FacetSetSchema = Type.Object({
	name: Type.String(),
	version: Type.String(),
	/** Where the facets came from: an installed package, or a directory on disk. */
	source: Type.Union([Type.Literal("package"), Type.Literal("directory")]),
	web: Type.Optional(WebFacetSchema),
	error: Type.Optional(Type.String()),
});
export type FacetSetEntry = Static<typeof FacetSetSchema>;

/**
 * The only object the platform publishes: the catalog of browser facets the browser host
 * must load.
 *
 * This is the seam that keeps the platform free of feature state. The loader knows which
 * modules exist; the browser cannot find that out alone (it has no filesystem and no
 * registry to ask), so exactly one read-only object carries it across.
 *
 * The name is deliberately about what it carries: a catalog of web facets. It is not a
 * package manifest and it is not a general application manifest. This is a fresh contract
 * (version 1) with no compatibility adapter: an old shell gets `upgrade_required` and
 * reloads the page.
 */
export const WebFacetCatalog = remote("moonan.web-facets", {
	version: 1,
	input: Type.Object({}),
	host: hostNamed("moonan"),
	variants: {
		v1: {
			state: {
				/** The platform's own version, so a client can tell which build it is talking to. */
				version: Type.String(),
				facets: Type.Array(FacetSetSchema),
				/**
				 * chord's code version (`host.codeVersion`): 1 at startup, one higher after every
				 * reload that committed. This is Moonan application state, not chord's removed
				 * `Shape.codeVersion`; a browser decides whether to reload from each `web.hash`,
				 * and never from this number as a protocol value.
				 */
				revision: Type.Number(),
			},
		},
	},
});
