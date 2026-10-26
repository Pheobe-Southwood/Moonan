import { createHost, type Host, type PluginRef, type ReloadReport } from "@earendil-works/chord";
import { nodeLoader } from "@earendil-works/chord/node";
import { Manifest } from "@moonan_ai/sdk";
import { createLogger, type Logger } from "./logger.js";
import { createManifestFacet, ManifestStore, type ManifestStoreRef } from "./manifest.js";
import { refreshWebHashes, resolvePluginRef, scanPluginDirectory } from "./plugins.js";
import { describe, type PluginFacets, type Principal } from "./types.js";

export interface PlatformOptions {
	/** This build's version, published in the manifest so a client knows who it talks to. */
	version: string;
	/** Plugins to resolve: package names or directories. */
	plugins?: readonly string[];
	/** A directory whose subdirectories each carry a facet entry. Read-only; the platform stores nothing. */
	pluginsDir?: string;
	logger?: Logger;
}

export interface Platform {
	host: Host<Principal>;
	/** Resolution order; entries carry `error` rather than disappearing when they fail. */
	plugins: PluginFacets[];
	/** chord's code version of this host (`host.codeVersion`). */
	readonly revision: number;
	/**
	 * Reloads every resolved server facet in one chord transaction, then waits for the new
	 * host objects. There is deliberately no per-plugin reload: the facet, not a Moonan plugin
	 * id, is chord's unit, and a breaking contract needs its consumers in the same batch.
	 */
	reload(): Promise<ReloadReport | undefined>;
	close(): Promise<void>;
}

/**
 * The platform itself: a Chord host, the facets resolved from its plugins, and the manifest.
 *
 * There is deliberately nothing else. No database, no capability contracts, no feature
 * knowledge beyond the list it was asked to resolve. Everything a plugin does — serving
 * objects, contributing routes, owning its storage — happens inside its facets, using
 * Chord directly.
 */
export async function createPlatform(options: PlatformOptions): Promise<Platform> {
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
		// A terminal failure should be loud, not a silent no-op in a background task.
		onError: (error) => logger.error("chord reported an error", error),
	});

	/**
	 * One batch, as chord intends it: every facet is installed before any host object
	 * activates, so a plugin's host object may consume a type served by a plugin loaded
	 * after it (`host.load` documents exactly this) — and so `Manifest` is available while
	 * plugin host objects activate.
	 */
	const loadFacets = async (): Promise<void> => {
		const serverPlugins = plugins.filter((plugin) => !plugin.error && plugin.server);
		const manifestFacet = createManifestFacet({
			version: options.version,
			facets: plugins.map(describe),
			revision: host.codeVersion,
		});
		const refs: PluginRef[] = [...serverPlugins.map((plugin) => plugin.server!), manifestFacet];
		await host.load(refs);
		for (const plugin of serverPlugins) {
			plugin.serverInstalled = true;
			logger.info(`loaded server facet of "${plugin.name}" from ${plugin.source}`);
		}
	};

	/** The platform's one reference to the manifest store; held for the platform lifetime. */
	let store: ManifestStoreRef | undefined;

	/**
	 * Publishes the current facet snapshot into the one store cell. `revision` is chord's
	 * code version, read after the commit; the facet list is what the resolver knows now.
	 */
	const publishManifest = async (): Promise<void> => {
		if (!store) return;
		await store.update({
			version: options.version,
			facets: plugins.map(describe),
			revision: host.codeVersion,
		});
	};

	const reload = async (): Promise<ReloadReport | undefined> => {
		const serverFacets = plugins.filter((plugin) => !plugin.error && plugin.server).map((plugin) => plugin.server!);
		if (serverFacets.length === 0) {
			// A web-only change still needs a new hash in the manifest; there is no chord
			// transaction to commit, but the browser must see the new module.
			refreshWebHashes(plugins);
			try {
				await publishManifest();
			} catch (error) {
				logger.error("manifest publish failed", error);
			}
			return undefined;
		}

		let report: ReloadReport | undefined;
		let committed = false;
		try {
			report = await host.reload(serverFacets);
			committed = true;
			for (const plugin of plugins) {
				if (plugin.server && !plugin.error) plugin.serverInstalled = true;
			}
			// `host.reload` resolves at commit; it does not wait for the new host objects. A
			// failed activation must reject here, not become a report that says "reloaded".
			await host.ready();
		} finally {
			// Only a committed reload publishes new web hashes. A refused reload keeps the old
			// server code, so it must not advertise new web code either.
			if (committed) refreshWebHashes(plugins);
			try {
				await publishManifest();
			} catch (error) {
				// Do not mask a reload failure with a manifest-publish failure. The next
				// successful reload publishes again; a terminal host failure is reported by
				// chord's onError.
				logger.error("manifest publish failed", error);
			}
		}
		return report;
	};

	const close = async (): Promise<void> => {
		store?.release();
		store = undefined;
		await host.close().catch((error: unknown) => logger.error("host close failed", error));
	};

	try {
		await loadFacets();

		// The store is host-lifetime, so `host.load` already waited for it. Keep one reference
		// for the platform lifetime to publish snapshots; it does not change the store's life.
		store = await host.get(ManifestStore, {});

		// Activate the platform's own contract once at startup, so a mistake in it fails here
		// instead of in every browser. The reference is dropped at once: this is a self-check,
		// not a lifetime pin, and `host.close()` would dispose it anyway.
		const check = await host.get(Manifest, {});
		check.release();
	} catch (error) {
		// `load` is not a rollback transaction: a setup that served a type before throwing
		// leaves that service behind. The chord guidance is to close the host when abandoning
		// startup, which is exactly what happens here.
		store?.release();
		store = undefined;
		await host.close().catch((closeError: unknown) => logger.error("host close failed", closeError));
		throw error;
	}

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
