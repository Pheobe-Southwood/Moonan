import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { BuiltinPlugin } from "@moonan_ai/core";

export const VERSION = "0.0.1-alpha5";

/**
 * The five shipped plugins. Each is a published package with a server facet (`.`),
 * a shared contract (`./contract`) and a browser facet (`./web`); they load through
 * the same `nodeLoader`/`chordHost.load` path as a disk plugin, only the URL differs.
 *
 * Order is irrelevant now that contributions go through registries, but `agents`
 * stays first so the main agent exists early.
 */
const PACKAGES = [
	{ id: "agents", name: "Agent 管理", pkg: "@moonan_ai/plugin-agents" },
	{ id: "providers", name: "提供商", pkg: "@moonan_ai/plugin-providers" },
	{ id: "chat", name: "对话", pkg: "@moonan_ai/plugin-chat" },
	{ id: "mcp", name: "MCP", pkg: "@moonan_ai/plugin-mcp" },
	{ id: "logs", name: "日志", pkg: "@moonan_ai/plugin-logs" },
] as const;

const hostRequire = createRequire(import.meta.url);

/**
 * The server facet. `import.meta.resolve` honours `--conditions=development`, but in a
 * tree where nothing has been built yet it would point at a missing `dist`; fall back to
 * the TypeScript source, which is what tsx and Vitest can load.
 */
function serverEntry(pkg: string): string {
	const resolved = import.meta.resolve(pkg);
	if (resolved.startsWith("file:") && existsSync(new URL(resolved))) return resolved;
	const source = join(dirname(hostRequire.resolve(`${pkg}/package.json`)), "src", "server.ts");
	return existsSync(source) ? pathToFileURL(source).href : resolved;
}

/** The built browser module, which is what the shell loads at runtime. */
function webEntry(pkg: string): string | undefined {
	try {
		const manifest = hostRequire.resolve(`${pkg}/package.json`);
		const file = join(dirname(manifest), "dist", "web.js");
		return existsSync(file) ? file : undefined;
	} catch {
		return undefined;
	}
}

/** Resolved fresh so `--conditions=development` can point at `src` in a dev tree. */
export function builtinPlugins(): BuiltinPlugin[] {
	return PACKAGES.map(({ id, name, pkg }) => {
		const web = webEntry(pkg);
		return {
			id,
			name,
			version: VERSION,
			server: serverEntry(pkg),
			...(web ? { web } : {}),
		};
	});
}

/**
 * Bare specifiers a disk plugin may import and still share this process's instances:
 * the plugin packages and their contract subpaths. Everything else resolves normally.
 */
export function sharedModules(): Record<string, string> {
	const shims: Record<string, string> = {};
	for (const { pkg } of PACKAGES) {
		for (const specifier of [pkg, `${pkg}/contract`]) {
			try {
				shims[specifier] = import.meta.resolve(specifier);
			} catch {
				// a plugin package that failed to install simply is not shared
			}
		}
	}
	return shims;
}
