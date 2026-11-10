import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultDataFile } from "./data.js";
import { createLogger, type Logger } from "./logger.js";
import { officialPlugins, type OfficialPluginRef } from "./official.js";
import { createPlatform, type Platform } from "./platform.js";
import { defaultPluginsFile, PluginRegistry } from "./plugin-registry.js";
import { normalizeRef, scanPluginDirectory } from "./plugins.js";
import { startWebServer, type WebServerHandle } from "./server.js";
import { errorMessage, type PluginEntry, type PluginState, type StartupReport } from "./types.js";

export const VERSION = "0.1.0-alpha1";

export interface StartOptions {
	port?: number;
	hostname?: string;
	/** Plugins to add for this process only (ephemeral, not written to the registry). */
	plugins?: readonly string[];
	/** Scanned for subdirectories that carry a facet entry file. Read-only; needs a restart. */
	pluginsDir?: string;
	/** The plugin registry file. Defaults to `MOONAN_PLUGINS_FILE` or `~/.moonan/plugins.json`. */
	pluginsFile?: string;
	/** `false` skips seeding the official defaults; an array overrides the official manifest. */
	official?: boolean | readonly OfficialPluginRef[];
	/** Load only the locked official plugins (the recovery shell); the registry is not read. */
	safeMode?: boolean;
	/** Allow the plugin-management endpoints even on a non-loopback bind. */
	allowManagement?: boolean;
	/** Absolute path of the unified plugin data file. */
	dataFile?: string;
	/** The built shell. Defaults to `MOONAN_WEB_DIST`, then the copy shipped next to this file. */
	webDist?: string;
	/** Validate every cell write against its schema (chord's `dev`). Default: off. */
	dev?: boolean;
	/** Extra browser origins accepted besides same-origin. */
	allowedOrigins?: readonly string[];
	/** chord's per-link concurrent call limit. Default: no limit. */
	maxCalls?: number;
	version?: string;
	logger?: Logger;
}

export interface Moonan extends Platform {
	port: number;
	url: string;
	server: WebServerHandle;
	pluginsFile: string;
}

export function defaultPluginsDir(env: NodeJS.ProcessEnv = process.env): string {
	return join(env.MOONAN_HOME?.trim() || join(homedir(), ".moonan"), "plugins");
}

/** Binds the management API to loopback unless the operator explicitly opts in. */
export function isLoopback(hostname: string): boolean {
	return hostname === "localhost" || hostname === "::1" || /^127\./.test(hostname);
}

/** `dist/web` ships inside the package; in a dev tree `--web-dist` points at `packages/web/dist`. */
function resolveWebDist(explicit: string | undefined): string | undefined {
	const fromEnv = explicit ?? process.env.MOONAN_WEB_DIST;
	if (fromEnv) return existsSync(join(fromEnv, "index.html")) ? fromEnv : undefined;
	const candidate = fileURLToPath(new URL("./web/", import.meta.url));
	return existsSync(join(candidate, "index.html")) ? candidate : undefined;
}

interface AssembleOptions {
	registryEntries: readonly { ref: string; enabled: boolean }[];
	official: readonly OfficialPluginRef[];
	seedOfficial: boolean;
	scanned: readonly string[];
	cli: readonly string[];
	baseDir: string;
	safeMode: boolean;
}

/**
 * Merges the persisted selection, the official defaults, the startup scan and `--plugin`.
 *
 * Registry order wins; an official plugin the registry already mentions keeps the registry's
 * enabled flag. Official flags (`builtin`/`locked`) are always derived from the current
 * manifest, never from the registry file, so an upgrade does not leave stale metadata.
 */
function assembleEntries(options: AssembleOptions): PluginEntry[] {
	const officialByRef = new Map(options.official.map((item) => [item.ref, item]));
	const entries: PluginEntry[] = [];
	const seen = new Set<string>();
	const push = (entry: PluginEntry): void => {
		if (seen.has(entry.ref)) return;
		seen.add(entry.ref);
		entries.push(entry);
	};

	if (options.safeMode) {
		for (const item of options.official) {
			if (item.locked) push({ ref: item.ref, enabled: true, builtin: true, locked: true });
		}
		return entries;
	}

	for (const item of options.registryEntries) {
		const official = officialByRef.get(item.ref);
		push({
			ref: item.ref,
			enabled: item.enabled,
			builtin: official !== undefined,
			locked: official?.locked === true,
		});
	}
	if (options.seedOfficial) {
		for (const item of options.official) push({ ref: item.ref, enabled: true, builtin: true, locked: item.locked });
	}
	for (const dir of options.scanned) push({ ref: dir, enabled: true, ephemeral: true });
	for (const ref of options.cli) {
		const normalized = normalizeRef(ref, options.baseDir);
		if (normalized.length > 0) push({ ref: normalized, enabled: true, ephemeral: true });
	}
	return entries;
}

/**
 * Starts the platform and the one port it serves.
 *
 * Everything below this line is the whole local application: a Chord host with some facets
 * in it, and a server that hands requests to them. If this looks too small to be an app,
 * that is the point — the features are plugins.
 */
export async function start(options: StartOptions = {}): Promise<Moonan> {
	const logger = options.logger ?? createLogger();
	const version = options.version ?? VERSION;
	const webDist = resolveWebDist(options.webDist);
	const dataFile = options.dataFile ?? defaultDataFile();
	const pluginsFile = options.pluginsFile ?? defaultPluginsFile();
	const pluginsDir = options.pluginsDir ?? defaultPluginsDir();
	const hostname = options.hostname ?? "127.0.0.1";
	const baseDir = process.cwd();

	const manifest = officialPlugins();
	const official = Array.isArray(options.official)
		? options.official
		: options.official === false
			? []
			: manifest;

	const registry = await PluginRegistry.open(pluginsFile);
	const entries = assembleEntries({
		registryEntries: registry.entries(),
		official,
		seedOfficial: options.official !== false,
		scanned: scanPluginDirectory(pluginsDir, logger.child("plugins")),
		cli: options.plugins ?? [],
		baseDir,
		safeMode: options.safeMode === true,
	});

	const platformOptions = {
		version,
		dataFile,
		pluginsFile,
		registry,
		...(options.dev === undefined ? {} : { dev: options.dev }),
		logger: logger.child("platform"),
	};

	let platform: Platform;
	let startup: StartupReport | undefined;
	try {
		platform = await createPlatform({ ...platformOptions, entries });
	} catch (error) {
		const message = errorMessage(error);
		logger.error("startup failed", error);
		const skipped = entries.filter((entry) => entry.enabled !== false && entry.locked !== true).map((entry) => entry.ref);
		if (skipped.length === 0) {
			await registry.close();
			throw error;
		}
		logger.warn(
			`degraded startup: leaving out ${skipped.length} plugin(s): ${skipped.join(", ")}. The registry was not changed; use the 插件 page, --safe-mode or \`moonan plugins\` to recover.`,
		);
		startup = { degraded: true, message, skipped };
		try {
			platform = await createPlatform({ ...platformOptions, entries, skipped, startup });
		} catch (fallbackError) {
			logger.error("degraded startup also failed", fallbackError);
			await registry.close();
			throw error;
		}
	}

	const managementEnabled = options.allowManagement === true || isLoopback(hostname);

	try {
		const server = await startWebServer({
			host: platform.host,
			port: options.port ?? 21315,
			hostname,
			version,
			...(webDist ? { webDist } : {}),
			plugins: () => platform.plugins,
			revision: () => platform.revision,
			reload: platform.reload,
			admin: {
				setEnabled: platform.setPluginEnabled,
				add: platform.addPlugin,
				remove: platform.removePlugin,
			},
			managementEnabled,
			pluginsFile,
			pluginsDir,
			dataFile,
			cwd: baseDir,
			registryWarning: () => registry.warning(),
			...(startup ? { startup } : {}),
			data: {
				status: platform.dataStatus,
				export: platform.exportData,
				import: platform.importData,
			},
			...(options.allowedOrigins ? { allowedOrigins: options.allowedOrigins } : {}),
			...(options.maxCalls === undefined ? {} : { maxCalls: options.maxCalls }),
			logger: logger.child("http"),
		});

		return {
			port: server.port,
			url: server.url,
			server,
			pluginsFile,
			dataFile: platform.dataFile,
			...(startup ? { startup } : {}),
			get host() {
				return platform.host;
			},
			get plugins(): PluginState[] {
				return platform.plugins;
			},
			get revision() {
				return platform.revision;
			},
			reload: platform.reload,
			setPluginEnabled: platform.setPluginEnabled,
			addPlugin: platform.addPlugin,
			removePlugin: platform.removePlugin,
			dataStatus: platform.dataStatus,
			exportData: platform.exportData,
			importData: platform.importData,
			close: async () => {
				await server.close();
				await platform.close();
				await registry.close();
			},
		};
	} catch (error) {
		await platform.close();
		await registry.close();
		throw error;
	}
}

export { createPlatform, type Platform, type PlatformOptions } from "./platform.js";
export { defaultDataFile } from "./data.js";
export { createLogger, silentLogger, type Logger } from "./logger.js";
export { officialPlugins, type OfficialPluginRef } from "./official.js";
export { defaultPluginsFile, PluginRegistry, type RegistryEntry } from "./plugin-registry.js";
export { normalizeRef, resolvePluginRef, scanPluginDirectory } from "./plugins.js";
export { adminEntry, describe, type PluginEntry, type PluginFacets, type PluginState, type Principal, type StartupReport } from "./types.js";
