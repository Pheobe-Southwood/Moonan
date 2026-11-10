import {
	createHost,
	isChordError,
	type Host,
	type PluginRef,
	type Ref,
	type ReloadReport,
} from "@earendil-works/chord";
import { nodeLoader } from "@earendil-works/chord/node";
import {
	DataStore,
	WebFacetCatalog,
	type DataBundle,
	type DataImportReport,
	type DataStoreStorageInfo,
} from "@moonan_ai/sdk";
import { createDataFacet, defaultDataFile } from "./data.js";
import { createLogger, type Logger } from "./logger.js";
import { createWebFacetCatalogFacet, WebFacetCatalogStore, type WebFacetCatalogStoreRef } from "./web-facet-catalog.js";
import { normalizeRef, resolvePluginRef, resolvePlugins, scanPluginDirectory } from "./plugins.js";
import type { PluginRegistry } from "./plugin-registry.js";
import {
	adminEntry,
	describe,
	errorMessage,
	PluginOperationError,
	webSignature,
	type PluginEntry,
	type PluginFacets,
	type PluginState,
	type Principal,
	type StartupReport,
} from "./types.js";

export interface PlatformOptions {
	/** This build's version, published in the WebFacetCatalog so a client knows who it talks to. */
	version: string;
	/** Shorthand for enabled, ephemeral entries; `pluginsDir` is scanned the same way. */
	plugins?: readonly string[];
	/** A directory whose subdirectories each carry a facet entry. Read-only, resolved at startup. */
	pluginsDir?: string;
	/** The preferred form: persisted intent plus official defaults, assembled by `start`. */
	entries?: readonly PluginEntry[];
	/** Entries the degraded startup fallback left out of this process (never persisted). */
	skipped?: readonly string[];
	/** The plugin registry file, for reporting and for mutations to persist into. */
	pluginsFile?: string;
	/** When present, every enable/disable/add/remove is written back to the registry. */
	registry?: PluginRegistry;
	/** Set by `start` when the fallback booted a reduced plugin set. */
	startup?: StartupReport;
	/** Absolute path of the unified plugin data file. Defaults to `MOONAN_DATA_FILE` or `~/.moonan/data.json`. */
	dataFile?: string;
	/** Validate every cell write against its schema (chord's `dev`). Default: chord's default (off). */
	dev?: boolean;
	logger?: Logger;
}

/** One state change, as returned by the platform's plugin-management methods. */
export interface PluginMutationResult {
	/** The resolved plugin list, its enablement or its web facets changed. */
	changed: boolean;
	/** The enabled browser facet set (URL + hash) changed; the shell must reload its facets. */
	reloadBrowser: boolean;
	report?: ReloadReport;
	plugin?: PluginState;
}

export interface Platform {
	host: Host<Principal>;
	/** Resolution order; entries carry `error` rather than disappearing when they fail. */
	plugins: PluginState[];
	/** The one data file every exportable plugin dataset lives in. */
	readonly dataFile: string;
	/** The engine's plugin registry file, when this platform was started from one. */
	readonly pluginsFile?: string;
	/** Non-undefined when the degraded startup fallback skipped some entries. */
	readonly startup?: StartupReport;
	/** chord's code version of this host (`host.codeVersion`). */
	readonly revision: number;
	/**
	 * Re-resolves every entry and re-imports the server facets that are installed now, in one
	 * chord reload, then waits for the new host objects. This is the "the files on disk
	 * changed" path: because every current facet is in the batch, a breaking contract and its
	 * consumers are always reloaded together. There is deliberately no per-plugin reload: the
	 * facet, not a Moonan plugin id, is chord's unit.
	 *
	 * Enable/disable/add/remove do not go through here: they reload only the facets they add
	 * and remove (see `sync`), which chord supports because facets missing from the list keep
	 * running unchanged.
	 *
	 * The entries are re-resolved first, so a removed or renamed facet entry is passed to
	 * chord as a removed facet (`ReloadOptions.remove`) and a changed web file gets a new
	 * content hash.
	 */
	reload(): Promise<ReloadReport | undefined>;
	/** Persists the intent, then reloads. Refuses locked entries and unknown ids. */
	setPluginEnabled(ref: string, enabled: boolean): Promise<PluginMutationResult>;
	/** Resolves, records and (optionally) enables a plugin. Nothing is downloaded. */
	addPlugin(ref: string, options?: { enabled?: boolean }): Promise<PluginMutationResult>;
	/** Removes a plugin from the load list. Files and npm packages are left alone. */
	removePlugin(ref: string): Promise<PluginMutationResult>;
	/** Current `DataStore.storage` projection. */
	dataStatus(): Promise<DataStoreStorageInfo>;
	/** Export every dataset with a registered codec. Secrets are excluded unless requested. */
	exportData(options?: { includeSecrets?: boolean }): Promise<DataBundle>;
	/** Import a bundle atomically. Unknown datasets, duplicate namespaces or codec failures reject. */
	importData(bundle: unknown): Promise<DataImportReport>;
	close(): Promise<void>;
}

function isLoadable(plugin: PluginState): boolean {
	return plugin.enabled && !plugin.startupSkipped && plugin.error === undefined && plugin.server !== undefined;
}

function isActive(plugin: PluginState): boolean {
	return plugin.enabled && !plugin.startupSkipped;
}

function isSkipped(plugin: PluginState): boolean {
	return plugin.startupSkipped;
}

/** A stable description of what the resolved plugin list currently says. */
function resolutionSignature(plugins: readonly PluginState[]): string {
	return plugins
		.map((plugin) =>
			[
				plugin.ref,
				plugin.enabled ? "1" : "0",
				plugin.builtin ? "1" : "0",
				plugin.locked ? "1" : "0",
				plugin.ephemeral ? "1" : "0",
				plugin.startupSkipped ? "1" : "0",
				plugin.server ?? "",
				plugin.web?.url ?? "",
				plugin.web?.hash ?? "",
				plugin.error ?? "",
			].join("|"),
		)
		.join(";");
}

/**
 * The platform itself: a Chord host, the platform's data and web-facet-catalog facets, and
 * the facets resolved from its plugins.
 *
 * The platform knows no feature semantics. It supplies three infrastructure seams:
 * `moonan:data`, which stores namespaced JSON for plugins that register a codec,
 * `moonan:web-facets`, which tells the browser which web facets to load, and the plugin
 * registry, which records *which* plugins to resolve in the first place. Everything else —
 * objects, routes, panels, model providers — is a plugin contribution.
 */
export async function createPlatform(options: PlatformOptions): Promise<Platform> {
	const logger = options.logger ?? createLogger();
	const dataFile = options.dataFile ?? defaultDataFile();
	const baseDir = process.cwd();

	const skipped = new Set(options.skipped ?? []);

	const initialEntries: PluginEntry[] = options.entries
		? options.entries.map((entry) => ({ ...entry }))
		: (() => {
				const refs = [...(options.plugins ?? [])];
				if (options.pluginsDir) refs.push(...scanPluginDirectory(options.pluginsDir, logger.child("plugins")));
				return refs.map((ref) => ({ ref, enabled: true, ephemeral: true }));
			})();

	const initialFacets = resolvePlugins(
		initialEntries.map((entry) => entry.ref),
		baseDir,
	);

	const installed = new Set<string>();

	/**
	 * Joins the registry intent with a fresh resolution. A skipped entry keeps `enabled: true`
	 * (the intent is unchanged) but reports `startupSkipped` and is not loaded.
	 */
	const buildStates = (
		entries: readonly PluginEntry[],
		facets: readonly PluginFacets[],
	): { states: PluginState[]; servers: Set<string> } => {
		const skippedRefs = new Set([...skipped]);
		const servers = new Set<string>();
		for (let index = 0; index < entries.length; index += 1) {
			const entry = entries[index]!;
			const facet = facets[index]!;
			if (entry.enabled === false) continue;
			if (skippedRefs.has(entry.ref)) continue;
			if (facet.error !== undefined || facet.server === undefined) continue;
			servers.add(facet.server);
		}
		const states = entries.map((entry, index) => {
			const facet = facets[index]!;
			const enabled = entry.enabled !== false;
			const startupSkipped = enabled && skippedRefs.has(entry.ref);
			return {
				...facet,
				enabled,
				builtin: entry.builtin === true,
				locked: entry.locked === true,
				ephemeral: entry.ephemeral === true,
				startupSkipped,
				serverInstalled:
					enabled && !startupSkipped && facet.server !== undefined && servers.has(facet.server),
			};
		});
		return { states, servers };
	};

	const initial = buildStates(initialEntries, initialFacets).states;
	const plugins: PluginState[] = [...initial];

	/** The entries as the user currently intends them, without transient skip state. */
	const configsFrom = (states: readonly PluginState[]): PluginEntry[] =>
		states.map((plugin) => ({
			ref: plugin.ref,
			enabled: plugin.enabled,
			builtin: plugin.builtin,
			locked: plugin.locked,
			ephemeral: plugin.ephemeral,
		}));

	const applyStates = (next: readonly PluginState[]): void => {
		plugins.splice(0, plugins.length, ...next);
	};

	const activeWebSignature = (): string => webSignature(plugins.filter(isActive));

	const host = createHost<Principal>({
		name: "moonan",
		self: { id: "host" },
		loader: nodeLoader,
		...(options.dev === undefined ? {} : { dev: options.dev }),
		// A terminal failure should be loud, not a silent no-op in a background task.
		onError: (error) => logger.error("chord reported an error", error),
	});

	/**
	 * One batch, as chord intends it: every facet is installed before any host object
	 * activates, so a plugin's host object may consume a type served by a plugin loaded
	 * after it (`host.load` documents exactly this) — and so `DataStore` and
	 * `WebFacetCatalog` are available while plugin host objects activate.
	 */
	const loadFacets = async (): Promise<void> => {
		const serverPlugins = plugins.filter(isLoadable);
		const dataFacet = createDataFacet({ file: dataFile });
		const catalogFacet = createWebFacetCatalogFacet({
			version: options.version,
			facets: plugins.filter(isActive).map(describe),
			revision: host.codeVersion,
		});
		const batch: PluginRef<Principal>[] = [
			dataFacet,
			catalogFacet,
			...serverPlugins.map((plugin) => plugin.server!),
		];
		await host.load(batch);
		for (const plugin of serverPlugins) {
			plugin.serverInstalled = true;
			installed.add(plugin.server!);
			logger.info(`loaded server facet of "${plugin.name}" from ${plugin.source}`);
		}
	};

	/** The platform's references; held for the platform lifetime. */
	let dataStore: Ref<typeof DataStore> | undefined;
	let catalogStore: WebFacetCatalogStoreRef | undefined;

	/**
	 * Publishes the current facet snapshot into the one store cell. `revision` is chord's
	 * code version, read after the commit; the facet list is what the resolver knows now.
	 * Disabled and startup-skipped plugins are absent: the browser must not load them.
	 */
	const publishWebFacetCatalog = async (): Promise<void> => {
		if (!catalogStore) return;
		await catalogStore.update({
			version: options.version,
			facets: plugins.filter(isActive).map(describe),
			revision: host.codeVersion,
		});
	};

	/**
	 * Re-resolves the given entries, computes the new server facet set, and commits it in one
	 * chord reload. Only after a successful commit are the published states replaced, so a
	 * refused reload keeps the old list — and `/api/v1/plugins` tells the truth.
	 *
	 * Chord's reload takes exactly the facets to (re)load and leaves the others running, so a
	 * mutation reloads only what it changes. A manual reload is the exception: it re-imports
	 * every current facet, because the only way to notice a module edited on disk is to load
	 * it again, and a breaking contract must then arrive with its consumers in one batch.
	 */
	const sync = async (
		entries: readonly PluginEntry[],
		syncOptions: { forceServerReload?: boolean } = {},
	): Promise<PluginMutationResult> => {
		const before = resolutionSignature(plugins);
		const beforeWeb = activeWebSignature();
		const facets = resolvePlugins(entries.map((entry) => entry.ref), baseDir);
		const { states: next, servers: nextServers } = buildStates(entries, facets);

		const added = [...nextServers].filter((url) => !installed.has(url));
		const removed = [...installed].filter((url) => !nextServers.has(url));
		const force = syncOptions.forceServerReload === true;
		// Only the listed facets are (re)imported; `removed` names the ones that leave.
		const reloadList = force ? [...nextServers] : added;
		// A manual reload commits even when nothing changed: a module edited on disk has the
		// same URL, so the commit is the only observable "reload ran" signal (`revision`).
		const commit = force || added.length > 0 || removed.length > 0;

		let report: ReloadReport | undefined;
		let committed = false;
		try {
			if (commit) {
				report = await host.reload(reloadList, removed.length > 0 ? { remove: removed } : undefined);
				committed = true;
			}
			applyStates(next);
			if (committed) {
				installed.clear();
				for (const url of nextServers) installed.add(url);
			}
			if (commit) {
				// `host.reload` resolves at commit; it does not wait for the new host objects. A
				// failed activation must reject here, not become a report that says "reloaded".
				await host.ready();
			}
		} catch (error) {
			if (committed) {
				// The commit is final even when a host object failed to activate: publish what is
				// committed, then surface the activation failure to the caller.
				try {
					await publishWebFacetCatalog();
				} catch (publishError) {
					logger.error("web facet catalog publish failed", publishError);
				}
				throw new PluginOperationError("reload_failed", errorMessage(error), 400, {
					...(isChordError(error)
						? { chordCode: error.code, ...(error.reason ? { reason: error.reason } : {}) }
						: {}),
					committed: true,
				});
			}
			throw error;
		}

		try {
			await publishWebFacetCatalog();
		} catch (error) {
			// Do not mask a successful reload with a catalog-publish failure. The next
			// successful reload publishes again; a terminal host failure is reported by
			// chord's onError.
			logger.error("web facet catalog publish failed", error);
		}

		return {
			changed: before !== resolutionSignature(plugins),
			reloadBrowser: beforeWeb !== activeWebSignature(),
			...(report ? { report } : {}),
		};
	};

	/** One mutation at a time: chord itself rejects a second concurrent reload. */
	let queue: Promise<unknown> = Promise.resolve();
	const serialized = <T>(task: () => Promise<T>): Promise<T> => {
		const run = queue.then(task, task);
		queue = run.catch(() => undefined);
		return run;
	};

	/** Writes the current intent to the registry, if this platform was started with one. */
	const persist = async (): Promise<void> => {
		if (!options.registry) return;
		const entries = plugins
			.filter((plugin) => !plugin.ephemeral)
			.map((plugin) => ({ ref: plugin.ref, enabled: plugin.enabled }));
		try {
			await options.registry.replace(entries);
		} catch (error) {
			throw new PluginOperationError(
				"persist_failed",
				`plugin registry could not be saved: ${errorMessage(error)}. The change is active until the process restarts.`,
				500,
			);
		}
	};

	const find = (ref: string): PluginState | undefined => plugins.find((plugin) => plugin.ref === ref);

	/**
	 * `sync` + persistence rule for a mutation. When the chord commit already landed and only
	 * activation failed, the new intent is the truth from now on: persist it, then report the
	 * activation failure (the HTTP layer marks it `committed: true`).
	 */
	const syncAndPersist = async (
		entries: readonly PluginEntry[],
		syncOptions: { forceServerReload?: boolean } = {},
	): Promise<PluginMutationResult> => {
		try {
			const result = await sync(entries, syncOptions);
			await persist();
			return result;
		} catch (error) {
			if (error instanceof PluginOperationError && error.details.committed) {
				try {
					await persist();
				} catch (persistError) {
					logger.error("plugin registry could not be saved after a committed reload", persistError);
				}
			}
			throw error;
		}
	};

	const setEnabledUnlocked = async (ref: string, enabled: boolean): Promise<PluginMutationResult> => {
		const current = find(ref);
		if (!current) throw new PluginOperationError("unknown_plugin", `unknown plugin: ${ref}`, 404);
		if (current.locked) throw new PluginOperationError("locked", `plugin "${ref}" is locked`, 403);
		// A management action adopts an ephemeral entry (`--plugin`/scan) into the registry:
		// otherwise the toggle would vanish on the next restart. Enabling an entry that is
		// already enabled is still a real change in that case — it persists the adoption.
		const adopts = enabled && current.ephemeral;
		if (current.enabled === enabled && !(enabled && current.startupSkipped) && !adopts) {
			return { changed: false, reloadBrowser: false, plugin: current };
		}

		const wasSkipped = skipped.has(ref);
		if (enabled) skipped.delete(ref);
		// Writing `ephemeral: false` is what turns the entry into a managed registry entry.
		const entries = configsFrom(plugins).map((entry) =>
			entry.ref === ref ? { ...entry, enabled, ephemeral: false } : entry,
		);
		let result: PluginMutationResult;
		try {
			result = await syncAndPersist(entries);
		} catch (error) {
			const committed = error instanceof PluginOperationError && error.details.committed === true;
			// The entry is still excluded from this process; a later attempt can retry.
			if (enabled && wasSkipped && !committed) skipped.add(ref);
			throw error;
		}
		const plugin = find(ref);
		return { ...result, ...(plugin ? { plugin } : {}) };
	};

	const addUnlocked = async (ref: string, addOptions: { enabled?: boolean } = {}): Promise<PluginMutationResult> => {
		const trimmed = ref.trim();
		if (trimmed.length === 0) throw new PluginOperationError("invalid_ref", "a plugin ref must not be empty", 400);
		if (trimmed.length > 512) throw new PluginOperationError("invalid_ref", "a plugin ref is too long", 400);
		const normalized = normalizeRef(trimmed, baseDir);
		const enable = addOptions.enabled ?? true;

		const existing = find(normalized) ?? find(trimmed);
		if (existing) {
			if (!existing.ephemeral) {
				throw new PluginOperationError("duplicate", `plugin "${existing.ref}" is already registered`, 409);
			}
			// A plugin that came from --plugin or the startup scan can be adopted: it becomes a
			// managed registry entry, disabled first, then enabled through the normal path.
			const adopted = await syncAndPersist(
				configsFrom(plugins).map((entry) =>
					entry.ref === existing.ref ? { ...entry, ephemeral: false, enabled: false } : entry,
				),
			);
			if (!enable) return { ...adopted, plugin: find(existing.ref) };
			try {
				return await setEnabledUnlocked(existing.ref, true);
			} catch (error) {
				throw withPlugin(error, existing.ref);
			}
		}

		const resolved = resolvePluginRef(normalized, baseDir);
		if (resolved.error !== undefined) {
			throw new PluginOperationError(
				"resolve_failed",
				`cannot load "${normalized}": ${resolved.error}`,
				400,
			);
		}
		if (resolved.server !== undefined) {
			const holder = plugins.find((plugin) => plugin.server === resolved.server);
			if (holder) {
				throw new PluginOperationError(
					"duplicate",
					`"${normalized}" provides the same facet as "${holder.ref}"`,
					409,
				);
			}
		}

		const added = await syncAndPersist([
			...configsFrom(plugins),
			{ ref: normalized, enabled: false, builtin: false, locked: false, ephemeral: false },
		]);
		// Record the entry before trying to enable it: a broken plugin must stay visible
		// (disabled) instead of silently disappearing again.
		if (!enable) return { ...added, plugin: find(normalized) };
		try {
			return await setEnabledUnlocked(normalized, true);
		} catch (error) {
			throw withPlugin(error, normalized);
		}
	};

	const removeUnlocked = async (ref: string): Promise<PluginMutationResult> => {
		const current = find(ref);
		if (!current) throw new PluginOperationError("unknown_plugin", `unknown plugin: ${ref}`, 404);
		if (current.builtin) throw new PluginOperationError("builtin", `plugin "${ref}" is built in and cannot be removed`, 403);
		const entries = configsFrom(plugins).filter((entry) => entry.ref !== ref);
		skipped.delete(ref);
		const result = await syncAndPersist(entries);
		return result;
	};

	/** Attaches the current plugin snapshot to an error, so the HTTP layer can render the row. */
	const withPlugin = (error: unknown, ref: string): unknown => {
		if (!(error instanceof PluginOperationError)) return error;
		if (error.details.plugin !== undefined) return error;
		const plugin = find(ref);
		return new PluginOperationError(error.code, error.message, error.status, {
			...error.details,
			...(plugin ? { plugin: adminEntry(plugin) } : {}),
		});
	};

	const reload = (): Promise<ReloadReport | undefined> =>
		serialized(async () => {
			const result = await sync(configsFrom(plugins), { forceServerReload: true });
			return result.report;
		});

	const setPluginEnabled = (ref: string, enabled: boolean): Promise<PluginMutationResult> =>
		serialized(() => setEnabledUnlocked(ref, enabled));

	const addPlugin = (ref: string, addOptions: { enabled?: boolean } = {}): Promise<PluginMutationResult> =>
		serialized(() => addUnlocked(ref, addOptions));

	const removePlugin = (ref: string): Promise<PluginMutationResult> => serialized(() => removeUnlocked(ref));

	const close = async (): Promise<void> => {
		dataStore?.release();
		dataStore = undefined;
		catalogStore?.release();
		catalogStore = undefined;
		await host.close().catch((error: unknown) => logger.error("host close failed", error));
	};

	const dataStatus = async (): Promise<DataStoreStorageInfo> => {
		if (!dataStore) throw new Error("the data store is not ready");
		return dataStore.storage.value;
	};

	const exportData = async (exportOptions: { includeSecrets?: boolean } = {}): Promise<DataBundle> => {
		if (!dataStore) throw new Error("the data store is not ready");
		// The store validates every exported value as strict JSON (`checkJson`) before it
		// returns, but the contract types values `unknown`, so the platform re-asserts the
		// portable envelope it hands to its own HTTP surface.
		const bundle = await host.root((ctx) =>
			dataStore!.exportAll({ includeSecrets: exportOptions.includeSecrets ?? false }, ctx),
		);
		return bundle as DataBundle;
	};

	const importData = async (bundle: unknown): Promise<DataImportReport> => {
		if (!dataStore) throw new Error("the data store is not ready");
		return host.root((ctx) => dataStore!.importAll({ bundle: bundle as DataBundle }, ctx));
	};

	try {
		await loadFacets();

		// The platform's infrastructure objects are host-lifetime, so `host.load` already
		// waited for them. Keep references for publishing and for the HTTP data surface.
		dataStore = await host.get(DataStore, {});
		catalogStore = await host.get(WebFacetCatalogStore, {});

		// Activate the platform's own contract once at startup, so a mistake in it fails here
		// instead of in every browser. The reference is dropped at once: this is a self-check,
		// not a lifetime pin, and `host.close()` would dispose it anyway.
		const check = await host.get(WebFacetCatalog, {});
		check.release();
	} catch (error) {
		// `load` is not a rollback transaction: a setup that served a type before throwing
		// leaves that service behind. The chord guidance is to close the host when abandoning
		// startup, which is exactly what happens here.
		dataStore?.release();
		dataStore = undefined;
		catalogStore?.release();
		catalogStore = undefined;
		await host.close().catch((closeError: unknown) => logger.error("host close failed", closeError));
		throw error;
	}

	// A skipped entry is never loaded, so it cannot have an installed server facet.
	for (const plugin of plugins) if (isSkipped(plugin)) plugin.serverInstalled = false;

	return {
		host,
		plugins,
		dataFile,
		...(options.pluginsFile === undefined ? {} : { pluginsFile: options.pluginsFile }),
		...(options.startup === undefined ? {} : { startup: options.startup }),
		get revision() {
			return host.codeVersion;
		},
		reload,
		setPluginEnabled,
		addPlugin,
		removePlugin,
		dataStatus,
		exportData,
		importData,
		close,
	};
}
