import { local, method } from "@earendil-works/chord";
import { Type, type Static } from "typebox";
import {
	CustomProviderInputSchema,
	ModelInfoSchema,
	ProviderInfoSchema,
	TranscriptEntrySchema,
} from "./common.js";

/**
 * Local capability contracts: what the kernel offers to plugins.
 *
 * A plugin gets one with `self.get(Capability, {})` and calls it in-process; nothing
 * here crosses a link, so native handles stay on the server. Each is served once, by
 * the kernel, with `{ lifetime: "host" }`.
 */

export const AppStateSchema = Type.Object({
	user: Type.String(),
	locale: Type.String(),
	version: Type.String(),
});
export type AppStateInfo = Static<typeof AppStateSchema>;

/** Where the app keeps its data. Plugins derive their own database path from it. */
export const HostPaths = local("moonan.host-paths", {
	version: 1,
	input: Type.Object({}),
	members: {
		dataDir: Type.String(),
	},
});

/** Deliver a user message to an agent and control its turn. All calls return immediately. */
export const AgentAdmin = local("moonan.agent-admin", {
	version: 1,
	input: Type.Object({}),
	members: {
		send: method(Type.Object({ agent: Type.String(), text: Type.String() })),
		canSend: method(Type.Object({ agent: Type.String() }), Type.Boolean()),
		interrupt: method(Type.Object({ agent: Type.String() })),
	},
});

/** Read-only access to the model's transcript — the agent's memory, owned by the kernel. */
export const TranscriptAdmin = local("moonan.transcript-admin", {
	version: 1,
	input: Type.Object({}),
	members: {
		page: method(
			Type.Object({ agent: Type.String(), before: Type.Optional(Type.Number()), limit: Type.Number() }),
			Type.Array(TranscriptEntrySchema),
		),
		count: method(Type.Object({ agent: Type.String() }), Type.Number()),
	},
});

/** Provider catalogue and credentials. */
export const ModelAdmin = local("moonan.model-admin", {
	version: 1,
	input: Type.Object({}),
	members: {
		providers: method(undefined, Type.Array(ProviderInfoSchema)),
		models: method(Type.Object({ provider: Type.String() }), Type.Array(ModelInfoSchema)),
		setKey: method(Type.Object({ provider: Type.String(), key: Type.String() })),
		clearKey: method(Type.Object({ provider: Type.String() })),
		addCustom: method(CustomProviderInputSchema, ProviderInfoSchema),
		removeCustom: method(Type.Object({ id: Type.String() })),
		refresh: method(Type.Object({ provider: Type.Optional(Type.String()) })),
	},
});

/** App-wide settings a plugin may read. */
export const AppAdmin = local("moonan.app-admin", {
	version: 1,
	input: Type.Object({}),
	members: {
		get: method(undefined, AppStateSchema),
	},
});
