import type { PluginEntry } from "@moonan_ai/sdk";

/** Who is calling. The substrate makes no distinction beyond the host's own code. */
export interface Principal {
	id: string;
}

/** Where a plugin module came from. */
export type PluginSource = PluginEntry["source"];

/** One plugin the substrate knows about, resolved to concrete module URLs. */
export interface PluginRecord {
	id: string;
	name: string;
	version: string;
	source: PluginSource;
	/** What the user asked for: a package name or a directory. */
	ref: string;
	/** The server facet module, importable by `nodeLoader`. */
	server?: string | URL;
	/** The browser facet: the file on disk and the path it is served from. */
	web?: { file: string; url: string };
	/** Set when resolution or loading failed; the plugin keeps its place in the list. */
	error?: string;
	/** True once the server facet is installed in the host (and so can be reloaded). */
	loaded?: boolean;
}

export function describe(plugin: PluginRecord): PluginEntry {
	return {
		id: plugin.id,
		name: plugin.name,
		version: plugin.version,
		source: plugin.source,
		...(plugin.web ? { web: plugin.web.url } : {}),
		...(plugin.error ? { error: plugin.error } : {}),
	};
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
