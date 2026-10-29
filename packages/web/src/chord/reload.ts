/**
 * Reload the page once, with a guard so a server that is still incompatible does not make
 * the shell loop. Both a protocol mismatch and a WebFacetCatalog contract mismatch use this: the
 * old shell cannot be repaired in place, and the new build is the only thing that knows the
 * new contracts.
 */
const KEY = "moonan.reload";

export function reloadOnce(reason: string): boolean {
	const now = Date.now();
	let last = 0;
	try {
		last = Number(sessionStorage.getItem(KEY) ?? 0) || 0;
	} catch {
		// Private mode or a storage-denied context: reloading is still the right action.
	}
	if (now - last < 10_000) return false;
	try {
		sessionStorage.setItem(KEY, String(now));
	} catch {
		// The guard is best effort; the reload below is what matters.
	}
	console.warn(`[moonan] reloading page: ${reason}`);
	location.reload();
	return true;
}
