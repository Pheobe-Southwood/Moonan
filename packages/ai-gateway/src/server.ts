import {
	DataCodecs,
	DataStore,
	Routes,
	defineFacet,
	invalid,
} from "@moonan_ai/sdk";
import { Value } from "typebox/value";
import {
	AI_GATEWAY_DATASET,
	GATEWAY_CONFIG_VERSION,
	emptyConfig,
	gatewayCodec,
	migrateConfig,
} from "./config.js";
import { GatewayState, AiGateway } from "./contract.js";
import { GATEWAY_VERSION } from "./discovery.js";
import { gatewayRoutes } from "./http.js";
import {
	AI_GATEWAY_PROVIDER_ID,
	ModelProviders,
	createAiGatewayModelProvider,
} from "./model-provider.js";
import { SerialQueue } from "./queue.js";
import { GatewayConfigSchema, type GatewayConfig } from "./schema.js";
import { GatewayService } from "./service.js";

/**
 * The server facet.
 *
 * Two objects, one authority:
 *  - `GatewayState` is local and host-lifetime. It owns the config projection cell (API
 *    keys included), the DataStore reference, the service, the model-provider contribution
 *    and the HTTP routes.
 *  - `AiGateway` is the remote view. It exposes the derived, key-free snapshot and forwards
 *    every write to the local object.
 *
 * The `DataStore` dataset is the authority; the `config` cell is a projection. `queue` is
 * a resource so the read-modify-write order survives a reload, and `DataStore.update`
 * serializes it against imports and other code versions.
 */
export default defineFacet(
	(api) => {
		api.serve(
			GatewayState,
			(_input, _principal, self) => {
				const data = self.get(DataStore, {});
				const queue = self.resource("queue", {
					version: 1,
					open: () => new SerialQueue(),
					close: async () => undefined,
				});

				// Register before the config init reads; the read itself does not need the codec.
				self.register(DataCodecs, { [AI_GATEWAY_DATASET]: gatewayCodec });

				const config = self.state("config", GatewayConfigSchema, {
					init: async (ctx) => {
						const stored = await data.read({ namespace: AI_GATEWAY_DATASET }, ctx);
						if (stored === undefined) return emptyConfig();
						if (stored.version > GATEWAY_CONFIG_VERSION) {
							throw invalid("data", `unsupported ai-gateway config version ${stored.version}`);
						}
						return migrateConfig(stored.value, stored.version);
					},
				});

				let service: GatewayService | undefined;
				const getService = (): GatewayService => {
					service ??= new GatewayService({
						version: GATEWAY_VERSION,
						data,
						namespace: AI_GATEWAY_DATASET,
						queue: queue.value,
						getConfig: (): GatewayConfig => config.value,
						commit: (next, ctx) => config.replace(ctx, next, { diff: true }),
					});
					return service;
				};

				// Import or an explicit reload changes the dataset; keep the projection in step.
				self.on("data-revision", data.revision, async (_revision, ctx) => {
					const stored = await data.read({ namespace: AI_GATEWAY_DATASET }, ctx);
					if (stored === undefined || stored.version > GATEWAY_CONFIG_VERSION) return;
					const next = migrateConfig(stored.value, stored.version);
					if (!Value.Equal(next, config.value)) config.replace(ctx, next, { diff: true });
				});

				self.register(ModelProviders, {
					[AI_GATEWAY_PROVIDER_ID]: createAiGatewayModelProvider({
						list: () => getService().modelInfos(),
						runtime: () => getService().modelRuntime(),
					}),
				});

				self.register(Routes, gatewayRoutes(getService));

				// The remote state is a projection, never the raw config: keys do not cross the
				// wire and the panel cannot accidentally mutate what the server owns.
				// The snapshot carries the data file's status (`storage`), so it follows the
				// store's `storage` cell as well: a dataset written by another plugin or an
				// import changes it without touching this plugin's `config` cell.
				const snapshot = self.derive([config, data.storage], (current, storage) =>
					getService().snapshot(current, storage),
				);

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
	},
	{ uses: [DataStore] },
);
