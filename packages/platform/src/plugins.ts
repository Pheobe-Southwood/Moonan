import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Logger } from "./logger.js";
import type { PluginFacets } from "./types.js";

interface PackageJson {
	name?: string;
	version?: string;
	type?: string;
}

const SERVER_ENTRIES = ["server.mjs", "server.js"] as const;
const WEB_ENTRIES = ["web.js", "web.mjs"] as const;
const FACET_ENTRIES = [...SERVER_ENTRIES, ...WEB_ENTRIES] as const;

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function readPackage(dir: string): PackageJson | undefined {
	const path = join(dir, "package.json");
	if (!isFile(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as PackageJson;
	} catch {
		return undefined;
	}
}

function firstExisting(dir: string, candidates: readonly string[]): string | undefined {
	for (const candidate of candidates) {
		const path = join(dir, candidate);
		if (isFile(path)) return path;
	}
	return undefined;
}

/**
 * The browser URL for a facet file. The key is derived from the absolute file path, not
 * from a plugin id: a facet's identity is its module, and this is only the HTTP route that
 * serves it. `base` keeps sibling assets of a future multi-file facet inside the same
 * namespace; the loader still expects a single browser facet today.
 */
function webAsset(file: string): { file: string; url: string; base: string } {
	const key = createHash("sha256").update(file).digest("hex").slice(0, 12);
	const base = `/facets/${key}/`;
	return { file, base, url: `${base}${encodeURIComponent(basename(file))}` };
}

function fromDirectory(dir: string, ref: string): PluginFacets {
	const pkg = readPackage(dir);
	const name = basename(dir);
	const version = pkg?.version ?? "0.0.0";
	const server = firstExisting(dir, SERVER_ENTRIES);
	const webFile = firstExisting(dir, WEB_ENTRIES);

	if (!server && !webFile) {
		return {
			name,
			version,
			source: "directory",
			ref,
			error: "no facet entry (expected server.mjs, server.js, web.js or web.mjs)",
		};
	}

	if (server?.endsWith(".js") && pkg?.type !== "module") {
		return {
			name,
			version,
			source: "directory",
			ref,
			...(webFile ? { web: webAsset(webFile) } : {}),
			error: `"${basename(server)}" would load as CommonJS: rename it to .mjs or add a package.json with "type": "module"`,
		};
	}

	return {
		name,
		version,
		source: "directory",
		ref,
		...(server ? { server: pathToFileURL(server).href } : {}),
		...(webFile ? { web: webAsset(webFile) } : {}),
	};
}

/** The nearest `package.json` above a module file: what a package's label and version come from. */
function nearestPackage(file: string): PackageJson | undefined {
	let dir = dirname(file);
	for (;;) {
		const pkg = readPackage(dir);
		if (pkg) return pkg;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

function resolveFile(specifier: string): string | undefined {
	try {
		const url = import.meta.resolve(specifier);
		return url.startsWith("file:") ? url : undefined;
	} catch {
		return undefined;
	}
}

function fromPackage(specifier: string, ref: string): PluginFacets {
	// A package may export only `./web` (a browser-only plugin) or only `.` (a server-only
	// plugin). Resolve the two independently; neither is required by itself.
	const serverUrl = resolveFile(specifier);
	const webUrl = resolveFile(`${specifier}/web`);

	if (!serverUrl && !webUrl) {
		return {
			name: specifier,
			version: "0.0.0",
			source: "package",
			ref,
			error: `cannot resolve package "${specifier}" (neither "." nor "./web")`,
		};
	}

	const pkg = nearestPackage(fileURLToPath(serverUrl ?? webUrl!));
	return {
		name: pkg?.name ?? specifier,
		version: pkg?.version ?? "0.0.0",
		source: "package",
		ref,
		...(serverUrl ? { server: serverUrl } : {}),
		...(webUrl ? { web: webAsset(fileURLToPath(webUrl)) } : {}),
	};
}

/**
 * Turns what the user asked for into facet URLs.
 *
 * Two shapes, one path: a directory with a facet entry file, or an installed package whose
 * own `exports` decides the entries. Both end at module URLs the platform hands to chord;
 * only the URLs differ. A plugin has no id: the facet's module URL is its runtime identity.
 * Failures come back as records with `error` so the rest of the list still resolves and the
 * browser can show what broke.
 */
export function resolvePluginRef(ref: string, baseDir: string): PluginFacets {
	const trimmed = ref.trim();
	const asPath = isAbsolute(trimmed) ? trimmed : resolve(baseDir, trimmed);
	if (isDirectory(asPath)) return fromDirectory(asPath, ref);
	if (!existsSync(asPath) && (trimmed.startsWith(".") || isAbsolute(trimmed))) {
		return {
			name: basename(asPath),
			version: "0.0.0",
			source: "directory",
			ref,
			error: `no such directory: ${asPath}`,
		};
	}
	try {
		return fromPackage(trimmed, ref);
	} catch (error) {
		return {
			name: trimmed,
			version: "0.0.0",
			source: "package",
			ref,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/** Every subdirectory of `directory` that carries at least one facet entry file. */
export function scanPluginDirectory(directory: string, logger?: Logger): string[] {
	if (!existsSync(directory)) return [];
	const found: string[] = [];
	for (const entry of readdirSync(directory)) {
		const dir = join(directory, entry);
		if (!isDirectory(dir)) continue;
		if (!FACET_ENTRIES.some((candidate) => isFile(join(dir, candidate)))) {
			logger?.warn(`skipping ${entry}: no facet entry`);
			continue;
		}
		found.push(dir);
	}
	return found;
}
