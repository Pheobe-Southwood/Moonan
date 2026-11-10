import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The official plugins this platform build ships with.
 *
 * The list lives in this package's `package.json` (`moonan.officialPlugins`), next to the
 * `optionalDependencies` that install those packages. Keeping it as data means the platform
 * source never names a plugin package — the layering test forbids plugin package names in
 * `packages/platform/src` — and the packaging test can assert both halves agree.
 *
 * If the manifest is missing or malformed, the platform still starts with no built-ins: a
 * hand-edited `package.json` must not make the server unlaunchable.
 */
export interface OfficialPluginRef {
	/** A package name or directory, exactly as the user would pass `--plugin`. */
	ref: string;
	/** The plugin manager: the UI must not disable the page that manages plugins. */
	locked?: boolean;
}

/**
 * Parse a platform manifest (`package.json`) into the official plugin list.
 *
 * Pure on purpose: the file read and the tolerance policy are separated, so the parsing
 * rules are testable without touching disk. Anything malformed is skipped rather than
 * fatal, and `locked` is only true for the literal `true`.
 */
export function parseOfficialPlugins(manifest: unknown): OfficialPluginRef[] {
	if (typeof manifest !== "object" || manifest === null) return [];
	const moonan = (manifest as { moonan?: unknown }).moonan;
	if (typeof moonan !== "object" || moonan === null) return [];
	const raw = (moonan as { officialPlugins?: unknown }).officialPlugins;
	if (!Array.isArray(raw)) return [];

	const seen = new Set<string>();
	const list: OfficialPluginRef[] = [];
	for (const item of raw) {
		if (typeof item !== "object" || item === null) continue;
		const entry = item as { ref?: unknown; locked?: unknown };
		if (typeof entry.ref !== "string" || entry.ref.trim().length === 0) continue;
		const ref = entry.ref.trim();
		if (seen.has(ref)) continue;
		seen.add(ref);
		list.push({ ref, locked: entry.locked === true });
	}
	return list;
}

let cached: readonly OfficialPluginRef[] | undefined;

export function officialPlugins(): readonly OfficialPluginRef[] {
	if (cached) return cached;
	try {
		const file = fileURLToPath(new URL("../package.json", import.meta.url));
		cached = parseOfficialPlugins(JSON.parse(readFileSync(file, "utf8")));
	} catch {
		cached = [];
	}
	return cached;
}
