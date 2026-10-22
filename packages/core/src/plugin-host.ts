import type { FacetApi } from "@earendil-works/chord";
import type { ServerHost } from "@moonan_ai/plugin-sdk";
import type { AppService } from "./app-service.js";
import type { McpService } from "./mcp-service.js";
import type { ModelRegistry } from "./models.js";
import type { AgentRuntime } from "./runtime/agent-runtime.js";
import type { Store } from "./storage/store.js";
import type { Logger } from "./util.js";

export interface PluginHostDeps {
	runtime: AgentRuntime;
	store: Store;
	models: ModelRegistry;
	mcp: McpService;
	app: AppService;
	logger: Logger;
}

/** Builds the in-process capability object handed to every server-side plugin. */
export function makeServerHostFactory(deps: PluginHostDeps) {
	return (api: FacetApi<unknown>, pluginId: string): ServerHost => {
		const logger = deps.logger.child(pluginId);
		return {
			chord: api,
			pluginId,
			agents: {
				register: (definition) => deps.runtime.register(definition, pluginId),
				registerTool: (agentId, tool) => deps.runtime.registerTool(agentId, tool),
				removeTool: (agentId, name) => deps.runtime.removeTool(agentId, name),
				send: (agentId, text, mode) => {
					void deps.runtime.send(agentId, text, mode).catch((error: unknown) => {
						logger.error(`failed to send to agent "${agentId}"`, error);
					});
				},
				canSend: (agentId) => deps.runtime.canSend(agentId),
				interrupt: (agentId) => deps.runtime.interrupt(agentId),
				toolsOf: (agentId) => deps.runtime.toolNames(agentId),
			},
			chat: {
				append: (agentId, direction, text) => deps.store.appendChat(agentId, direction, text),
				page: (agentId, options) => deps.store.pageChat(agentId, options),
			},
			logs: {
				page: (agentId, options) => deps.store.pageMessages(agentId, options),
			},
			models: {
				providers: () => deps.models.listProviders(),
				models: (providerId) => deps.models.listModels(providerId),
				setKey: (providerId, key) => deps.models.setKey(providerId, key),
				clearKey: (providerId) => deps.models.clearKey(providerId),
				addCustom: (input) => deps.models.addCustom(input),
				removeCustom: (id) => deps.models.removeCustom(id),
				refresh: (providerId) => deps.models.refresh(providerId),
				beginOauth: async (providerId) => {
					throw new Error(`OAuth login for "${providerId}" is not implemented yet`);
				},
				get oauthNotice() {
					return deps.models.oauthNotice;
				},
			},
			mcp: {
				list: () => deps.mcp.list(),
				add: (input) => deps.mcp.add(input),
				remove: (id) => deps.mcp.remove(id),
				reconnect: (id) => deps.mcp.reconnect(id),
				setToolEnabled: (serverId, toolName, enabled) => deps.mcp.setToolEnabled(serverId, toolName, enabled),
				subscribe: (listener) => deps.mcp.subscribe(listener),
			},
			app: {
				get: () => {
					const state = deps.app.get();
					return { user: state.user, locale: state.locale, version: state.version };
				},
				update: (patch) => {
					deps.app.update(patch);
				},
			},
			storage: {
				get: async <T>(key: string) => deps.store.getPluginState<T>(pluginId, key),
				set: async (key, value) => {
					deps.store.setPluginState(pluginId, key, value);
				},
			},
			log: {
				info: (message, ...args) => logger.info(message, ...args),
				warn: (message, ...args) => logger.warn(message, ...args),
				error: (message, ...args) => logger.error(message, ...args),
			},
		};
	};
}
