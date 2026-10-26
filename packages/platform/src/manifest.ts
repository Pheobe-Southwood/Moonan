import { local, method, type Facet, type Ref } from "@earendil-works/chord";
import { FacetSetSchema, Manifest, type FacetSetEntry } from "@moonan_ai/sdk";
import { Type, type Static } from "typebox";

/** What every `Manifest` instance exposes, from one host-lifetime store. */
export const ManifestSnapshotSchema = Type.Object({
	version: Type.String(),
	facets: Type.Array(FacetSetSchema),
	revision: Type.Number(),
});
export type ManifestSnapshot = Static<typeof ManifestSnapshotSchema>;

/**
 * The platform's one authoritative manifest value.
 *
 * A local, host-lifetime object owns the single `snapshot` cell. Remote `Manifest` views
 * expose its derived state members; chord handles snapshot/delta delivery to every
 * principal. There is no second copy and no fan-out code.
 */
export const ManifestStore = local("moonan.manifest-store", {
	version: 1,
	input: Type.Object({}),
	members: {
		version: Type.String(),
		facets: Type.Array(FacetSetSchema),
		revision: Type.Number(),
		update: method(ManifestSnapshotSchema),
	},
});

export interface ManifestFacetOptions {
	version: string;
	facets: FacetSetEntry[];
	revision: number;
}

/**
 * The platform facet. It serves the store and the remote view in one `setup`, so both are
 * installed in the same `host.load` batch as the plugin facets.
 */
export function createManifestFacet(options: ManifestFacetOptions): Facet {
	const initial: ManifestSnapshot = {
		version: options.version,
		facets: options.facets,
		revision: options.revision,
	};

	return {
		name: "moonan:manifest",
		setup(api) {
			api.serve(
				ManifestStore,
				(_input, _principal, self) => {
					const snapshot = self.state("snapshot", ManifestSnapshotSchema, initial);
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

			api.serve(Manifest, (_input, _principal, self) => {
				const store = self.get(ManifestStore, {});
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
export type ManifestStoreRef = Ref<typeof ManifestStore>;
