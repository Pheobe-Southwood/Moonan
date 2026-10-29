import { Routes, Type, defineFacet, local } from "@moonan_ai/sdk";
import {
	AI_GATEWAY_PROVIDER_ID,
	ModelProviders,
	isAiGatewayModelProvider,
} from "@moonan_ai/ai-gateway/model-provider";

/**
 * A real cross-plugin consumer used by the gateway integration test.
 *
 * It resolves ai-gateway through the platform registry (not by importing its facet) and
 * proves that another server plugin can reach the configured pi-ai models.
 */
const Root = local("test.ai-gateway-consumer", {
	version: 1,
	input: Type.Object({}),
	members: {},
});

export default defineFacet((api) => {
	const providers = api.registry(ModelProviders);

	api.serve(
		Root,
		(_input, _principal, self) => {
			self.register(Routes, {
				"GET /api/model-provider": (_request, response) => {
					const provider = providers.get(AI_GATEWAY_PROVIDER_ID);
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
			});
			return {};
		},
		{ lifetime: "host" },
	);
});
