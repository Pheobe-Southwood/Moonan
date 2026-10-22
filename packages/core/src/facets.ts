import type { Facet, FacetApi } from "@earendil-works/chord";
import { Type } from "typebox";
import { AgentConfigSchema, AgentContract, AgentIndexContract, AgentStatusSchema, AgentSummarySchema, AppContract, LiveMessageSchema, PluginInfoSchema } from "@moonan_ai/contracts";
import type { AppService } from "./app-service.js";
import type { AgentRuntime } from "./runtime/agent-runtime.js";

export interface CoreFacetDeps {
	runtime: AgentRuntime;
	app: AppService;
}

function emptyLive() {
	return { turn: 0, text: "", thinking: "", tools: [] };
}

export function coreFacets(deps: CoreFacetDeps): Facet<unknown>[] {
	return [agentFacet(deps), agentIndexFacet(deps), appFacet(deps)];
}

function agentFacet(deps: CoreFacetDeps): Facet<unknown> {
	return {
		name: "moonan:agent",
		setup(api: FacetApi<unknown>) {
			deps.runtime.setRunner(async (fn) => api.root(fn));
			api.serve(AgentContract, (input, _principal, self) => {
				const initialConfig = deps.runtime.initialConfig(input.agent);
				const cells = {
					config: self.state("config", AgentConfigSchema, initialConfig),
					phase: self.state("phase", AgentStatusSchema, "idle" as const),
					live: self.state("live", LiveMessageSchema, emptyLive()),
				};
				const instance = deps.runtime.ensureInstance(input.agent, cells);
				return {
					variant: "v1" as const,
					config: cells.config,
					phase: cells.phase,
					live: cells.live,
					send: async (args: { text: string; mode?: "steer" | "followUp" }) => {
						await instance.send(args.text, args.mode ?? "steer");
					},
					interrupt: () => {
						instance.interrupt();
					},
					updateConfig: (patch: Record<string, unknown>) => {
						const next = instance.updateConfig(patch);
						deps.runtime.refresh();
						return next;
					},
				};
			});
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
				const unsubscribe = deps.app.subscribe((state) => {
					void api
						.root((ctx) => {
							if (user.value !== state.user) user.replace(ctx, state.user);
							if (locale.value !== state.locale) locale.replace(ctx, state.locale);
							plugins.replace(ctx, state.plugins, { diff: true });
						})
						.catch(() => undefined);
				});
				api.signal.addEventListener("abort", unsubscribe, { once: true });
				return {
					variant: "v1" as const,
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
