import { DataStore, Routes, dataOwner, defineFacet, local, obj, requireUser } from "@moonan_ai/sdk";
import {
	AI_GATEWAY_PROVIDER_ID,
	ModelProviders,
	isAiGatewayModelProvider,
} from "@moonan_ai/ai-gateway/model-provider";

/**
 * A real cross-plugin consumer used by the gateway integration test.
 *
 * It resolves ai-gateway through the platform registry (not by importing its facet) and
 * proves that another server plugin can reach the configured pi-ai models for the
 * signed-in user. The second route writes an unrelated dataset through the platform's
 * `DataStore` in that same user's partition, which changes the store's `storage` cell
 * without changing ai-gateway's config: the gateway snapshot must follow it.
 */
const Root = local("test.ai-gateway-consumer", {
	version: 1,
	input: obj({}, { open: true }),
	members: {},
});

export default defineFacet(
	(api) => {
		const providers = api.registry(ModelProviders);

		api.serve(
			Root,
			(_input, _principal, self) => {
				const data = self.get(DataStore, {});
				self.register(Routes, {
					"GET /api/model-provider": async (_request, response, ctx) => {
						// The registry view pins the table to this root's code version. The model
						// catalog is per user, so the caller's principal is required: the route root
						// was started by the platform with the authenticated account stamped on it.
						const provider = providers.get(AI_GATEWAY_PROVIDER_ID, ctx);
						const runtime = isAiGatewayModelProvider(provider)
							? await provider.runtime(ctx.principal)
							: undefined;
						const model = runtime?.models.getModel("atlas", "hand-written");
						const payload = {
							models: ((await provider?.list(ctx.principal)) ?? []).map((entry) => entry.modelId),
							model: model?.id ?? null,
							warnings: runtime?.warnings ?? [],
						};
						response.writeHead(200, {
							"content-type": "application/json; charset=utf-8",
							"cache-control": "no-store",
						});
						response.end(JSON.stringify(payload));
					},
					"GET /api/data-touch": async (_request, response, ctx) => {
						// Every DataStore call names its owner; the platform root carries the user.
						const owner = dataOwner(requireUser(ctx.principal));
						await data.write(
							{
								owner,
								namespace: "test/touch",
								version: 1,
								value: { touchedAt: new Date().toISOString() },
							},
							ctx,
						);
						response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
						response.end(JSON.stringify({ ok: true }));
					},
				});
				return {};
			},
			{ lifetime: "host" },
		);
	},
	{ uses: [DataStore] },
);
