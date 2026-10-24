import { createHost, type Host, type Ref, type ReloadReport } from "@earendil-works/chord";
import { nodeLoader } from "@earendil-works/chord/node";
import { Manifest, PluginEntrySchema, type PluginEntry } from "@moonan_ai/sdk";
import { Type } from "typebox";
import { createLogger, type Logger } from "./logger.js";
import { installSharedModuleHooks, resolvePluginRef, scanPluginDirectory } from "./plugins.js";
import { createSignal } from "./signal.js";
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

/** What every `Manifest` instance converges on, and what a new instance starts from. */
interface ManifestSnapshot {
	readonly revision: number;
	readonly plugins: PluginEntry[];
}

export interface Substrate {
	host: Host<Principal>;
	/** Resolution order; entries carry `error` rather than disappearing when they fail. */
	plugins: PluginRecord[];
	/**
	 * chord's code version of this host (`host.codeVersion`): 1 at startup, one higher after
	 * every reload that committed. A browser and an external tool both use it to tell whether
	 * a new code version exists.
	 */
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
				//
				// Only true for an activation failure. A facet whose `setup` throws after it
				// already served a type is not rolled back by chord either, so this retry gets
				// "`<type>` is already served" instead — a known limit of this isolation, not a
				// second plugin error.
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
	 * The one thing the substrate announces, and the only state the base carries.
	 *
	 * chord instantiates a remote type per principal, so the host has its own `Manifest`
	 * object and every browser shares another one. Fanning a new snapshot out to them is
	 * chord's job, not this file's: each instance declares `self.on("manifest", …)` in its own
	 * factory, chord runs that handler in the object's own root, and an object that is gone
	 * takes its listener with it. Nothing here iterates instances or prunes dead ones.
	 *
	 * Created per substrate, not per module: two substrates in one process (tests) must not
	 * deliver each other's reloads.
	 */
	const manifestChanges = createSignal<ManifestSnapshot>({
		revision: host.codeVersion,
		plugins: plugins.map(describe),
	});

	await host.install({
		name: "moonan:manifest",
		setup(api) {
			api.serve(Manifest, (_input, _principal, self) => {
				// Seed from the snapshot, and expect the same value again when the listener
				// starts: a signal replays its current value, so nothing announced between this
				// factory and that moment is lost.
				const initial = manifestChanges.value;
				const version = self.state("version", Type.String(), options.version);
				const entries = self.state("plugins", Type.Array(PluginEntrySchema), initial.plugins);
				const revision = self.state("revision", Type.Number(), initial.revision);
				self.on("manifest", manifestChanges, (next, ctx) => {
					entries.replace(ctx, next.plugins, { diff: true });
					if (next.revision !== revision.value) revision.replace(ctx, next.revision);
				});
				return { variant: "v1" as const, version, plugins: entries, revision };
			});
		},
	});

	// Activate the substrate's own contract once at startup, so a mistake in it fails here
	// with a logged error instead of in every browser. This is not what keeps the manifest
	// alive: the object a browser needs belongs to the browser principal and is created when
	// that browser first holds it.
	let manifest: Ref<typeof Manifest> | undefined;
	try {
		manifest = await host.get(Manifest, {});
	} catch (error) {
		logger.error("the manifest object could not be activated", error);
	}

	/**
	 * Announces the current snapshot.
	 *
	 * `revision` is chord's code version, read after the commit; the plugin list is what the
	 * loader knows now. Delivery is chord's publication queue, so this returns before the
	 * instances have written their cells — nothing may read a cell to answer a request.
	 */
	const publishManifest = (): void => {
		manifestChanges.set({ revision: host.codeVersion, plugins: plugins.map(describe) });
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
		// A commit moved `host.codeVersion`; a recovery only changed the plugin list. Either way
		// the browser listens to this snapshot, and a browser reloads its own facets from it
		// (docs/architecture). Reading the version here, not from a cell: delivery is queued.
		if (committed || retry.length > 0) publishManifest();

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
		await host.close().catch((error: unknown) => logger.error("host close failed", error));
	};

	return {
		host,
		plugins,
		get revision() {
			return host.codeVersion;
		},
		reload,
		close,
	};
}
