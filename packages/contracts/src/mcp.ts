import { hostNamed, method, remote } from "@earendil-works/chord";
import { Type } from "typebox";
import { McpServerInputSchema, McpServerStateSchema } from "./common.js";

/** MCP servers attached to the main agent, with per-tool switches. */
export const McpContract = remote("moonan.mcp", {
	version: 1,
	input: Type.Object({}),
	host: hostNamed("moonan"),
	variants: {
		v1: {
			state: {
				servers: Type.Array(McpServerStateSchema),
			},
			methods: {
				addServer: method(McpServerInputSchema, McpServerStateSchema),
				removeServer: method(Type.Object({ id: Type.String() })),
				setToolEnabled: method(
					Type.Object({
						server: Type.String(),
						tool: Type.String(),
						enabled: Type.Boolean(),
					}),
				),
				reconnect: method(Type.Object({ id: Type.String() })),
			},
		},
	},
});
