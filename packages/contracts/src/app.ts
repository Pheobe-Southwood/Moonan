import { hostNamed, method, remote } from "@earendil-works/chord";
import { Type } from "typebox";
import { PluginInfoSchema } from "./common.js";

/**
 * App-wide status: who the person is, what language the UI speaks, what plugins loaded.
 *
 * v2 drops `panels`: a panel is a browser concern, registered by the plugin's web
 * facet in the shell's own registry, so the kernel no longer has an opinion about it.
 */
export const AppContract = remote("moonan.app", {
	version: 2,
	input: Type.Object({}),
	host: hostNamed("moonan"),
	variants: {
		v2: {
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
