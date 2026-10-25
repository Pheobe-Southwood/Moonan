import { createHost, replicatedState, type Host, type ReloadReport } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { nodeLoader } from "@earendil-works/chord/node";
import { FacetSetSchema, Manifest, type FacetSetEntry } from "@moonan_ai/sdk";
import { Type } from "typebox";
import { createLogger, type Logger } from "./logger.js";
import { resolvePluginRef, scanPluginDirectory } from "./plugins.js";
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

/** What every `Manifest` instance converges on, and what a new instance starts from. */
interface ManifestSnapshot {
	readonly revision: number;
	readonly facets: FacetSetEntry[];
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
	 * after it (`host.load` documents exactly this). One URL at a time makes startup
	 * order-dependent: the consumer fails with `unavailable/unknown_type` when its provider
	 * sits later in the list.
	 */
	const loadFacets = async (): Promise<void> => {
		const loadable = plugins.filter((plugin) => !plugin.error && plugin.server);
		if (loadable.length === 0) return;
		await host.load(loadable.map((plugin) => plugin.server!));
		for (const plugin of loadable) {
			plugin.serverInstalled = true;
			logger.info(`loaded server facet of "${plugin.name}" from ${plugin.source}`);
		}
	};

	/**
	 * The one thing the platform announces, and the only state it carries: chord's own
	 * standalone observable value, not a hand-rolled one. `replicatedState` is the shipped
	 * primitive for exactly this — a JSON value plus ordered notifications, independent of any
	 * object — so the platform owns no fan-out code of its own.
	 *
	 * chord instantiates a remote type per principal, so the host has its own `Manifest`
	 * object and every browser shares another one. Fanning a new snapshot out to them is
	 * chord's job, not this file's: each instance declares `self.on("manifest", …)` in its own
	 * factory, chord runs that handler in the object's own root, and an object that is gone
	 * takes its listener with it. Nothing here iterates instances or prunes dead ones.
	 *
	 * Created per platform, not per module: two platforms in one process (tests) must not
	 * deliver each other's reloads.
	 */
	const manifestChanges = replicatedState<ManifestSnapshot>({
		revision: host.codeVersion,
		facets: plugins.map(describe),
	});

	/**
	 * Announces the current snapshot.
	 *
	 * `revision` is chord's code version, read after the commit; the facet list is what the
	 * resolver knows now. Delivery is chord's publication queue, so this returns before the
	 * instances have written their cells — nothing may read a cell to answer a request.
	 */
	const publishManifest = (): void => {
		manifestChanges.replace(BACKGROUND_CONTEXT, { revision: host.codeVersion, facets: plugins.map(describe) });
	};

	const reload = async (): Promise<ReloadReport | undefined> => {
		const serverFacets = plugins.filter((plugin) => !plugin.error && plugin.server).map((plugin) => plugin.server!);
		if (serverFacets.length === 0) {
			publishManifest();
			return undefined;
		}

		let report: ReloadReport | undefined;
		try {
			report = await host.reload(serverFacets);
			for (const plugin of plugins) {
				if (plugin.server && !plugin.error) plugin.serverInstalled = true;
			}
			// `host.reload` resolves at commit; it does not wait for the new host objects. A
			// failed activation must reject here, not become a report that says "reloaded".
			await host.ready();
		} finally {
			// In `finally`: the manifest must converge even when the reload was refused or a
			// host object failed after the commit. Reading the version here, not from a cell:
			// chord's publication queue is asynchronous.
			publishManifest();
		}
		return report;
	};

	const close = async (): Promise<void> => {
		// `host.close()` disposes everything it holds, in waves, however many references are
		// still out — there is nothing here to release first.
		await host.close().catch((error: unknown) => logger.error("host close failed", error));
	};

	try {
		await loadFacets();

		await host.install({
			name: "moonan:manifest",
			setup(api) {
				api.serve(Manifest, (_input, _principal, self) => {
					// Seed from the snapshot, and expect the same value again when the listener
					// starts: a replicated state hydrates a new subscriber with its current value, so
					// nothing announced between this factory and that moment is lost.
					const initial = manifestChanges.value;
					const version = self.state("version", Type.String(), options.version);
					const facets = self.state("facets", Type.Array(FacetSetSchema), initial.facets);
					const revision = self.state("revision", Type.Number(), initial.revision);
					self.on("manifest", manifestChanges, (next, ctx) => {
						facets.replace(ctx, next.facets, { diff: true });
						if (next.revision !== revision.value) revision.replace(ctx, next.revision);
					});
					return { variant: "v1" as const, version, facets, revision };
				});
			},
		});

		// Activate the platform's own contract once at startup, so a mistake in it fails here
		// instead of in every browser. The reference is dropped at once: this is a self-check,
		// not a lifetime pin, and `host.close()` would dispose it anyway.
		const check = await host.get(Manifest, {});
		check.release();
	} catch (error) {
		// `install` (and therefore `load`) is not a rollback transaction: a setup that served a
		// type before throwing leaves that service behind. The chord guidance is to close the
		// host when abandoning startup, which is exactly what happens here.
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
