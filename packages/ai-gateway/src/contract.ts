import { hostNamed, local, method, obj, remote } from "@moonan_ai/sdk";
import {
	AddBuiltinProviderInputSchema,
	AddProviderInputSchema,
	DeleteModelInputSchema,
	DiscoveryResultSchema,
	GatewayHealthSchema,
	GatewaySettingsSchema,
	GatewaySnapshotSchema,
	ImportModelsInputSchema,
	ImportResultSchema,
	ModelConfigSchema,
	ProviderIdInputSchema,
	ProviderViewSchema,
	SaveModelInputSchema,
	SaveProviderInputSchema,
	SaveSettingsInputSchema,
	SetProviderEnabledInputSchema,
} from "./schema.js";

const EMPTY = obj({}, { open: true });

/**
 * The host-lifetime object behind every global contribution.
 *
 * A registry entry is part of the host, not of a user: the `DataCodecs` codec, the HTTP
 * routes and the `ModelProviders` entry are registered once by this object and outlive any
 * sign-in. Chord only lets a `lifetime: "host"` object register, which is why this contract
 * exists at all; it is local, has no members and is never referenced by a browser.
 *
 * The object resolves a caller's per-user {@link AiGateway} on demand and never holds a
 * config cell of its own: user configuration belongs to the per-principal object.
 */
export const GatewayAdmin = local("moonan.ai-gateway.admin", {
	version: 1,
	input: EMPTY,
	members: {},
});

/**
 * One signed-in user's gateway, as the browser and the HTTP routes see it.
 *
 * Remote contract version 4: the object is per principal (per login session), so every
 * account reads and writes its own configuration through the platform `DataStore` owner.
 * It keeps the variant and the mutating members the panel already knew; `health` moved here
 * from the removed shared state object so the HTTP surface can answer from the caller's own
 * object. `snapshot` is the key-free projection and every mutation stays server-side.
 *
 * There is deliberately no shared, host-lifetime gateway state: two users (or two sessions)
 * never observe each other's providers, keys or storage revision.
 */
export const AiGateway = remote("moonan.ai-gateway", {
	version: 4,
	input: EMPTY,
	host: hostNamed("moonan"),
	variants: {
		v1: {
			state: { snapshot: GatewaySnapshotSchema },
			methods: {
				health: method(undefined, GatewayHealthSchema),
				addBuiltinProvider: method(AddBuiltinProviderInputSchema, ProviderViewSchema),
				addProvider: method(AddProviderInputSchema, ProviderViewSchema),
				saveProvider: method(SaveProviderInputSchema, ProviderViewSchema),
				deleteProvider: method(ProviderIdInputSchema),
				setProviderEnabled: method(SetProviderEnabledInputSchema, ProviderViewSchema),
				saveModel: method(SaveModelInputSchema, ModelConfigSchema),
				deleteModel: method(DeleteModelInputSchema),
				importModels: method(ImportModelsInputSchema, ImportResultSchema),
				discoverModels: method(ProviderIdInputSchema, DiscoveryResultSchema),
				saveSettings: method(SaveSettingsInputSchema, GatewaySettingsSchema),
				reloadFromDisk: method(undefined, GatewaySnapshotSchema),
			},
		},
	},
});
