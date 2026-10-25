import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Logger } from "./logger.js";
import type { PluginRecord } from "./types.js";

interface Manifest {
	id?: string;
	name?: string;
	version?: string;
	server?: string;
	web?: string;
}

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

function readManifest(dir: string): Manifest | undefined {
	const path = join(dir, "plugin.json");
	if (!isFile(path)) return undefined;
	return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

/** Node treats a `.js` file in a directory without `"type": "module"` as CommonJS. */
function declaresEsm(dir: string): boolean {
	const path = join(dir, "package.json");
	if (!isFile(path)) return false;
	try {
		return (JSON.parse(readFileSync(path, "utf8")) as { type?: string }).type === "module";
	} catch {
		return false;
	}
}

function firstExisting(dir: string, candidates: readonly string[]): string | undefined {
	for (const candidate of candidates) {
		const path = join(dir, candidate);
		if (isFile(path)) return path;
	}
	return undefined;
}

/** A plugin id has to survive a URL path segment. */
function sanitizeId(raw: string): string {
	return raw.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "plugin";
}

function webAsset(id: string, file: string): { file: string; url: string } {
	return { file, url: `/plugins/${encodeURIComponent(id)}/${basename(file)}` };
}

function fromDirectory(dir: string, ref: string): PluginRecord {
	const manifest = readManifest(dir);
	if (!manifest) {
		return { id: sanitizeId(basename(dir)), name: basename(dir), version: "0.0.0", source: "directory", ref, error: "no plugin.json" };
	}
	const id = sanitizeId(manifest.id ?? basename(dir));
	const name = manifest.name ?? id;
	const version = manifest.version ?? "0.0.0";
	const declared = typeof manifest.server === "string" && manifest.server ? join(dir, manifest.server) : undefined;
	const server = declared && isFile(declared) ? declared : firstExisting(dir, ["server.mjs", "server.js"]);
	if (!server) {
		return { id, name, version, source: "directory", ref, error: 'no server entry (expected a "server" field, server.mjs or server.js)' };
	}
	if (server.endsWith(".js") && !declaresEsm(dir)) {
		return {
			id,
			name,
			version,
			source: "directory",
			ref,
			error: `"${basename(server)}" would load as CommonJS: rename it to .mjs or add a package.json with "type": "module"`,
		};
	}
	const webFile = join(dir, typeof manifest.web === "string" && manifest.web ? manifest.web : "web.js");
	return {
		id,
		name,
		version,
		source: "directory",
		ref,
		server: pathToFileURL(server).href,
		...(isFile(webFile) ? { web: webAsset(id, webFile) } : {}),
	};
}

/** The nearest `package.json` above a module file: what a package plugin's id and version come from. */
function nearestManifest(file: string): { dir: string; pkg: { name?: string; version?: string } } | undefined {
	let dir = dirname(file);
	for (;;) {
		const candidate = join(dir, "package.json");
		if (isFile(candidate)) {
			try {
				return { dir, pkg: JSON.parse(readFileSync(candidate, "utf8")) as { name?: string; version?: string } };
			} catch {
				return undefined;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

function fromPackage(specifier: string, ref: string): PluginRecord {
	let serverUrl: string;
	try {
		serverUrl = import.meta.resolve(specifier);
	} catch {
		return { id: sanitizeId(specifier), name: specifier, version: "0.0.0", source: "package", ref, error: `cannot resolve package "${specifier}"` };
	}
	if (!serverUrl.startsWith("file:")) {
		return { id: sanitizeId(specifier), name: specifier, version: "0.0.0", source: "package", ref, error: `"${specifier}" resolved to ${serverUrl}, which is not a file URL` };
	}
	const manifest = nearestManifest(fileURLToPath(serverUrl));
	const id = sanitizeId(manifest?.pkg.name?.split("/").pop() ?? specifier.split("/").pop() ?? specifier);
	let web: { file: string; url: string } | undefined;
	try {
		const webUrl = import.meta.resolve(`${specifier}/web`);
		if (webUrl.startsWith("file:")) web = webAsset(id, fileURLToPath(webUrl));
	} catch {
		// A server-only plugin: no `./web` export.
	}
	return {
		id,
		name: manifest?.pkg.name ?? specifier,
		version: manifest?.pkg.version ?? "0.0.0",
		source: "package",
		ref,
		server: serverUrl,
		...(web ? { web } : {}),
	};
}

/**
 * Turns what the user asked for into module URLs.
 *
 * Two shapes, one path: a directory (with `plugin.json`) or an installed package
 * (`import.meta.resolve`, so its own `exports` decides the entries). Both end at a module
 * URL the substrate hands to chord's loader; only the URL differs. Failures come back as
 * records with `error` so the rest of the list still loads and the browser can show what broke.
 */
export function resolvePluginRef(ref: string, baseDir: string): PluginRecord {
	const trimmed = ref.trim();
	const asPath = isAbsolute(trimmed) ? trimmed : resolve(baseDir, trimmed);
	if (isDirectory(asPath)) return fromDirectory(asPath, ref);
	if (!existsSync(asPath) && (trimmed.startsWith(".") || isAbsolute(trimmed))) {
		return { id: sanitizeId(basename(asPath)), name: trimmed, version: "0.0.0", source: "directory", ref, error: `no such directory: ${asPath}` };
	}
	try {
		return fromPackage(trimmed, ref);
	} catch (error) {
		return {
			id: sanitizeId(trimmed),
			name: trimmed,
			version: "0.0.0",
			source: "package",
			ref,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/** Every subdirectory of `directory` that carries a `plugin.json`. */
export function scanPluginDirectory(directory: string, logger?: Logger): string[] {
	if (!existsSync(directory)) return [];
	const found: string[] = [];
	for (const entry of readdirSync(directory)) {
		const dir = join(directory, entry);
		if (!isDirectory(dir)) continue;
		if (!isFile(join(dir, "plugin.json"))) {
			logger?.warn(`skipping ${entry}: no plugin.json`);
			continue;
		}
		found.push(dir);
	}
	return found;
}
