import { hostNamed, local, method, remote } from "@moonan_ai/sdk";
import { Type } from "typebox";
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

const EMPTY = Type.Object({});

/**
 * The one authority.
 *
 * It is local and host-lifetime: exactly one instance exists while the server facet is
 * loaded, every browser view reads it through {@link AiGateway}, and every HTTP route
 * writes through it. Reloading the server facet replaces the code but not this object,
 * so the config cell survives as a projection of the platform DataStore dataset.
 */
export const GatewayState = local("moonan.ai-gateway.state", {
	version: 2,
	input: EMPTY,
	members: {
		snapshot: GatewaySnapshotSchema,
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
});

/**
 * The browser's view. It carries no state of its own: `snapshot` is the local object's
 * state member exposed as this object's state, so a write made by any principal is
 * visible to every panel on the next Chord revision.
 */
export const AiGateway = remote("moonan.ai-gateway", {
	version: 2,
	input: EMPTY,
	host: hostNamed("moonan"),
	variants: {
		v1: {
			state: { snapshot: GatewaySnapshotSchema },
			methods: {
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

