import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger, type Logger } from "./logger.js";
import { createPlatform, type Platform } from "./platform.js";
import { startWebServer, type WebServerHandle } from "./server.js";

export const VERSION = "0.0.4-alpha1";

export interface StartOptions {
	port?: number;
	hostname?: string;
	/** Plugins to resolve: package names or directories. */
	plugins?: readonly string[];
	/** Scanned for subdirectories that carry a facet entry file. */
	pluginsDir?: string;
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
}

export function defaultPluginsDir(): string {
	return join(homedir(), ".moonan", "plugins");
}

/** `dist/web` ships inside the package; in a dev tree `--web-dist` points at `packages/web/dist`. */
function resolveWebDist(explicit: string | undefined): string | undefined {
	const fromEnv = explicit ?? process.env.MOONAN_WEB_DIST;
	if (fromEnv) return existsSync(join(fromEnv, "index.html")) ? fromEnv : undefined;
	const candidate = fileURLToPath(new URL("./web/", import.meta.url));
	return existsSync(join(candidate, "index.html")) ? candidate : undefined;
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

	const platform = await createPlatform({
		version,
		...(options.plugins ? { plugins: options.plugins } : {}),
		pluginsDir: options.pluginsDir ?? defaultPluginsDir(),
		...(options.dev === undefined ? {} : { dev: options.dev }),
		logger: logger.child("platform"),
	});

	try {
		const server = await startWebServer({
			host: platform.host,
			port: options.port ?? 21315,
			hostname: options.hostname ?? "127.0.0.1",
			version,
			...(webDist ? { webDist } : {}),
			plugins: () => platform.plugins,
			revision: () => platform.revision,
			reload: platform.reload,
			...(options.allowedOrigins ? { allowedOrigins: options.allowedOrigins } : {}),
			...(options.maxCalls === undefined ? {} : { maxCalls: options.maxCalls }),
			logger: logger.child("http"),
		});

		return {
			port: server.port,
			url: server.url,
			server,
			get host() {
				return platform.host;
			},
			get plugins() {
				return platform.plugins;
			},
			get revision() {
				return platform.revision;
			},
			reload: platform.reload,
			close: async () => {
				await server.close();
				await platform.close();
			},
		};
	} catch (error) {
		await platform.close();
		throw error;
	}
}

export { createPlatform, type Platform, type PlatformOptions } from "./platform.js";
export { createLogger, silentLogger, type Logger } from "./logger.js";
export { resolvePluginRef, scanPluginDirectory } from "./plugins.js";
export { describe, type PluginFacets, type Principal } from "./types.js";
