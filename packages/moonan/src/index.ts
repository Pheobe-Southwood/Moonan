import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMoonan, type Moonan } from "@moonan_ai/core";
import { builtinPlugins, sharedModules, VERSION } from "./plugins/index.js";

export interface StartOptions {
	dataDir?: string;
	port?: number;
	hostname?: string;
	/** Built web app. Defaults to `MOONAN_WEB_DIST`, then the copy shipped in `dist/web`. */
	webDist?: string;
}

export function defaultDataDir(): string {
	return join(homedir(), ".moonan");
}

/** `dist/web` ships inside the package; in a dev tree `--web-dist` points at `packages/web/dist`. */
function resolveWebDist(explicit: string | undefined): string | undefined {
	const fromEnv = explicit ?? process.env.MOONAN_WEB_DIST;
	if (fromEnv) return existsSync(join(fromEnv, "index.html")) ? fromEnv : undefined;
	const candidate = fileURLToPath(new URL("./web/", import.meta.url));
	return existsSync(join(candidate, "index.html")) ? candidate : undefined;
}

export async function start(options: StartOptions = {}): Promise<Moonan> {
	const webDist = resolveWebDist(options.webDist);
	return createMoonan({
		dataDir: options.dataDir ?? defaultDataDir(),
		port: options.port ?? 21315,
		hostname: options.hostname ?? "0.0.0.0",
		version: VERSION,
		builtinPlugins: builtinPlugins(),
		sharedModules: sharedModules(),
		...(webDist ? { webDist } : {}),
	});
}

export { builtinPlugins, sharedModules, VERSION };
export type { Moonan };
