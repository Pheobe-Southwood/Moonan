import type { FacetSetEntry } from "@moonan_ai/sdk";

/** Who is calling. The platform makes no distinction beyond the host's own code. */
export interface Principal {
	id: string;
}

/** Where a plugin's facets came from. */
export type PluginSource = FacetSetEntry["source"];

/**
 * One plugin the platform resolved to concrete facet URLs.
 *
 * A plugin is a distribution/display grouping, not a runtime identity: the facets are
 * what chord loads, names by module URL and reloads. `name` is only a label.
 */
export interface PluginFacets {
	/** A display label derived from the directory or package name. */
	name: string;
	version: string;
	source: PluginSource;
	/** What the user asked for: a package name or a directory. */
	ref: string;
	/** The server facet module, importable by `nodeLoader`. */
	server?: string;
	/** The browser facet: the file on disk and the path it is served from. */
	web?: { file: string; url: string; base: string };
	/** Set when resolution failed; the plugin keeps its place in the list. */
	error?: string;
	/** True once the server facet is installed and activated. */
	serverInstalled?: boolean;
}

export function describe(plugin: PluginFacets): FacetSetEntry {
	return {
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
