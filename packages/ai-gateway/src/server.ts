import {
	DataCodecs,
	DataStore,
	Routes,
	dataOwner,
	defineFacet,
	invalid,
	requireUser,
	type MoonanPrincipal,
	type StoredDataset,
} from "@moonan_ai/sdk";
import {
	AI_GATEWAY_DATASET,
	GATEWAY_CONFIG_VERSION,
	emptyConfig,
	gatewayCodec,
	migrateConfig,
} from "./config.js";
import { AiGateway, GatewayAdmin } from "./contract.js";
import { GATEWAY_VERSION } from "./discovery.js";
import { gatewayRoutes } from "./http.js";
import {
	AI_GATEWAY_PROVIDER_ID,
	ModelProviders,
	createAiGatewayModelProvider,
	type AiGatewayRuntime,
	type ModelInfo,
} from "./model-provider.js";
import { SerialQueue } from "./queue.js";
import { buildGatewayModels } from "./runtime.js";
import { GatewayConfigSchema, type GatewayConfig } from "./schema.js";
import { GatewayService } from "./service.js";

/** The key-free catalog of one built runtime. */
function modelInfos(runtime: AiGatewayRuntime): ModelInfo[] {
	return runtime.models.getModels().map((model) => ({
		providerId: model.provider,
		modelId: model.id,
		name: model.name,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		input: [...model.input],
		reasoning: model.reasoning,
	}));
}

/**
 * The server facet.
 *
 * Two kinds of objects, one per-user authority:
 *  - `GatewayAdmin` is local and host-lifetime. It owns the global contributions that must
 *    exist exactly once for the host: the `DataCodecs` codec, the `Routes` and the
 *    `ModelProviders` entry. It resolves a caller's own gateway object instead of holding
 *    any configuration itself.
 *  - `AiGateway` is remote and per principal: every signed-in user (exactly: login session)
 *    gets its own object with its own config cell, serial queue and service, all scoped to
 *    `dataOwner(principal)`. The `DataStore` dataset is the authority; the `config` cell is
 *    that object's projection of its owner's dataset.
 *
 * A reload replaces code, not a user's persisted dataset: the per-object cell is
 * re-initialized from the store (or kept, when Chord keeps the object), and the queued
 * read-modify-writes stay serialized by the resource-backed {@link SerialQueue}.
 */
export default defineFacet(
	(api) => {
		/**
		 * Read one signed-in principal's gateway config from its own `DataStore` owner.
		 *
		 * The model feature is per user but the `ModelProviders` registry is global, so a
		 * consumer only hands over a principal; this helper starts a root acting as that
		 * account and reads its partition. There is no host-wide runtime cache: two users
		 * calling at the same time must never see each other's providers.
		 */
		const readConfig = (principal: MoonanPrincipal): Promise<GatewayConfig> => {
			const user = requireUser(principal);
			const owner = dataOwner(user);
			return api.root(
				async (ctx) => {
					const data = await ctx.get(DataStore, {});
					const stored = (await data.read(
						{ owner, namespace: AI_GATEWAY_DATASET },
						ctx,
					)) as StoredDataset | undefined;
					if (stored === undefined) return emptyConfig();
					if (stored.version > GATEWAY_CONFIG_VERSION) {
						throw invalid("data", `unsupported ai-gateway config version ${stored.version}`);
					}
					return migrateConfig(stored.value, stored.version);
				},
				{ principal },
			);
		};

		const buildRuntime = async (principal: MoonanPrincipal): Promise<AiGatewayRuntime> => {
			const config = await readConfig(principal);
			const built = buildGatewayModels(() => config);
			return { models: built.models, warnings: built.warnings, revision: config.updatedAt };
		};

		api.serve(
			GatewayAdmin,
			(_input, _principal, self) => {
				// Register before any user's config cell can read; the read itself does not need the codec.
				self.register(DataCodecs, { [AI_GATEWAY_DATASET]: gatewayCodec });

				self.register(ModelProviders, {
					[AI_GATEWAY_PROVIDER_ID]: createAiGatewayModelProvider({
						list: async (principal) => modelInfos(await buildRuntime(principal)),
						runtime: buildRuntime,
					}),
				});

				self.register(
					Routes,
					gatewayRoutes(async (ctx) => {
						const user = requireUser(ctx.principal);
						return ctx.get(AiGateway, {}, { principal: user });
					}),
				);

				return {};
			},
			{ lifetime: "host" },
		);

		api.serve(AiGateway, (_input, principal, self) => {
			const user = requireUser(principal);
			const owner = dataOwner(user);
			const data = self.get(DataStore, {});
			const queue = self.resource("queue", {
				version: 1,
				open: () => new SerialQueue(),
				close: async () => undefined,
			});

			const config = self.state(
				"config",
				GatewayConfigSchema,
				{
					init: async (ctx) => {
						const stored = (await data.read(
							{ owner, namespace: AI_GATEWAY_DATASET },
							ctx,
						)) as StoredDataset | undefined;
						if (stored === undefined) return emptyConfig();
						if (stored.version > GATEWAY_CONFIG_VERSION) {
							throw invalid("data", `unsupported ai-gateway config version ${stored.version}`);
						}
						return migrateConfig(stored.value, stored.version);
					},
				},
				{
					version: GATEWAY_CONFIG_VERSION,
					migrate: (old, from) => migrateConfig(old, from),
				},
			);

			let service: GatewayService | undefined;
			const getService = (): GatewayService => {
				service ??= new GatewayService({
					version: GATEWAY_VERSION,
					owner,
					data,
					namespace: AI_GATEWAY_DATASET,
					queue: queue.value,
					getConfig: (): GatewayConfig => config.value,
					commit: (next, ctx) => config.replace(ctx, next, { diff: true }),
				});
				return service;
			};

			// Import or an explicit reload changes this owner's dataset; keep the projection in
			// step. The listener's root acts as the host principal, so the owner is passed
			// explicitly instead of being derived from the context.
			self.on("data-revision", data.revision, async (_revision, ctx) => {
				const stored = (await data.read(
					{ owner, namespace: AI_GATEWAY_DATASET },
					ctx,
				)) as StoredDataset | undefined;
				if (stored === undefined || stored.version > GATEWAY_CONFIG_VERSION) return;
				const next = migrateConfig(stored.value, stored.version);
				config.replace(ctx, next, { diff: true });
			});

			// The remote state is a projection, never the raw config: keys do not cross the
			// wire and the panel cannot accidentally mutate what the server owns.
			// The snapshot carries the data database's status (`storage`), so it follows the
			// store's `storage` cell as well: a dataset written by any owner or an import
			// changes it without touching this plugin's `config` cell.
			const snapshot = self.derive([config, data.storage], (current, storage) =>
				getService().snapshot(current, storage),
			);

			return {
				variant: "v1" as const,
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
		});
	},
	{ uses: [DataStore] },
);
