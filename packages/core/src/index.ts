import { basename, join } from "node:path";
import { type Host, createHost } from "@earendil-works/chord";
import { nodeLoader } from "@earendil-works/chord/node";
import {
	AgentContract,
	AgentDefinitions,
	AgentIndexContract,
	AgentToolGroups,
	AgentTools,
	AppContract,
	type PluginInfo,
} from "@moonan_ai/contracts";
import { AppService } from "./app-service.js";
import { coreFacets } from "./facets.js";
import { ModelRegistry } from "./models.js";
import { installSharedModuleHooks, scanPlugins } from "./plugins.js";
import { AgentRuntime } from "./runtime/agent-runtime.js";
import { startWebServer, type PluginWebAsset, type WebServerHandle } from "./server.js";
import { SqliteCredentialStore } from "./storage/credentials.js";
import { openDatabase } from "./storage/db.js";
import { Store } from "./storage/store.js";
import { createLogger, type Logger } from "./util.js";

export interface BuiltinPlugin {
	id: string;
	name: string;
	version: string;
	/** The server facet module. Loaded through `nodeLoader`, exactly like a disk plugin. */
	server: string | URL;
	/** Absolute path of the browser module; the shell loads it as a web facet. */
	web?: string;
}

export interface MoonanOptions {
	dataDir: string;
	version: string;
	builtinPlugins: BuiltinPlugin[];
	port?: number;
	hostname?: string;
	/** Built web app, served from the same port as the WebSocket. */
	webDist?: string;
	/** Bare specifiers a disk plugin may import and share with this process. */
	sharedModules?: Record<string, string>;
	logger?: Logger;
}

export interface Moonan {
	port: number;
	url: string;
	chordHost: Host<unknown>;
	store: Store;
	close(): Promise<void>;
}

export async function createMoonan(options: MoonanOptions): Promise<Moonan> {
	const logger = options.logger ?? createLogger();
	const hostname = options.hostname ?? "127.0.0.1";
	const port = options.port ?? 21315;

	const db = openDatabase(options.dataDir);
	const store = new Store(db);
	const credentials = new SqliteCredentialStore(store);
	const models = new ModelRegistry(store, credentials, logger.child("models"));
	const app = new AppService(store, options.version);
	const runtime = new AgentRuntime({
		store,
		models,
		logger: logger.child("agents"),
		sceneVariables: () => ({ user: app.get().user }),
	});

	installSharedModuleHooks(options.sharedModules);
	const chordHost = createHost({ name: "moonan", self: { id: "local" }, loader: nodeLoader });

	for (const facet of coreFacets({
		runtime,
		app,
		store,
		models,
		logger: logger.child("core"),
		dataDir: options.dataDir,
	})) {
		await chordHost.install({ name: facet.name, setup: facet.setup, ...(facet.uses ? { uses: facet.uses } : {}) });
	}

	// Registries are the only channel from plugins to the kernel: the host owns the
	// subscriptions, so a plugin never calls into the runtime directly.
	const held: { release(): void }[] = [];
	const heldAgents = new Set<string>();
	const pin = async (promise: Promise<{ release(): void }>): Promise<void> => {
		held.push(await promise);
	};
	const pinAgents = async (): Promise<void> => {
		for (const id of runtime.ids()) {
			if (heldAgents.has(id)) continue;
			heldAgents.add(id);
			try {
				await pin(chordHost.get(AgentContract, { agent: id }));
			} catch (error) {
				heldAgents.delete(id);
				logger.error(`agent "${id}" could not be pinned`, error);
			}
		}
	};

	chordHost.registry(AgentDefinitions).subscribe((table) => {
		runtime.setDefinitions(table);
		void pinAgents();
	});
	chordHost.registry(AgentTools).subscribe((table) => {
		runtime.setTools(table);
	});
	chordHost.registry(AgentToolGroups).subscribe((table) => {
		runtime.setToolGroups(table);
	});

	const pluginInfos: PluginInfo[] = [];
	const webAssets: PluginWebAsset[] = [];
	const modules = new Map<string, string | URL>();

	for (const plugin of options.builtinPlugins) {
		modules.set(plugin.id, plugin.server);
		const web = plugin.web ? `/plugins/${plugin.id}/${basename(plugin.web)}` : undefined;
		if (plugin.web) webAssets.push({ id: plugin.id, name: plugin.name, file: plugin.web });
		try {
			await chordHost.load([plugin.server]);
			pluginInfos.push({
				id: plugin.id,
				name: plugin.name,
				version: plugin.version,
				source: "builtin",
				hasWeb: Boolean(web),
				...(web ? { web } : {}),
			});
		} catch (error) {
			logger.error(`builtin plugin "${plugin.id}" failed to load`, error);
			pluginInfos.push({
				id: plugin.id,
				name: plugin.name,
				version: plugin.version,
				source: "builtin",
				hasWeb: Boolean(web),
				...(web ? { web } : {}),
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	for (const plugin of scanPlugins(join(options.dataDir, "plugins"), logger.child("plugins"))) {
		modules.set(plugin.id, plugin.server);
		try {
			await chordHost.load([plugin.server]);
			pluginInfos.push({
				id: plugin.id,
				name: plugin.name,
				version: plugin.version,
				source: "disk",
				hasWeb: Boolean(plugin.web),
				...(plugin.web ? { web: `/plugins/${plugin.id}/${basename(plugin.web)}` } : {}),
			});
			if (plugin.web) webAssets.push({ id: plugin.id, name: plugin.name, file: plugin.web });
			logger.info(`disk plugin "${plugin.id}" loaded`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.error(`disk plugin "${plugin.id}" failed to load`, error);
			pluginInfos.push({
				id: plugin.id,
				name: plugin.name,
				version: plugin.version,
				source: "disk",
				hasWeb: Boolean(plugin.web),
				error: message,
			});
		}
	}

	app.setPlugins(pluginInfos);

	// Hold the app, the index and every agent so a browser disconnect never tears
	// down a running turn. Agents with an input cannot be `lifetime: "host"`.
	await pin(chordHost.get(AppContract, {}));
	await pin(chordHost.get(AgentIndexContract, {}));
	await pinAgents();

	const reload = async (id?: string): Promise<Awaited<ReturnType<Host["reload"]>>> => {
		const urls: (string | URL)[] = [];
		if (id === undefined) {
			urls.push(...modules.values());
		} else {
			const url = modules.get(id);
			if (!url) throw new Error(`unknown plugin "${id}"`);
			urls.push(url);
		}
		logger.info(`reloading ${id ? `plugin "${id}"` : `${urls.length} plugin(s)`}`);
		const report = await chordHost.reload(urls);
		runtime.refresh();
		await pinAgents();
		return report;
	};

	const server: WebServerHandle = await startWebServer({
		chordHost,
		port,
		hostname,
		...(options.webDist ? { webDist: options.webDist } : {}),
		version: options.version,
		plugins: () => webAssets,
		reload,
		logger: logger.child("http"),
	});

	logger.info(`Moonan ${options.version} listening on ${server.url}`);

	return {
		port: server.port,
		url: server.url,
		chordHost,
		store,
		close: async () => {
			await server.close();
			await runtime.dispose();
			for (const ref of held) {
				try {
					ref.release();
				} catch {
					// already released
				}
			}
			await chordHost.close().catch(() => undefined);
			db.close();
		},
	};
}

export { AppService } from "./app-service.js";
export { ModelRegistry } from "./models.js";
export { AgentRuntime } from "./runtime/agent-runtime.js";
export { Store } from "./storage/store.js";
export { openDatabase } from "./storage/db.js";
export { scanPlugins, installSharedModuleHooks, type DiskPlugin } from "./plugins.js";
export { createLogger, renderTemplate, templateVariables, silentLogger, type Logger } from "./util.js";
