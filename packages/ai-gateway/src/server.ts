import { Routes, defineFacet } from "@moonan_ai/sdk";
import { ConfigStore } from "./store.js";
import { GatewayState, AiGateway } from "./contract.js";
import { gatewayRoutes } from "./http.js";
import { GatewayService } from "./service.js";
import { GatewayConfigSchema, type GatewayConfig } from "./schema.js";
import { GATEWAY_VERSION } from "./discovery.js";

/**
 * The server facet.
 *
 * Two objects, one authority:
 *  - `GatewayState` is local and host-lifetime. It owns the raw config cell (API keys
 *    included), the on-disk store resource, the service and the HTTP routes.
 *  - `AiGateway` is the remote view. It exposes the derived, key-free snapshot and
 *    forwards every write to the local object.
 *
 * The store is a chord resource, so a server-facet reload keeps the instance (and its
 * write queue). The config cell survives a reload too; `GatewayService` is rebuilt with
 * the new code on first use, so new options/validation apply without touching the file.
 */
export default defineFacet((api) => {
	api.serve(
		GatewayState,
		(_input, _principal, self) => {
			const store = self.resource("store", {
				version: 1,
				open: () => new ConfigStore(),
				close: async () => undefined,
			});

			const config = self.state("config", GatewayConfigSchema, {
				init: async () => (await store.value.load()).config,
			});

			let service: GatewayService | undefined;
			const getService = (): GatewayService => {
				service ??= new GatewayService({
					version: GATEWAY_VERSION,
					store: store.value,
					getConfig: (): GatewayConfig => config.value,
					commit: (next, ctx) => config.replace(ctx, next, { diff: true }),
				});
				return service;
			};

			self.register(Routes, gatewayRoutes(getService));

			// The remote state is a projection, never the raw config: keys do not cross the
			// wire and the panel cannot accidentally mutate what the server owns.
			const snapshot = self.derive([config], (current) => getService().snapshot(current));

			return {
				snapshot,
				health: () => getService().health(),
				addBuiltinProvider: (args, ctx) => getService().addBuiltinProvider(args.presetId, ctx),
				addProvider: (args, ctx) => getService().addProvider(args, ctx),
				saveProvider: (args, ctx) => getService().saveProvider(args.id, args.patch, ctx),
				deleteProvider: (args, ctx) => getService().deleteProvider(args.id, ctx),
				setProviderEnabled: (args, ctx) => getService().setProviderEnabled(args.id, args.enabled, ctx),
				saveModel: (args, ctx) => getService().saveModel(args.providerId, args.model, args.previousId, ctx),
				deleteModel: (args, ctx) => getService().deleteModel(args.providerId, args.modelId, ctx),
				importModels: (args, ctx) => getService().importModels(args.providerId, args.models, args.mode, ctx),
				discoverModels: (args, ctx) => getService().discover(args.id, ctx),
				saveSettings: (args, ctx) => getService().setSettings(args.settings, ctx),
				reloadFromDisk: (ctx) => getService().reloadFromDisk(ctx),
			};
		},
		{ lifetime: "host" },
	);

	api.serve(AiGateway, (_input, _principal, self) => {
		const state = self.get(GatewayState, {});
		return {
			variant: "v1" as const,
			snapshot: state.snapshot,
			addBuiltinProvider: (args: { presetId: string }, ctx) => state.addBuiltinProvider(args, ctx),
			addProvider: (args, ctx) => state.addProvider(args, ctx),
			saveProvider: (args, ctx) => state.saveProvider(args, ctx),
			deleteProvider: (args, ctx) => state.deleteProvider(args, ctx),
			setProviderEnabled: (args, ctx) => state.setProviderEnabled(args, ctx),
			saveModel: (args, ctx) => state.saveModel(args, ctx),
			deleteModel: (args, ctx) => state.deleteModel(args, ctx),
			importModels: (args, ctx) => state.importModels(args, ctx),
			discoverModels: (args, ctx) => state.discoverModels(args, ctx),
			saveSettings: (args, ctx) => state.saveSettings(args, ctx),
			reloadFromDisk: (ctx) => state.reloadFromDisk(ctx),
		};
	});
});
