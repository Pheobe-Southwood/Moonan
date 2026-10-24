import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSubstrate, type Substrate } from "./host.js";
import { createLogger, type Logger } from "./logger.js";
import { startWebServer, type WebServerHandle } from "./server.js";

export const VERSION = "0.0.2-alpha1";

export interface StartOptions {
	port?: number;
	hostname?: string;
	/** Plugins to load: package names or directories. */
	plugins?: readonly string[];
	/** Scanned for subdirectories that carry a `plugin.json`. */
	pluginsDir?: string;
	/** The built shell. Defaults to `MOONAN_WEB_DIST`, then the copy shipped next to this file. */
	webDist?: string;
	version?: string;
	logger?: Logger;
}

export interface Moonan extends Substrate {
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
 * Starts the substrate and the one port it serves.
 *
 * Everything below this line is the whole application: a Chord host with some plugins in
 * it, and a server that hands requests to them. If this looks too small to be an app,
 * that is the point — the app is the plugins.
 */
export async function start(options: StartOptions = {}): Promise<Moonan> {
	const logger = options.logger ?? createLogger();
	const version = options.version ?? VERSION;
	const webDist = resolveWebDist(options.webDist);

	const substrate = await createSubstrate({
		version,
		...(options.plugins ? { plugins: options.plugins } : {}),
		pluginsDir: options.pluginsDir ?? defaultPluginsDir(),
		logger: logger.child("substrate"),
	});

	const server = await startWebServer({
		host: substrate.host,
		port: options.port ?? 21315,
		hostname: options.hostname ?? "127.0.0.1",
		version,
		...(webDist ? { webDist } : {}),
		plugins: () => substrate.plugins,
		revision: () => substrate.revision,
		reload: substrate.reload,
		logger: logger.child("http"),
	});

	return {
		port: server.port,
		url: server.url,
		server,
		get host() {
			return substrate.host;
		},
		get plugins() {
			return substrate.plugins;
		},
		get revision() {
			return substrate.revision;
		},
		reload: substrate.reload,
		close: async () => {
			await server.close();
			await substrate.close();
		},
	};
}

export { createSubstrate, type Substrate, type SubstrateOptions } from "./host.js";
export { createLogger, silentLogger, type Logger } from "./logger.js";
export { resolvePluginRef, scanPluginDirectory } from "./plugins.js";
export { describe, type PluginRecord, type Principal } from "./types.js";
