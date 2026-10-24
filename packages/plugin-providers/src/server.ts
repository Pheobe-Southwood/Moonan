import { defineFacet, local, method } from "@earendil-works/chord";
import { Type } from "typebox";
import { ModelAdmin, ProviderInfoSchema } from "@moonan_ai/contracts";
import { ProvidersContract } from "./contract.js";

/** Provider catalogue and keys. The data lives in the kernel; this plugin is the panel. */
export default defineFacet(
	(api) => {
		api.serve(ProvidersContract, (_input, _principal, self) => {
			const admin = self.get(ModelAdmin, {});
			const providers = self.state("providers", Type.Array(ProviderInfoSchema), {
				init: () => admin.providers(),
			});
			const refresh = () => {
				void api
					.root(async (ctx) => {
						providers.replace(ctx, await admin.providers(), { diff: true });
					})
					.catch((error: unknown) => console.warn("provider state refresh failed", error));
			};

			return {
				variant: "v1" as const,
				providers,
				setKey: async ({ provider, key }: { provider: string; key: string }) => {
					await admin.setKey({ provider, key });
					refresh();
				},
				clearKey: async ({ provider }: { provider: string }) => {
					await admin.clearKey({ provider });
					refresh();
				},
				addCustom: async (input: Parameters<typeof admin.addCustom>[0]) => {
					const info = await admin.addCustom(input);
					refresh();
					return info;
				},
				removeCustom: ({ id }: { id: string }) => {
					void admin.removeCustom({ id }).then(refresh);
				},
				models: ({ provider }: { provider: string }) => admin.models({ provider }),
				refresh: async ({ provider }: { provider?: string }) => {
					await admin.refresh({ provider });
					refresh();
				},
				beginOauth: async () => {
					throw new Error("not_implemented");
				},
			};
		});
	},
	// The facet declares what it consumes so a reload can check the contract it binds.
	{ uses: [ModelAdmin] },
);
