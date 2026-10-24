import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Logger } from "./util.js";

export interface DiskPlugin {
	id: string;
	name: string;
	version: string;
	dir: string;
	server: string;
	web?: string;
	error?: string;
}

interface Manifest {
	id?: string;
	name?: string;
	version?: string;
	server?: string;
	web?: string;
}

let hooksInstalled = false;

/**
 * Disk plugins live outside this package's `node_modules`, so a bare
 * `@moonan_ai/contracts` import inside `~/.moonan/plugins/x/server.js` would fail to
 * resolve. Point the shared specifiers at the copies this process already uses,
 * which also guarantees one chord/typebox instance across the boundary.
 */
export function installSharedModuleHooks(extra: Record<string, string> = {}): void {
	if (hooksInstalled) return;
	// Vitest already routes `.ts` through its own loader; a shim on top of that makes
	// Node load the source file itself, which fails. Tests import from source anyway.
	if (process.env.VITEST) return;
	hooksInstalled = true;
	const shims = new Map<string, string>();
	for (const specifier of ["@moonan_ai/contracts", "@earendil-works/chord", "typebox"]) {
		try {
			shims.set(specifier, import.meta.resolve(specifier));
		} catch {
			// optional dependency in some deployments
		}
	}
	// Whatever the app itself has installed (the plugin packages, their contract
	// subpaths) resolves from the host process, so a disk plugin can depend on a
	// published plugin's contract without its own node_modules.
	for (const [specifier, url] of Object.entries(extra)) shims.set(specifier, url);
	registerHooks({
		resolve(specifier, context, nextResolve) {
			const shim = shims.get(specifier);
			if (shim) return { url: shim, shortCircuit: true };
			return nextResolve(specifier, context);
		},
	});
}

function resolveEntry(dir: string, declared: unknown, candidates: string[]): string | undefined {
	if (typeof declared === "string" && declared) {
		const explicit = join(dir, declared);
		return existsSync(explicit) ? explicit : undefined;
	}
	for (const candidate of candidates) {
		const path = join(dir, candidate);
		if (existsSync(path)) return path;
	}
	return undefined;
}

function hasModuleType(dir: string): boolean {
	const pkgPath = join(dir, "package.json");
	if (!existsSync(pkgPath)) return false;
	try {
		const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { type?: string };
		return pkg.type === "module";
	} catch {
		return false;
	}
}

export function scanPlugins(directory: string, logger: Logger): DiskPlugin[] {
	if (!existsSync(directory)) return [];
	const plugins: DiskPlugin[] = [];
	for (const entry of readdirSync(directory)) {
		const dir = join(directory, entry);
		try {
			if (!statSync(dir).isDirectory()) continue;
		} catch {
			continue;
		}
		const manifestPath = join(dir, "plugin.json");
		if (!existsSync(manifestPath)) {
			logger.warn(`skipping ${entry}: no plugin.json`);
			continue;
		}
		let manifest: Manifest;
		try {
			manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
		} catch (error) {
			logger.error(`skipping ${entry}: plugin.json is not valid JSON`, error);
			continue;
		}
		const id = typeof manifest.id === "string" && manifest.id ? manifest.id : entry;
		const server = resolveEntry(dir, manifest.server, ["server.mjs", "server.js"]);
		if (!server) {
			logger.error(`skipping ${id}: no server entry (expected server.mjs or a "server" field in plugin.json)`);
			continue;
		}
		if (server.endsWith(".js") && !hasModuleType(dir)) {
			logger.error(
				`skipping ${id}: "${server}" is loaded as CommonJS because ${dir} has no package.json with "type": "module"; rename it to .mjs or add one`,
			);
			continue;
		}
		const webPath = join(dir, typeof manifest.web === "string" ? manifest.web : "web.js");
		plugins.push({
			id,
			name: typeof manifest.name === "string" ? manifest.name : id,
			version: typeof manifest.version === "string" ? manifest.version : "0.0.0",
			dir,
			server: pathToFileURL(server).href,
			...(existsSync(webPath) ? { web: webPath } : {}),
		});
	}
	return plugins;
}
