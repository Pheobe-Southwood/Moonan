import type { Host } from "@earendil-works/chord";
import type { FacetSetEntry } from "@moonan_ai/sdk";
import { useEffect, useRef, useState } from "react";
import { facetUrl } from "./facet-loader.js";

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

/** One web facet with its Chord identity: the absolute module URL and the content hash. */
export interface WebFacetId {
	/** `facet.name` after loading: absolute, no query, no hash. */
	url: string;
	/** The content hash the catalog published; only a "this module changed" trigger. */
	hash: string;
}

/**
 * The catalog's web facets, canonicalized before they reach Chord.
 *
 * The loader names a facet by its absolute module URL, while the catalog publishes
 * root-relative paths; Chord looks facets up by name (notably in `reload(..., { remove })`),
 * so `/facets/x/web.js` and `http://host/facets/x/web.js` must never both exist.
 */
export function webFacets(facets: readonly FacetSetEntry[]): WebFacetId[] {
	return facets
		.filter((facet) => facet.web)
		.map((facet) => ({ url: facetUrl(facet.web!.url), hash: facet.web!.hash }));
}

/** The web-facet signature: `url#hash`, sorted, so order changes do not reload anything. */
export function facetSignature(facets: readonly FacetSetEntry[]): string {
	return (
		webFacets(facets)
			.map((facet) => `${facet.url}#${facet.hash}`)
			.sort()
			.join("|") || "none"
	);
}

interface InstalledBatch {
	host: FacetBatchHost;
	urls: string[];
	hashes: Map<string, string>;
	signature: string;
}

function signatureOf(facets: readonly WebFacetId[]): string {
	return facets.map((facet) => `${facet.url}#${facet.hash}`).sort().join("|") || "none";
}

/**
 * Keeps the browser host's facet set in step with the WebFacetCatalog.
 *
 * Chord owns the transaction and the compatibility decision. Two rules shape this code:
 *
 * - the first batch is a `host.load`: chord's one-call startup, which installs every facet
 *   and then waits for its host objects. Install is not a rollback transaction, so the
 *   ledger records the batch even when activation fails — the shell then asks for a page
 *   reload instead of retrying an `install` that chord would refuse.
 * - later batches are a `host.reload` of only the facets whose URL or content hash changed,
 *   plus `remove` for the ones that left. Facets missing from the list keep running
 *   unchanged, with their objects, cells and registry contributions intact; re-listing one
 *   would re-run its `setup` and mark all its types changed. `reload` resolves at the
 *   commit, so the ledger advances there and `host.ready()` is the activation barrier after
 *   it. A reload that fails before its commit is transactional: the ledger stays on the old
 *   batch, so nothing is recorded that is not installed.
 *
 * The web hash is only a "this module changed" trigger. Whether the new module fits the
 * provider contract remains chord's decision (`contract_mismatch`/`upgrade_required`).
 */
export function useFacetBatches(
	host: FacetBatchHost | null,
	live: boolean,
	facets: readonly FacetSetEntry[],
): FacetBatchState {
	const installed = useRef<InstalledBatch | null>(null);
	const [signature, setSignature] = useState("");
	const [failures, setFailures] = useState<string[]>([]);
	const [batchFailure, setBatchFailure] = useState<string | null>(null);

	useEffect(() => {
		if (!host || !live) return;

		const entries = webFacets(facets);
		const urls = entries.map((facet) => facet.url);
		const hashes = new Map(entries.map((facet) => [facet.url, facet.hash]));
		const next = signatureOf(entries);
		const ledger = installed.current;
		// A replaced host starts with no facets, whatever the previous host had installed.
		const previous = ledger !== null && ledger.host === host ? ledger : null;
		if (ledger !== null && previous === null) setSignature("");
		// The first install always runs; later batches only when the WebFacetCatalog reports a change.
		if (previous !== null && previous.signature === next) return;

		const added = previous === null ? urls : urls.filter((url) => !previous.urls.includes(url));
		const changed =
			previous === null
				? []
				: entries
						// A new URL is `added`; only an already-installed URL can be "changed".
						.filter((facet) => previous.hashes.has(facet.url) && previous.hashes.get(facet.url) !== facet.hash)
						.map((facet) => facet.url);
		const removed = previous === null ? [] : previous.urls.filter((url) => !urls.includes(url));
		let current = true;

		void (async () => {
			let failure: string | undefined;
			try {
				if (previous === null) {
					try {
						await host.load(urls);
					} finally {
						// `load` installs before it waits; a failed activation leaves the facets in
						// place, so the ledger must record them or the next attempt would `install`
						// an already-installed facet.
						installed.current = { host, urls, hashes, signature: next };
						setSignature(next);
					}
					return;
				}

				const reload = [...changed, ...added];
				if (reload.length > 0 || removed.length > 0) {
					await host.reload(reload, removed.length > 0 ? { remove: removed } : {});
				}
				// Resolves at the commit: record it now, then wait for the new host objects.
				installed.current = { host, urls, hashes, signature: next };
				setSignature(next);
				await host.ready();
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
			// rollback transaction, so the shell asks for a page reload. A later reload that
			// failed before its commit is transactional on chord's side; the old facets still
			// run and a banner is enough.
			if (previous === null) setBatchFailure(failure);
			else setFailures([`facet batch: ${failure}`]);
		})();

		return () => {
			current = false;
		};
	}, [host, live, facets]);

	return { signature, failures, batchFailure };
}
