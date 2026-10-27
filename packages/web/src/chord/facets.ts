import type { Host } from "@earendil-works/chord";
import type { FacetSetEntry } from "@moonan_ai/sdk";
import { useEffect, useRef, useState } from "react";

/** What the shell needs from a host to swap its facet set; `Host` satisfies it structurally. */
export type FacetBatchHost = Pick<Host<unknown>, "load" | "reload" | "ready">;

export interface FacetBatchState {
	/** Signature of the facet set that is installed now. Empty until the first successful install. */
	signature: string;
	/** Failures of later reloads; the previous facets keep running. */
	failures: string[];
	/** The first install failed; the page needs a reload (chord's install is not a rollback). */
	batchFailure: string | null;
}

/** The web-facet signature: `url#hash`, sorted, so order changes do not reload anything. */
export function facetSignature(facets: readonly FacetSetEntry[]): string {
	return (
		facets
			.filter((facet) => facet.web)
			.map((facet) => `${facet.web!.url}#${facet.web!.hash}`)
			.sort()
			.join("|") || "none"
	);
}

/**
 * Keeps the browser host's facet set in step with the manifest.
 *
 * Chord owns the transaction and the compatibility decision: `host.load` installs and (unless
 * deferred) waits for host objects, and `host.reload` resolves at the commit, before host
 * objects activate. The ledger therefore advances at the commit, not before the request and
 * not only after `ready()`: a failing activation does not roll the code back, so forgetting
 * the commit would make the next manifest publish look like no change at all. A reload that
 * rejects before the commit is transactional — the old facets keep running — and the old
 * signature stays, so the next manifest publish retries.
 *
 * The web hash is only a "this module changed" trigger. Whether the new module fits the
 * provider contract remains chord's decision (`contract_mismatch`/`upgrade_required`).
 */
export function useFacetBatches(
	host: FacetBatchHost | null,
	live: boolean,
	facets: readonly FacetSetEntry[],
): FacetBatchState {
	const installed = useRef<{ host: FacetBatchHost; urls: string[]; signature: string } | null>(null);
	const [signature, setSignature] = useState("");
	const [failures, setFailures] = useState<string[]>([]);
	const [batchFailure, setBatchFailure] = useState<string | null>(null);

	useEffect(() => {
		if (!host || !live) return;

		const urls = facets.filter((facet) => facet.web).map((facet) => facet.web!.url);
		const next = facetSignature(facets);
		const ledger = installed.current;
		// A replaced host starts with no facets, whatever the previous host had installed.
		const previous = ledger !== null && ledger.host === host ? ledger : null;
		if (ledger !== null && previous === null) setSignature("");
		// The first install always runs; later batches only when the manifest reports a change.
		if (previous !== null && previous.signature === next) return;
		const removed = previous === null ? [] : previous.urls.filter((url) => !urls.includes(url));
		let current = true;

		void (async () => {
			let failure: string | undefined;
			try {
				if (previous === null) {
					// Install and activation are separate in chord: installing first lets the ledger
					// record what is installed even when a host object later fails to activate.
					await host.load(urls, { awaitHostObjects: false });
					installed.current = { host, urls, signature: next };
					setSignature(next);
					await host.ready();
				} else {
					// Resolves at the commit (guide: "host.reload resolves at commit; it does not
					// wait for the new host objects"). Advance before waiting for activation.
					await host.reload(urls, removed.length > 0 ? { remove: removed } : {});
					installed.current = { host, urls, signature: next };
					setSignature(next);
					await host.ready();
				}
			} catch (cause) {
				failure = cause instanceof Error ? cause.message : String(cause);
				console.error("[chord] facet batch failed", cause);
			}
			if (!current) return;
			if (failure === undefined) {
				setFailures([]);
				setBatchFailure(null);
				return;
			}
			// A first install that failed cannot be recovered in place: chord's install is not a
			// rollback transaction, so the shell asks for a page reload. A later reload is
			// transactional on chord's side; the old facets still run and a banner is enough.
			if (previous === null) setBatchFailure(failure);
			else setFailures([`facet batch: ${failure}`]);
		})();

		return () => {
			current = false;
		};
	}, [host, live, facets]);

	return { signature, failures, batchFailure };
}
