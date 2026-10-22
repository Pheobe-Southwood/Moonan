import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMoonan, type Moonan } from "@moonan_ai/core";
import { builtinPlugins, VERSION } from "./plugins/index.js";

export interface StartOptions {
	dataDir?: string;
	port?: number;
	hostname?: string;
}

export function defaultDataDir(): string {
	return join(homedir(), ".moonan");
}

/** `dist/web` ships inside the package; in dev the app is served by Vite instead. */
function resolveWebDist(): string | undefined {
	const candidate = fileURLToPath(new URL("./web/", import.meta.url));
	return existsSync(join(candidate, "index.html")) ? candidate : undefined;
}

export async function start(options: StartOptions = {}): Promise<Moonan> {
	const webDist = resolveWebDist();
	return createMoonan({
		dataDir: options.dataDir ?? defaultDataDir(),
		port: options.port ?? 21315,
		hostname: options.hostname ?? "127.0.0.1",
		version: VERSION,
		builtinPlugins,
		...(webDist ? { webDist } : {}),
	});
}

export { builtinPlugins, VERSION };
export type { Moonan };
