import { createHost, type Cell, type Host, type Ref, type ReloadReport } from "@earendil-works/chord";
import { nodeLoader } from "@earendil-works/chord/node";
import { Manifest, PluginEntrySchema, type PluginEntry } from "@moonan_ai/sdk";
import { Type } from "typebox";
import { createLogger, type Logger } from "./logger.js";
import { installSharedModuleHooks, resolvePluginRef, scanPluginDirectory } from "./plugins.js";
import { describe, errorMessage, type PluginRecord, type Principal } from "./types.js";

export interface SubstrateOptions {
	/** This build's version, published in the manifest so a client knows who it talks to. */
	version: string;
	/** Plugins to load: package names or directories. */
	plugins?: readonly string[];
	/** A directory whose subdirectories each carry a `plugin.json`. Read-only; the base stores nothing. */
	pluginsDir?: string;
	logger?: Logger;
}

/** One live `Manifest` object's cells: a remote type has one object per principal. */
interface ManifestCells {
	plugins: Cell<PluginEntry[]>;
	revision: Cell<number>;
}

export interface Substrate {
	host: Host<Principal>;
	/** Resolution order; entries carry `error` rather than disappearing when they fail. */
	plugins: PluginRecord[];
	/** Committed manifest revision. Bumped once per reload that committed a code version. */
	readonly revision: number;
	/**
	 * Re-installs plugin modules: a Chord reload for the ones already loaded, a plain load
	 * for the ones that failed at startup. Without an id, every plugin.
	 */
	reload(id?: string): Promise<{ reloaded: string[]; report?: ReloadReport }>;
	close(): Promise<void>;
}

/**
 * The base itself: a Chord host, and the plugins loaded into it.
 *
 * There is deliberately nothing else. No database, no capability contracts, no plugin
 * knowledge beyond the list it was asked to load. Everything a plugin does — serving
 * objects, contributing routes, owning its storage — happens inside the plugin, using
 * Chord directly.
 */
export async function createSubstrate(options: SubstrateOptions): Promise<Substrate> {
	const logger = options.logger ?? createLogger();
	installSharedModuleHooks();

	const refs = [...(options.plugins ?? [])];
	if (options.pluginsDir) refs.push(...scanPluginDirectory(options.pluginsDir, logger.child("plugins")));
	// Explicit refs resolve against the working directory, like any other CLI path argument.
	// Only the scanned directories come from `pluginsDir`; mixing the two silently pointed
	// `--plugin ./foo` at `~/.moonan/plugins/./foo`.
	const plugins = refs.map((ref) => resolvePluginRef(ref, process.cwd()));

	const host = createHost<Principal>({
		name: "moonan",
		self: { id: "host" },
		loader: nodeLoader,
		// A-terminal failure should be loud, not a silent no-op in a background task.
		onError: (error) => logger.error("chord reported an error", error),
	});

	/**
	 * One batch, as chord intends it: every facet is installed before any host object
	 * activates, so a plugin's host object may consume a type served by a plugin loaded
	 * after it (`host.load` documents exactly this). One URL at a time makes startup
	 * order-dependent: the consumer fails with `unavailable/unknown_type` when its provider
	 * sits later in the list.
	 */
	const loadPlugins = async (): Promise<void> => {
		const loadable = plugins.filter((plugin) => !plugin.error && plugin.server);
		if (loadable.length === 0) return;
		try {
			await host.load(loadable.map((plugin) => plugin.server!));
			for (const plugin of loadable) {
				plugin.loaded = true;
				logger.info(`loaded "${plugin.id}" from ${plugin.source}`);
			}
			return;
		} catch (error) {
			// The batch reports one failure for all of them, but its installs already happened
			// and are not rolled back. Retry one at a time only to say which plugin broke.
			logger.error("plugin batch failed to activate; isolating", error);
		}
		for (const plugin of loadable) {
			try {
				await host.load([plugin.server!]);
				plugin.loaded = true;
				logger.info(`loaded "${plugin.id}" from ${plugin.source}`);
			} catch (error) {
				const message = errorMessage(error);
				if (!message.includes("is already installed")) {
					plugin.error = message;
					logger.error(`plugin "${plugin.id}" failed to load`, error);
					continue;
				}
				// The batch installed this facet; its host object is what failed. A reload
				// re-runs the factory and reports this plugin's own error instead of the batch's.
				// It costs one code version per healthy plugin, which is acceptable on an error
				// path and buys an honest per-plugin message.
				plugin.loaded = true;
				try {
					await host.reload([plugin.server!]);
					logger.info(`activated "${plugin.id}" after the batch failure`);
				} catch (reloadError) {
					plugin.error = errorMessage(reloadError);
					logger.error(`plugin "${plugin.id}" failed to activate`, reloadError);
				}
			}
		}
	};

	await loadPlugins();

	/**
	 * Every live `Manifest` instance, by principal.
	 *
	 * A remote type is instantiated per principal (chord keys objects by principal), so the
	 * browser's object is not the host's. A reload has to bump the revision on all of them,
	 * or an open page would never learn that the code changed.
	 */
	const activations = new Map<string, ManifestCells>();
	let revision = 0;

	await host.install({
		name: "moonan:manifest",
		setup(api) {
			api.serve(Manifest, (_input, principal, self) => {
				const version = self.state("version", Type.String(), options.version);
				const entries = self.state("plugins", Type.Array(PluginEntrySchema), plugins.map(describe));
				const revisionCell = self.state("revision", Type.Number(), revision);
				activations.set(JSON.stringify(principal), { plugins: entries, revision: revisionCell });
				return { variant: "v1" as const, version, plugins: entries, revision: revisionCell };
			});
		},
	});

	// Hold the manifest for the life of the process: a browser disconnect must not dispose
	// the one object every reconnect needs.
	let manifest: Ref<typeof Manifest> | undefined;
	try {
		manifest = await host.get(Manifest, {});
	} catch (error) {
		logger.error("the manifest object could not be activated", error);
	}

	/**
	 * Publishes the plugin list, and — when a code version committed — a new revision.
	 *
	 * `replace` rather than `change` on the revision: every instance converges on the same
	 * absolute value, so one created after a reload starts with the current one instead of
	 * dropping a live page back to zero.
	 */
	const syncManifest = async (bumpRevision: boolean): Promise<void> => {
		if (bumpRevision) revision += 1;
		const next = plugins.map(describe);
		for (const [key, cells] of [...activations]) {
			try {
				await host.root((ctx) => {
					cells.plugins.replace(ctx, next, { diff: true });
					if (bumpRevision) cells.revision.replace(ctx, revision);
				});
			} catch (error) {
				// The object this instance belonged to is gone: its browser disconnected. Anything
				// else means the write path itself is broken and should not pass silently.
				if ((error as { code?: string }).code === "gone") activations.delete(key);
				else logger.error("manifest sync failed", error);
			}
		}
	};

	const reload = async (id?: string): Promise<{ reloaded: string[]; report?: ReloadReport }> => {
		const targets = id === undefined ? plugins : plugins.filter((plugin) => plugin.id === id);
		if (id !== undefined && targets.length === 0) throw new Error(`unknown plugin "${id}"`);

		const reloadable = targets.filter((plugin) => plugin.loaded && plugin.server).map((plugin) => plugin.server!);
		const retry = targets.filter((plugin) => !plugin.loaded && plugin.server);

		let recovered = false;
		for (const plugin of retry) {
			try {
				await host.load([plugin.server!]);
				plugin.loaded = true;
				plugin.error = undefined;
				recovered = true;
				logger.info(`recovered "${plugin.id}"`);
			} catch (error) {
				plugin.error = errorMessage(error);
				logger.error(`plugin "${plugin.id}" still fails to load`, error);
			}
		}

		const report = reloadable.length > 0 ? await host.reload(reloadable) : undefined;
		const committed = reloadable.length > 0 || recovered;
		// The revision is what a browser reload follows: it is not a commit participant, so a
		// committed code version is only visible to it as a state change (docs/architecture).
		if (committed || retry.length > 0) await syncManifest(committed);

		const reloaded = targets.filter((plugin) => plugin.loaded).map((plugin) => plugin.id);
		return { reloaded, ...(report ? { report } : {}) };
	};

	const close = async (): Promise<void> => {
		try {
			manifest?.release();
		} catch {
			// already released
		}
		manifest = undefined;
		activations.clear();
		await host.close().catch((error: unknown) => logger.error("host close failed", error));
	};

	return {
		host,
		plugins,
		get revision() {
			return revision;
		},
		reload,
		close,
	};
}
