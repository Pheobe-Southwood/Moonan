import { hostNamed, remote } from "@earendil-works/chord";
import { Type, type Static } from "typebox";

/**
 * One plugin's facets, as the browser needs to know them.
 *
 * `name` is a display label derived from the directory or package; it is not an identity.
 * The runtime identity of a facet is its module URL. `web` is an absolute path on this
 * server (`/facets/<key>/web.js`); a server-only plugin has none, and a plugin that failed
 * to resolve carries `error` instead — the browser still receives it, so the shell can
 * report the failure rather than show a silently missing tab.
 */
export const FacetSetSchema = Type.Object({
	name: Type.String(),
	version: Type.String(),
	/** Where the facets came from: an installed package, or a directory on disk. */
	source: Type.Union([Type.Literal("package"), Type.Literal("directory")]),
	web: Type.Optional(Type.String()),
	error: Type.Optional(Type.String()),
});
export type FacetSetEntry = Static<typeof FacetSetSchema>;

/**
 * The only object the platform publishes: which browser facets the browser host must load.
 *
 * This is the seam that keeps the platform free of feature state. The loader knows which
 * modules exist; the browser cannot find that out alone (it has no filesystem and no
 * registry to ask), so exactly one read-only object carries it across.
 */
export const Manifest = remote("moonan.manifest", {
	version: 2,
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
				 * reload that committed.
				 *
				 * A browser takes no part in cluster reload coordination, so this member is how it
				 * is told that the code behind its facets changed: the shell watches it and swaps
				 * its own facets with `host.reload` instead of reloading the page — chord's remedy
				 * for an outdated web facet is "reload its web facets". A reference whose contract
				 * no longer fits says `upgrade_required` instead, which means "this object changed
				 * under you", not "a new build exists".
				 */
				revision: Type.Number(),
			},
		},
	},
});
