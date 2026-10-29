import type { MutableModels } from "@earendil-works/pi-ai";
import { defineRegistry } from "@moonan_ai/sdk";

/**
 * Provider-neutral metadata for one configured chat model.
 *
 * This shape belongs to the model feature, not to the platform. It lives in ai-gateway's
 * public `./model-provider` entry so a consumer depends on the feature contract it uses
 * instead of importing ai-gateway internals or forcing model vocabulary into the SDK.
 */
export interface ModelInfo {
	readonly providerId: string;
	readonly modelId: string;
	readonly name: string;
	readonly contextWindow?: number;
	readonly maxTokens?: number;
	readonly input: readonly ("text" | "image")[];
	readonly reasoning: boolean;
}

/**
 * A model provider contribution.
 *
 * `list()` is the key-free catalog. `runtime()` is a server-only handle owned by the
 * provider package; ai-gateway returns its pi-ai `MutableModels` there.
 *
 * A consumer looks the provider up with the code version of its root:
 *
 * ```ts
 * const providers = api.registry(ModelProviders);
 * const provider = providers.get(AI_GATEWAY_PROVIDER_ID, ctx);
 * ```
 *
 * The registry is a Chord registry, so its table is replaced with each code version and a
 * contributor must be a `lifetime: "host"` object. It is not a Chord contract: there is no
 * `uses` entry and no wire compatibility rule.
 */
export interface ModelProvider {
	readonly id: string;
	readonly title: string;
	list(): readonly ModelInfo[];
	runtime(): unknown;
}

/**
 * The model feature's registry. It is defined and owned by this plugin package; the
 * platform and SDK only provide the generic `defineRegistry` primitive.
 */
export const ModelProviders = defineRegistry<ModelProvider>("moonan.model-providers", {
	conflict: "error",
});

export const AI_GATEWAY_PROVIDER_ID = "ai-gateway";

/**
 * What a consumer gets from ai-gateway's {@link ModelProvider.runtime}.
 *
 * The models carry the configured credentials and are strictly server-side. No remote
 * contract exposes them; a browser talks to a server plugin that owns this handle.
 */
export interface AiGatewayRuntime {
	readonly models: MutableModels;
	readonly warnings: readonly string[];
	readonly revision: string;
}

export interface AiGatewayModelProvider extends ModelProvider {
	runtime(): AiGatewayRuntime;
}

export function createAiGatewayModelProvider(source: {
	list(): readonly ModelInfo[];
	runtime(): AiGatewayRuntime;
}): AiGatewayModelProvider {
	return {
		id: AI_GATEWAY_PROVIDER_ID,
		title: "AI Gateway",
		list: () => source.list(),
		runtime: () => source.runtime(),
	};
}

export function isAiGatewayModelProvider(
	provider: ModelProvider | undefined,
): provider is AiGatewayModelProvider {
	return provider?.id === AI_GATEWAY_PROVIDER_ID && typeof provider.runtime === "function";
}
