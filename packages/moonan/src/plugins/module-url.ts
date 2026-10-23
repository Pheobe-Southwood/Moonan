import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * A facet module URL that works both from `src` (tsx) and from `dist` (built JS):
 * prefer the `.js` the import map expects, fall back to the sibling `.ts` when the
 * source tree is what is running.
 */
export function facetModuleUrl(relative: string): URL {
	const asJs = new URL(relative, import.meta.url);
	if (existsSync(fileURLToPath(asJs))) return asJs;
	const asTs = new URL(relative.replace(/\.js$/, ".ts"), import.meta.url);
	return existsSync(fileURLToPath(asTs)) ? asTs : asJs;
}
