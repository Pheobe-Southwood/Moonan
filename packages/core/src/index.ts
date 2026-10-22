import { join } from "node:path";
import { type FacetDefinition, type Host, createHost } from "@earendil-works/chord";
import { nodeLoader } from "@earendil-works/chord/node";
import {
	AgentContract,
	AgentIndexContract,
	AppContract,
	type PluginInfo,
} from "@moonan_ai/contracts";
import { setServerHostFactory } from "@moonan_ai/plugin-sdk";
import { AppService } from "./app-service.js";
import { coreFacets } from "./facets.js";
import { McpService } from "./mcp-service.js";
import { ModelRegistry } from "./models.js";
import { makeServerHostFactory } from "./plugin-host.js";
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
	facet: FacetDefinition<unknown>;
	/** True when the web app already bundles this plugin's UI. */
	hasWeb: boolean;
}

export interface MoonanOptions {
	dataDir: string;
	version: string;
	builtinPlugins: BuiltinPlugin[];
	port?: number;
	hostname?: string;
	/** Built web app. Omit in dev, where Vite serves the app on the same port. */
	webDist?: string;
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
	const runtime = new AgentRuntime({ store, models, logger: logger.child("agents"), sceneVariables: () => ({ user: app.get().user }) });
	const mcp = new McpService(store, runtime, logger.child("mcp"));

	setServerHostFactory(makeServerHostFactory({ runtime, store, models, mcp, app, logger }));

	installSharedModuleHooks();
	const chordHost = createHost({ name: "moonan", self: { id: "local" }, loader: nodeLoader });

	for (const facet of coreFacets({ runtime, app })) {
		await chordHost.install({ name: facet.name, setup: facet.setup, ...(facet.uses ? { uses: facet.uses } : {}) });
	}

	const pluginInfos: PluginInfo[] = [];
	const webAssets: PluginWebAsset[] = [];

	for (const plugin of options.builtinPlugins) {
		try {
			await chordHost.install({
				name: `builtin:${plugin.id}`,
				setup: plugin.facet.setup,
				...(plugin.facet.uses ? { uses: plugin.facet.uses } : {}),
			});
			pluginInfos.push({
				id: plugin.id,
				name: plugin.name,
				version: plugin.version,
				source: "builtin",
				hasWeb: plugin.hasWeb,
			});
		} catch (error) {
			logger.error(`builtin plugin "${plugin.id}" failed to load`, error);
			pluginInfos.push({
				id: plugin.id,
				name: plugin.name,
				version: plugin.version,
				source: "builtin",
				hasWeb: plugin.hasWeb,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	for (const plugin of scanPlugins(join(options.dataDir, "plugins"), logger.child("plugins"))) {
		try {
			await chordHost.load([plugin.server]);
			pluginInfos.push({
				id: plugin.id,
				name: plugin.name,
				version: plugin.version,
				source: "disk",
				hasWeb: Boolean(plugin.web),
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

	// Pin every agent object so a browser disconnect never tears down a running turn.
	const pinned: { release(): void }[] = [];
	const pin = async <T extends { release(): void }>(promise: Promise<T>): Promise<void> => {
		pinned.push(await promise);
	};
	await pin(chordHost.get(AppContract, {}));
	await pin(chordHost.get(AgentIndexContract, {}));
	for (const id of runtime.ids()) {
		await pin(chordHost.get(AgentContract, { agent: id }));
	}

	void mcp.restore().catch((error: unknown) => logger.error("MCP restore failed", error));

	const server: WebServerHandle = await startWebServer({
		chordHost,
		port,
		hostname,
		...(options.webDist ? { webDist: options.webDist } : {}),
		version: options.version,
		plugins: () => webAssets,
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
			runtime.dispose();
			await mcp.dispose().catch(() => undefined);
			await chordHost.close().catch(() => undefined);
			db.close();
		},
	};
}

export { AppService } from "./app-service.js";
export { McpService } from "./mcp-service.js";
export { ModelRegistry } from "./models.js";
export { AgentRuntime } from "./runtime/agent-runtime.js";
export { Store } from "./storage/store.js";
export { openDatabase } from "./storage/db.js";
export { scanPlugins, installSharedModuleHooks, type DiskPlugin } from "./plugins.js";
export { createLogger, renderTemplate, templateVariables, silentLogger, type Logger } from "./util.js";
