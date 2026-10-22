import { type RemoteContract, hostNamed, method, remote } from "@earendil-works/chord";
import { Type } from "typebox";
import {
	AgentConfigPatchSchema,
	AgentConfigSchema,
	AgentStatusSchema,
	AgentSummarySchema,
	LiveMessageSchema,
	SendModeSchema,
} from "./common.js";

const agentDef = {
	version: 1,
	input: Type.Object({ agent: Type.String() }),
	host: hostNamed("moonan"),
	variants: {
		v1: {
			state: {
				config: AgentConfigSchema,
				phase: AgentStatusSchema,
				live: LiveMessageSchema,
			},
			methods: {
				send: method(Type.Object({ text: Type.String(), mode: Type.Optional(SendModeSchema) })),
				interrupt: method(),
				updateConfig: method(AgentConfigPatchSchema, AgentConfigSchema),
			},
		},
	},
};

export const AgentContract: RemoteContract<typeof agentDef> = remote("moonan.agent", agentDef);

const indexDef = {
	version: 1,
	input: Type.Object({}),
	host: hostNamed("moonan"),
	variants: {
		v1: {
			state: { agents: Type.Array(AgentSummarySchema) },
			methods: {},
		},
	},
};

export const AgentIndexContract: RemoteContract<typeof indexDef> = remote("moonan.agent-index", indexDef);
