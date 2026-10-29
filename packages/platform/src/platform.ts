import {
	createHost,
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
import {
	createWebFacetCatalogFacet,
	WebFacetCatalogStore,
	type WebFacetCatalogStoreRef,
} from "./web-facet-catalog.js";
import { resolvePlugins, scanPluginDirectory } from "./plugins.js";
import { describe, type PluginFacets, type Principal } from "./types.js";

export interface PlatformOptions {
	/** This build's version, published in the WebFacetCatalog so a client knows who it talks to. */
	version: string;
	/** Plugins to resolve: package names or directories. */
	plugins?: readonly string[];
	/** A directory whose subdirectories each carry a facet entry. Read-only. */
	pluginsDir?: string;
	/** Absolute path of the unified plugin data file. Defaults to `MOONAN_DATA_FILE` or `~/.moonan/data.json`. */
	dataFile?: string;
	/** Validate every cell write against its schema (chord's `dev`). Default: chord's default (off). */
	dev?: boolean;
	logger?: Logger;
}

export interface Platform {
	host: Host<Principal>;
	/** Resolution order; entries carry `error` rather than disappearing when they fail. */
	plugins: PluginFacets[];
	/** The one data file every exportable plugin dataset lives in. */
	readonly dataFile: string;
	/** chord's code version of this host (`host.codeVersion`). */
	readonly revision: number;
	/**
	 * When a chord commit is needed, reloads every resolved server facet in one transaction and
	 * then waits for the new host objects. There is deliberately no per-plugin reload: the
	 * facet, not a Moonan plugin id, is chord's unit, and a breaking contract needs its
	 * consumers in the same batch.
	 *
	 * The refs are re-resolved first, so a removed or renamed entry file is passed to chord as
	 * a removed facet (`ReloadOptions.remove`) and a changed web file gets a new content hash.
	 */
	reload(): Promise<ReloadReport | undefined>;
	/** Current `DataStore.storage` projection. */
	dataStatus(): Promise<DataStoreStorageInfo>;
	/** Export every dataset with a registered codec. Secrets are excluded unless requested. */
	exportData(options?: { includeSecrets?: boolean }): Promise<DataBundle>;
	/** Import a bundle atomically. Unknown datasets, duplicate namespaces or codec failures reject. */
	importData(bundle: unknown): Promise<DataImportReport>;
	close(): Promise<void>;
}

/**
 * The platform itself: a Chord host, the platform's data and web-facet-catalog facets, and
 * the facets resolved from its plugins.
 *
 * The platform knows no feature semantics. It supplies two infrastructure seams:
 * `moonan:data`, which stores namespaced JSON for plugins that register a codec, and
 * `moonan:web-facets`, which tells the browser which web facets to load. Everything else —
 * objects, routes, panels, model providers — is a plugin contribution.
 */
export async function createPlatform(options: PlatformOptions): Promise<Platform> {
	const logger = options.logger ?? createLogger();
	const dataFile = options.dataFile ?? defaultDataFile();

	const refs = [...(options.plugins ?? [])];
	if (options.pluginsDir) refs.push(...scanPluginDirectory(options.pluginsDir, logger.child("plugins")));
	// Explicit refs resolve against the working directory, like any other CLI path argument.
	// Only the scanned directories come from `pluginsDir`; mixing the two silently pointed
	// `--plugin ./foo` at `~/.moonan/plugins/./foo`.
	const baseDir = process.cwd();
	const plugins = resolvePlugins(refs, baseDir);

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
		const serverPlugins = plugins.filter((plugin) => !plugin.error && plugin.server);
		const dataFacet = createDataFacet({ file: dataFile });
		const catalogFacet = createWebFacetCatalogFacet({
			version: options.version,
			facets: plugins.map(describe),
			revision: host.codeVersion,
		});
		const batch: PluginRef[] = [
			dataFacet,
			catalogFacet,
			...serverPlugins.map((plugin) => plugin.server!),
		];
		await host.load(batch);
		for (const plugin of serverPlugins) {
			plugin.serverInstalled = true;
			logger.info(`loaded server facet of "${plugin.name}" from ${plugin.source}`);
		}
	};

	/** The platform's references; held for the platform lifetime. */
	let dataStore: Ref<typeof DataStore> | undefined;
	let catalogStore: WebFacetCatalogStoreRef | undefined;

	/**
	 * Publishes the current facet snapshot into the one store cell. `revision` is chord's
	 * code version, read after the commit; the facet list is what the resolver knows now.
	 */
	const publishWebFacetCatalog = async (): Promise<void> => {
		if (!catalogStore) return;
		await catalogStore.update({
			version: options.version,
			facets: plugins.map(describe),
			revision: host.codeVersion,
		});
	};

	/**
	 * Copies a fresh resolution onto the published entries in place, keeping the array and
	 * each entry's `ref` (the user's input) stable for every holder of `platform.plugins`.
	 */
	const applyCandidates = (candidates: readonly PluginFacets[]): void => {
		if (candidates.length !== plugins.length) throw new Error("plugin resolution changed the number of plugins");
		for (let index = 0; index < plugins.length; index += 1) {
			const plugin = plugins[index]!;
			const candidate = candidates[index]!;
			plugin.name = candidate.name;
			plugin.version = candidate.version;
			plugin.source = candidate.source;
			plugin.server = candidate.server;
			plugin.web = candidate.web;
			plugin.error = candidate.error;
			plugin.serverInstalled = candidate.server !== undefined && candidate.error === undefined;
		}
	};

	const reload = async (): Promise<ReloadReport | undefined> => {
		// Re-resolve before touching chord: a removed/renamed entry must become a removed facet,
		// and a changed web file must get a new content hash. Candidates are applied only after
		// a commit, so a refused reload leaves the published list (and `/api/plugins`) as it was.
		const candidates = resolvePlugins(refs, baseDir);
		const nextServers = new Set(
			candidates.map((candidate) => candidate.server).filter((url): url is string => url !== undefined),
		);
		const removed = [
			...new Set(
				plugins
					.map((plugin) => plugin.server)
					.filter((url): url is string => url !== undefined && !nextServers.has(url)),
			),
		];
		const serverFacets = [
			...new Set(
				candidates
					.filter((candidate) => candidate.error === undefined && candidate.server !== undefined)
					.map((candidate) => candidate.server!),
			),
		];
		// Only a web-only change may skip chord entirely. A removal is a chord commit too:
		// `host.reload([], { remove })` is the official way to stop serving those facets.
		const webOnly = serverFacets.length === 0 && removed.length === 0;

		let report: ReloadReport | undefined;
		let committed = false;
		try {
			if (webOnly) {
				applyCandidates(candidates);
			} else {
				report = await host.reload(serverFacets, removed.length > 0 ? { remove: removed } : undefined);
				committed = true;
				applyCandidates(candidates);
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
		return report;
	};

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
		return host.root((ctx) =>
			dataStore!.exportAll({ includeSecrets: exportOptions.includeSecrets ?? false }, ctx),
		);
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

	return {
		host,
		plugins,
		dataFile,
		get revision() {
			return host.codeVersion;
		},
		reload,
		dataStatus,
		exportData,
		importData,
		close,
	};
}
