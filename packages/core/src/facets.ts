import type { Facet, FacetApi } from "@earendil-works/chord";
import { Type } from "typebox";
import {
	AgentAdmin,
	AgentConfigSchema,
	AgentContract,
	AgentIndexContract,
	AgentStatusSchema,
	AgentSummarySchema,
	AppAdmin,
	AppContract,
	HostPaths,
	LiveMessageSchema,
	ModelAdmin,
	PluginInfoSchema,
	TranscriptAdmin,
} from "@moonan_ai/contracts";
import type { AgentConfigPatch } from "@moonan_ai/contracts";
import type { AppService } from "./app-service.js";
import type { ModelRegistry } from "./models.js";
import type { AgentRuntime } from "./runtime/agent-runtime.js";
import type { Store } from "./storage/store.js";
import type { Logger } from "./util.js";

export interface CoreFacetDeps {
	runtime: AgentRuntime;
	app: AppService;
	store: Store;
	models: ModelRegistry;
	logger: Logger;
	dataDir: string;
}

function emptyLive() {
	return { turn: 0, text: "", thinking: "", tools: [] };
}

export function coreFacets(deps: CoreFacetDeps): Facet<unknown>[] {
	return [agentFacet(deps), agentIndexFacet(deps), appFacet(deps), ...capabilityFacets(deps)];
}

function agentFacet(deps: CoreFacetDeps): Facet<unknown> {
	return {
		name: "moonan:agent",
		setup(api: FacetApi<unknown>) {
			deps.runtime.setRunner(
				async (fn) => api.root(fn),
				(fn) => {
					void api.root(fn).catch((error: unknown) => deps.logger.error("agent turn failed", error));
				},
			);
			api.serve(
				AgentContract,
				(input, _principal, self) => {
					const cells = {
						config: self.state("config", AgentConfigSchema, deps.runtime.initialConfig(input.agent)),
						phase: self.state("phase", AgentStatusSchema, "idle" as const),
						live: self.state("live", LiveMessageSchema, emptyLive()),
						inbox: self.state("inbox", Type.Array(Type.Object({ text: Type.String(), at: Type.Number() })), []),
						turnActive: self.state("turnActive", Type.Boolean(), false),
					};
					// The listeners start at commit, so binding an instance here is safe for
					// a reload that prepares and then aborts. `turnActive` also re-pumps: a
					// reload during a turn can leave messages queued behind the old instance.
					const nudge = () => {
						deps.runtime.bind(input.agent, cells).pump();
					};
					self.on("inbox", cells.inbox, nudge);
					self.on("turnActive", cells.turnActive, nudge);
					return {
						variant: "v1" as const,
						config: cells.config,
						phase: cells.phase,
						live: cells.live,
						send: (args: { text: string }, ctx) => {
							cells.inbox.change(ctx, (draft) => {
								draft.push({ text: args.text, at: Date.now() });
							});
						},
						interrupt: () => {
							deps.runtime.interrupt(input.agent);
						},
						updateConfig: async (patch: AgentConfigPatch) => {
							const next = await deps.runtime.bind(input.agent, cells).updateConfig(patch);
							deps.runtime.refresh();
							return next;
						},
					};
				},
				// A two-second chat batch may outlive a page refresh; keep the object a little longer.
				{ linger: 30_000 },
			);
		},
	};
}

function agentIndexFacet(deps: CoreFacetDeps): Facet<unknown> {
	return {
		name: "moonan:agent-index",
		setup(api: FacetApi<unknown>) {
			api.serve(AgentIndexContract, (_input, _principal, self) => {
				const agents = self.state("agents", Type.Array(AgentSummarySchema), deps.runtime.list());
				const refresh = () => {
					void api
						.root((ctx) => {
							agents.replace(ctx, deps.runtime.list(), { diff: true });
						})
						.catch(() => undefined);
				};
				const unsubscribe = deps.runtime.onChange(refresh);
				api.signal.addEventListener("abort", unsubscribe, { once: true });
				return { variant: "v1" as const, agents };
			});
		},
	};
}

function appFacet(deps: CoreFacetDeps): Facet<unknown> {
	return {
		name: "moonan:app",
		setup(api: FacetApi<unknown>) {
			api.serve(AppContract, (_input, _principal, self) => {
				const initial = deps.app.get();
				const user = self.state("user", Type.String(), initial.user);
				const locale = self.state("locale", Type.String(), initial.locale);
				const version = self.state("version", Type.String(), initial.version);
				const plugins = self.state("plugins", Type.Array(PluginInfoSchema), initial.plugins);
				const unsubscribeApp = deps.app.subscribe((state) => {
					void api
						.root((ctx) => {
							if (user.value !== state.user) user.replace(ctx, state.user);
							if (locale.value !== state.locale) locale.replace(ctx, state.locale);
							plugins.replace(ctx, state.plugins, { diff: true });
						})
						.catch(() => undefined);
				});
				api.signal.addEventListener("abort", unsubscribeApp, { once: true });
				return {
					variant: "v2" as const,
					user,
					locale,
					version,
					plugins,
					update: (patch: { user?: string; locale?: string }) => {
						deps.app.update(patch);
					},
				};
			});
		},
	};
}

/**
 * The kernel's capabilities. Each is served once, for the host's lifetime, so a plugin
 * can reach it with `self.get(...)` without the kernel knowing the plugin exists.
 */
function capabilityFacets(deps: CoreFacetDeps): Facet<unknown>[] {
	return [
		{
			name: "moonan:host-paths",
			setup(api: FacetApi<unknown>) {
				api.serve(
					HostPaths,
					(_input, _principal, self) => ({
						dataDir: self.state("dataDir", Type.String(), deps.dataDir),
					}),
					{ lifetime: "host" },
				);
			},
		},
		{
			name: "moonan:agent-admin",
			setup(api: FacetApi<unknown>) {
				api.serve(
					AgentAdmin,
					() => ({
						send: (args: { agent: string; text: string }) => {
							void deps.runtime.send(args.agent, args.text).catch((error: unknown) => {
								deps.logger.warn(`could not send to agent "${args.agent}"`, error);
							});
						},
						canSend: (args: { agent: string }) => deps.runtime.canSend(args.agent),
						interrupt: (args: { agent: string }) => deps.runtime.interrupt(args.agent),
					}),
					{ lifetime: "host" },
				);
			},
		},
		{
			name: "moonan:transcript-admin",
			setup(api: FacetApi<unknown>) {
				api.serve(
					TranscriptAdmin,
					() => ({
						page: (args: { agent: string; before?: number; limit: number }) => deps.store.pageMessages(args.agent, args),
						count: (args: { agent: string }) => deps.store.countMessages(args.agent),
					}),
					{ lifetime: "host" },
				);
			},
		},
		{
			name: "moonan:model-admin",
			setup(api: FacetApi<unknown>) {
				api.serve(
					ModelAdmin,
					() => ({
						providers: () => deps.models.listProviders(),
						models: (args: { provider: string }) => deps.models.listModels(args.provider),
						setKey: (args: { provider: string; key: string }) => deps.models.setKey(args.provider, args.key),
						clearKey: (args: { provider: string }) => deps.models.clearKey(args.provider),
						addCustom: (input: Parameters<ModelRegistry["addCustom"]>[0]) => deps.models.addCustom(input),
						removeCustom: (args: { id: string }) => deps.models.removeCustom(args.id),
						refresh: (args: { provider?: string }) => deps.models.refresh(args.provider),
					}),
					{ lifetime: "host" },
				);
			},
		},
		{
			name: "moonan:app-admin",
			setup(api: FacetApi<unknown>) {
				api.serve(
					AppAdmin,
					() => ({
						get: () => {
							const state = deps.app.get();
							return { user: state.user, locale: state.locale, version: state.version };
						},
					}),
					{ lifetime: "host" },
				);
			},
		},
	];
}
