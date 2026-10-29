import { DataStore, Routes, Type, defineFacet, local } from "@moonan_ai/sdk";
import {
	AI_GATEWAY_PROVIDER_ID,
	ModelProviders,
	isAiGatewayModelProvider,
} from "@moonan_ai/ai-gateway/model-provider";

/**
 * A real cross-plugin consumer used by the gateway integration test.
 *
 * It resolves ai-gateway through the platform registry (not by importing its facet) and
 * proves that another server plugin can reach the configured pi-ai models. The second
 * route writes an unrelated dataset through the platform's `DataStore`, which changes the
 * store's `storage` cell without changing ai-gateway's config: the gateway snapshot must
 * follow it.
 */
const Root = local("test.ai-gateway-consumer", {
	version: 1,
	input: Type.Object({}),
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
					"GET /api/model-provider": (_request, response, ctx) => {
						// The registry view pins the table to this root's code version.
						const provider = providers.get(AI_GATEWAY_PROVIDER_ID, ctx);
						const runtime = isAiGatewayModelProvider(provider) ? provider.runtime() : undefined;
						const model = runtime?.models.getModel("atlas", "hand-written");
						const payload = {
							models: (provider?.list() ?? []).map((entry) => entry.modelId),
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
						await data.write(
							{ namespace: "test/touch", version: 1, value: { touchedAt: new Date().toISOString() } },
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
