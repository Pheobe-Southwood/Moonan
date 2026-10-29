import { local, method, type Facet, type Ref } from "@earendil-works/chord";
import { FacetSetSchema, WebFacetCatalog, type FacetSetEntry } from "@moonan_ai/sdk";
import { Type, type Static } from "typebox";

/** What every `WebFacetCatalog` instance exposes, from one host-lifetime store. */
export const WebFacetCatalogSnapshotSchema = Type.Object({
	version: Type.String(),
	facets: Type.Array(FacetSetSchema),
	revision: Type.Number(),
});
export type WebFacetCatalogSnapshot = Static<typeof WebFacetCatalogSnapshotSchema>;

/**
 * The platform's one authoritative web-facet catalog value.
 *
 * A local, host-lifetime object owns the single `snapshot` cell. Remote `WebFacetCatalog`
 * views expose its derived state members; chord handles snapshot/delta delivery to every
 * principal. There is no second copy and no fan-out code.
 */
export const WebFacetCatalogStore = local("moonan.web-facets.store", {
	version: 1,
	input: Type.Object({}),
	members: {
		version: Type.String(),
		facets: Type.Array(FacetSetSchema),
		revision: Type.Number(),
		update: method(WebFacetCatalogSnapshotSchema),
	},
});

export interface WebFacetCatalogFacetOptions {
	version: string;
	facets: FacetSetEntry[];
	revision: number;
}

/**
 * The platform facet. It serves the store and the remote view in one `setup`, so both are
 * installed in the same `host.load` batch as the plugin facets.
 */
export function createWebFacetCatalogFacet(options: WebFacetCatalogFacetOptions): Facet {
	const initial: WebFacetCatalogSnapshot = {
		version: options.version,
		facets: options.facets,
		revision: options.revision,
	};

	return {
		name: "moonan:web-facets",
		setup(api) {
			api.serve(
				WebFacetCatalogStore,
				(_input, _principal, self) => {
					const snapshot = self.state("snapshot", WebFacetCatalogSnapshotSchema, initial);
					const version = self.derive([snapshot], (value) => value.version);
					const facets = self.derive([snapshot], (value) => value.facets);
					const revision = self.derive([snapshot], (value) => value.revision);
					return {
						version,
						facets,
						revision,
						update: (next, ctx) => snapshot.replace(ctx, next),
					};
				},
				{ lifetime: "host" },
			);

			api.serve(WebFacetCatalog, (_input, _principal, self) => {
				const store = self.get(WebFacetCatalogStore, {});
				return {
					variant: "v1" as const,
					version: store.version,
					facets: store.facets,
					revision: store.revision,
				};
			});
		},
	};
}

/** The reference the platform keeps to update the store. */
export type WebFacetCatalogStoreRef = Ref<typeof WebFacetCatalogStore>;
