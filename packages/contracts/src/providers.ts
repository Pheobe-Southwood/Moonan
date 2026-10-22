import { hostNamed, method, remote } from "@earendil-works/chord";
import { Type } from "typebox";
import {
	CustomProviderInputSchema,
	ModelInfoSchema,
	ProviderInfoSchema,
} from "./common.js";

export const ProvidersContract = remote("moonan.providers", {
	version: 1,
	input: Type.Object({}),
	host: hostNamed("moonan"),
	variants: {
		v1: {
			state: {
				providers: Type.Array(ProviderInfoSchema),
			},
			methods: {
				setKey: method(Type.Object({ provider: Type.String(), key: Type.String() })),
				clearKey: method(Type.Object({ provider: Type.String() })),
				addCustom: method(CustomProviderInputSchema, ProviderInfoSchema),
				removeCustom: method(Type.Object({ id: Type.String() })),
				models: method(Type.Object({ provider: Type.String() }), Type.Array(ModelInfoSchema)),
				refresh: method(Type.Object({ provider: Type.Optional(Type.String()) })),
				/** alpha1 placeholder: always rejects with `not_implemented`. */
				beginOauth: method(Type.Object({ provider: Type.String() })),
			},
		},
	},
});
