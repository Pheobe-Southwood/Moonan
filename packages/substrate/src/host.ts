import { createHost, replicatedState, type Host, type ReloadReport } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { nodeLoader } from "@earendil-works/chord/node";
import { Manifest, PluginEntrySchema, type PluginEntry } from "@moonan_ai/sdk";
import { Type } from "typebox";
import { createLogger, type Logger } from "./logger.js";
import { resolvePluginRef, scanPluginDirectory } from "./plugins.js";
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
	 * chord's code version of this host (`host.codeVersion`): 1 after a healthy startup, one
	 * higher per commit — including the per-plugin reloads a failed batch leaves behind. A
	 * browser and an external tool both use it to tell whether a new code version exists.
	 */
	readonly revision: number;
	/**
	 * Re-installs plugin modules with one verb: `host.reload` installs a facet that never
	 * installed and re-runs the factory of one that did, so a loaded plugin and one that failed
	 * at startup both go through it. Without an id, every plugin.
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
			// The batch reports one failure for all of them: if it failed while activating, the
			// installs already happened and are not rolled back; if it failed to resolve a module,
			// nothing was installed. Retry one at a time only to say which plugin broke.
			logger.error("plugin batch failed to activate; isolating", error);
		}
		// `reload` is the one verb that covers both states (chord has no "is this facet
		// installed" query): it installs a facet the batch never reached and re-runs the factory
		// of one it did, so a plugin whose `setup` throws is named here instead of hiding behind
		// the batch's error. A host object that fails to *activate* does not reject a reload —
		// chord reports it through `onError` — so that shape stays unattributed to its plugin.
		for (const plugin of loadable) {
			try {
				await host.reload([plugin.server!]);
				plugin.loaded = true;
				logger.info(`loaded "${plugin.id}" from ${plugin.source}`);
			} catch (error) {
				plugin.error = errorMessage(error);
				logger.error(`plugin "${plugin.id}" failed to load`, error);
			}
		}
	};

	await loadPlugins();

	/**
	 * The one thing the substrate announces, and the only state the base carries: chord's own
	 * standalone observable value, not a hand-rolled one. `replicatedState` is the shipped
	 * primitive for exactly this — a JSON value plus ordered notifications, independent of any
	 * object — so the base owns no fan-out code of its own.
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
	const manifestChanges = replicatedState<ManifestSnapshot>({
		revision: host.codeVersion,
		plugins: plugins.map(describe),
	});

	await host.install({
		name: "moonan:manifest",
		setup(api) {
			api.serve(Manifest, (_input, _principal, self) => {
				// Seed from the snapshot, and expect the same value again when the listener
				// starts: a replicated state hydrates a new subscriber with its current value, so
				// nothing announced between this factory and that moment is lost.
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
	// with a logged error instead of in every browser. The reference is dropped at once: this
	// is a self-check, not a lifetime pin, and `host.close()` would dispose it anyway.
	try {
		const check = await host.get(Manifest, {});
		check.release();
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
		manifestChanges.replace(BACKGROUND_CONTEXT, { revision: host.codeVersion, plugins: plugins.map(describe) });
	};

	const reload = async (id?: string): Promise<{ reloaded: string[]; report?: ReloadReport }> => {
		const targets = id === undefined ? plugins : plugins.filter((plugin) => plugin.id === id);
		if (id !== undefined && targets.length === 0) throw new Error(`unknown plugin "${id}"`);

		const reloadable = targets.filter((plugin) => plugin.loaded && plugin.server).map((plugin) => plugin.server!);
		const retry = targets.filter((plugin) => !plugin.loaded && plugin.server);

		// `reload` is the one verb that covers both states — it installs a facet that is not
		// there yet and re-runs the factory of one that is — so a plugin that failed at startup
		// is recoverable whether or not the batch managed to install its facet.
		let recovered = false;
		for (const plugin of retry) {
			try {
				await host.reload([plugin.server!]);
				plugin.loaded = true;
				plugin.error = undefined;
				recovered = true;
				logger.info(`recovered "${plugin.id}"`);
			} catch (error) {
				plugin.error = errorMessage(error);
				logger.error(`plugin "${plugin.id}" still fails to load`, error);
			}
		}

		const committed = reloadable.length > 0 || recovered;
		let report: ReloadReport | undefined;
		try {
			if (reloadable.length > 0) report = await host.reload(reloadable);
		} finally {
			// In `finally`: a retry may have committed before this batch threw, and the browser
			// listens to this snapshot — the manifest must not keep a stale `error` while the
			// revision has already moved. Reading the version here, not from a cell: queued.
			if (committed || retry.length > 0) publishManifest();
		}

		const reloaded = targets.filter((plugin) => plugin.loaded).map((plugin) => plugin.id);
		return { reloaded, ...(report ? { report } : {}) };
	};

	const close = async (): Promise<void> => {
		// `host.close()` disposes everything it holds, in waves, however many references are
		// still out — there is nothing here to release first.
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
