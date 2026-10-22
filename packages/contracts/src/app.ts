import { hostNamed, method, remote } from "@earendil-works/chord";
import { Type } from "typebox";
import { PluginInfoSchema } from "./common.js";

/** App-wide status: who the person is, what language the UI speaks, what plugins loaded. */
export const AppContract = remote("moonan.app", {
	version: 1,
	input: Type.Object({}),
	host: hostNamed("moonan"),
	variants: {
		v1: {
			state: {
				user: Type.String(),
				locale: Type.String(),
				version: Type.String(),
				plugins: Type.Array(PluginInfoSchema),
			},
			methods: {
				update: method(
					Type.Object({
						user: Type.Optional(Type.String()),
						locale: Type.Optional(Type.String()),
					}),
				),
			},
		},
	},
});
