import type { FacetSetEntry, PluginAdminEntry } from "@moonan_ai/sdk";

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
	web?: { file: string; url: string; base: string; hash: string };
	/** Set when resolution failed; the plugin keeps its place in the list. */
	error?: string;
	/** True once the server facet is installed and activated. */
	serverInstalled?: boolean;
}

/** A plugin resolved and joined with its registry intent. */
export interface PluginState extends PluginFacets {
	/** The persisted intent (`plugins.json`). */
	enabled: boolean;
	/** Shipped through the platform's optional dependencies. */
	builtin: boolean;
	/** The plugin manager itself: no UI action may disable it. */
	locked: boolean;
	/** Added by `--plugin` or a startup directory scan; not written to the registry. */
	ephemeral: boolean;
	/** Left out of this process by the degraded startup fallback; not persisted. */
	startupSkipped: boolean;
}

/**
 * One entry of the plugin registry before resolution.
 *
 * The platform refuses to import a plugin package: it only ever holds a string `ref` and
 * resolves it to facet module URLs. `builtin`/`locked` come from the official manifest in
 * this package's `package.json`, never from the registry file.
 */
export interface PluginEntry {
	ref: string;
	enabled?: boolean;
	builtin?: boolean;
	locked?: boolean;
	ephemeral?: boolean;
}

/** What the degraded startup fallback reports, and what the management API publishes. */
export interface StartupReport {
	degraded: boolean;
	message?: string;
	/** Enabled entries the fallback left out; the registry was not changed. */
	skipped: string[];
}

/** Extra context a failed plugin operation carries to the HTTP layer. */
export interface PluginOperationDetails {
	/** Chord's error code, when a facet reload failed. */
	chordCode?: string;
	/** Chord's error reason. */
	reason?: string;
	/** A commit already happened even though activation failed. */
	committed?: boolean;
	plugin?: PluginAdminEntry;
}

/**
 * A refused plugin operation. The HTTP layer maps `code`/`status` and keeps chord's own
 * `code`/`reason` when the failure came from `host.reload`.
 */
export class PluginOperationError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status = 400,
		readonly details: PluginOperationDetails = {},
	) {
		super(message);
		this.name = "PluginOperationError";
	}
}

export function describe(plugin: PluginFacets): FacetSetEntry {
	return {
		name: plugin.name,
		version: plugin.version,
		source: plugin.source,
		...(plugin.web ? { web: { url: plugin.web.url, hash: plugin.web.hash } } : {}),
		...(plugin.error ? { error: plugin.error } : {}),
	};
}

/**
 * What the plugin-management page sees for one plugin.
 *
 * `loaded` means everything this plugin provides is in service in this process: a server
 * facet is installed here; a web-only plugin has no server work left and is published for
 * browsers. `server` says whether the plugin has a server facet at all.
 */
export function adminEntry(plugin: PluginState): PluginAdminEntry {
	const loaded =
		plugin.enabled &&
		!plugin.startupSkipped &&
		plugin.error === undefined &&
		(plugin.server !== undefined ? plugin.serverInstalled === true : plugin.web !== undefined);
	return {
		id: plugin.ref,
		ref: plugin.ref,
		name: plugin.name,
		version: plugin.version,
		source: plugin.source,
		builtin: plugin.builtin,
		locked: plugin.locked,
		ephemeral: plugin.ephemeral,
		enabled: plugin.enabled,
		loaded,
		server: plugin.server !== undefined,
		startupSkipped: plugin.startupSkipped,
		web: plugin.web ? { url: plugin.web.url, hash: plugin.web.hash } : null,
		...(plugin.error ? { error: plugin.error } : {}),
	};
}

/**
 * The exact browser facet set: URL + content hash. A server-only reload does not change it;
 * a web facet edit does. This is what `reloadBrowser` and the shell compare.
 */
export function webSignature(plugins: readonly PluginFacets[]): string {
	return plugins
		.filter((plugin) => plugin.web)
		.map((plugin) => `${plugin.web!.url}#${plugin.web!.hash}`)
		.sort()
		.join("|");
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
