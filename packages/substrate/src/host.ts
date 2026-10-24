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

export interface Substrate {
	host: Host<Principal>;
	/** Resolution order; entries carry `error` rather than disappearing when they fail. */
	plugins: PluginRecord[];
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

	for (const plugin of plugins) {
		if (plugin.error || !plugin.server) continue;
		try {
			await host.load([plugin.server]);
			plugin.loaded = true;
			logger.info(`loaded "${plugin.id}" from ${plugin.source}`);
		} catch (error) {
			// One broken plugin must not stop the others: keep the place, record why.
			plugin.error = errorMessage(error);
			logger.error(`plugin "${plugin.id}" failed to load`, error);
		}
	}

	// The manifest's cells are captured here so a reload that recovers a plugin can say so.
	let cells: { version: Cell<string>; plugins: Cell<PluginEntry[]> } | undefined;
	await host.install({
		name: "moonan:manifest",
		setup(api) {
			api.serve(Manifest, (_input, _principal, self) => {
				const version = self.state("version", Type.String(), options.version);
				const entries = self.state("plugins", Type.Array(PluginEntrySchema), plugins.map(describe));
				cells = { version, plugins: entries };
				return { variant: "v1" as const, version, plugins: entries };
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

	const syncManifest = async (): Promise<void> => {
		const captured = cells;
		if (!captured) return;
		const next = plugins.map(describe);
		await host.root((ctx) => {
			captured.plugins.replace(ctx, next, { diff: true });
		});
	};

	const reload = async (id?: string): Promise<{ reloaded: string[]; report?: ReloadReport }> => {
		const targets = id === undefined ? plugins : plugins.filter((plugin) => plugin.id === id);
		if (id !== undefined && targets.length === 0) throw new Error(`unknown plugin "${id}"`);

		const reloadable = targets.filter((plugin) => plugin.loaded && plugin.server).map((plugin) => plugin.server!);
		const retry = targets.filter((plugin) => !plugin.loaded && plugin.server);

		for (const plugin of retry) {
			try {
				await host.load([plugin.server!]);
				plugin.loaded = true;
				plugin.error = undefined;
				logger.info(`recovered "${plugin.id}"`);
			} catch (error) {
				plugin.error = errorMessage(error);
				logger.error(`plugin "${plugin.id}" still fails to load`, error);
			}
		}

		const report = reloadable.length > 0 ? await host.reload(reloadable) : undefined;
		if (retry.length > 0) await syncManifest();
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

	return { host, plugins, reload, close };
}
