import { ProvidersContract } from "@moonan_ai/contracts";
import { defineServerPlugin } from "@moonan_ai/plugin-sdk";
import { Type } from "typebox";
import { ProviderInfoSchema } from "@moonan_ai/contracts";

export default defineServerPlugin("providers", ({ chord, models, log }) => {
	chord.serve(ProvidersContract, (_input, _principal, self) => {
		const providers = self.state("providers", Type.Array(ProviderInfoSchema), models.providers());

		const refresh = () => {
			void chord
				.root((ctx) => {
					providers.replace(ctx, models.providers(), { diff: true });
				})
				.catch((error: unknown) => log.warn("provider state refresh failed", error));
		};

		return {
			variant: "v1" as const,
			providers,
			setKey: async ({ provider, key }: { provider: string; key: string }) => {
				await models.setKey(provider, key);
				refresh();
			},
			clearKey: async ({ provider }: { provider: string }) => {
				await models.clearKey(provider);
				refresh();
			},
			addCustom: (input: Parameters<typeof models.addCustom>[0]) => {
				const info = models.addCustom(input);
				refresh();
				return info;
			},
			removeCustom: ({ id }: { id: string }) => {
				models.removeCustom(id);
				refresh();
			},
			models: ({ provider }: { provider: string }) => models.models(provider),
			refresh: async ({ provider }: { provider?: string }) => {
				await models.refresh(provider);
				refresh();
			},
			beginOauth: async ({ provider }: { provider: string }) => {
				await models.beginOauth(provider);
			},
		};
	});
});
