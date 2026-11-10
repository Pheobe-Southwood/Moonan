/**
 * The platform's plugin-management HTTP surface (`/api/v1/plugins`).
 *
 * This is deliberately **not** a Chord contract: changing which plugins exist must run
 * outside a Chord root (a reload waits for roots to finish, so calling it from inside a
 * root risks a deadlock). The platform owns the endpoints; the browser panel and the CLI
 * are clients of the same JSON shape.
 *
 * `ref` is the address of a plugin (a package name or an absolute directory), not a
 * runtime id: facets are still identified by module URL. It is only the stable key of the
 * plugin registry.
 */
export const PLUGIN_ADMIN_API = 1 as const;

export interface PluginAdminWebFacet {
	/** HTTP path under `/facets/...`, served by the platform. */
	url: string;
	/** Content hash; a browser reloads the facet when it changes. */
	hash: string;
}

/** One plugin, as the plugin-management page sees it. */
export interface PluginAdminEntry {
	/** Stable key: the normalized `ref`. */
	id: string;
	ref: string;
	name: string;
	version: string;
	source: "package" | "directory";
	/** Shipped as an official plugin through the platform's optional dependencies. */
	builtin: boolean;
	/** Cannot be disabled or removed from the UI (the plugin manager itself). */
	locked: boolean;
	/** Added by `--plugin` or the startup directory scan: not managed by the registry. */
	ephemeral: boolean;
	/** The persisted intent. */
	enabled: boolean;
	/**
	 * Everything this plugin provides is in service in this process: a server facet is
	 * installed here; a web-only plugin has no server work left and is published for browsers.
	 */
	loaded: boolean;
	/** The plugin has a server facet (so `loaded` has server work to wait for). */
	server: boolean;
	/** Temporarily left out by the degraded startup fallback; the registry was not changed. */
	startupSkipped: boolean;
	web: PluginAdminWebFacet | null;
	/** Resolution or load failure. The entry keeps its place in the list. */
	error?: string;
}

export interface PluginAdminStartup {
	degraded: boolean;
	message?: string;
	/** Enabled entries the fallback left out; none were written to the registry. */
	skipped: string[];
}

export interface PluginAdminPaths {
	/** Directory that relative plugin refs resolve against. */
	cwd: string;
	/** The plugin registry file (`~/.moonan/plugins.json` by default). */
	pluginsFile: string;
	/** The unified plugin data file. */
	dataFile: string;
	/** The read-only startup scan directory. */
	pluginsDir: string;
}

export interface PluginAdminSnapshot {
	api: typeof PLUGIN_ADMIN_API;
	version: string;
	/** Chord's code version (`host.codeVersion`). */
	revision: number;
	/** False when the management endpoints are disabled (non-loopback bind without opt-in). */
	management: boolean;
	/** A recovery notice from the plugin registry (for example, restored from `.bak`). */
	warning?: string;
	startup?: PluginAdminStartup;
	paths: PluginAdminPaths;
	plugins: PluginAdminEntry[];
}

/** A successful state change. */
export interface PluginAdminMutation {
	ok: true;
	changed: boolean;
	/** The enabled browser facet set (URL + hash) changed; the shell reloads its facets. */
	reloadBrowser: boolean;
	revision: number;
	plugin?: PluginAdminEntry;
}

/** A refused or failed state change. */
export interface PluginAdminError {
	error: string;
	code?: string;
	/** Chord's error reason, when the failure came from a facet reload. */
	reason?: string;
	/** Chord's error code, when it differs from the operation code. */
	chordCode?: string;
	/** True when a chord commit already happened even though activation failed. */
	committed?: boolean;
	plugin?: PluginAdminEntry;
}

export const PLUGIN_ADMIN_PATHS = [
	"/api/v1/plugins",
	"/api/v1/plugins/enable",
	"/api/v1/plugins/disable",
	"/api/v1/plugins/install",
	"/api/v1/plugins/remove",
	"/api/v1/plugins/reload",
] as const;
