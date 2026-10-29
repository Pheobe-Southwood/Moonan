import { defineRegistry } from "@earendil-works/chord";

/**
 * Provider-neutral metadata for one configured chat model.
 *
 * This is plain JSON: the registry value never crosses a link, but keeping the catalog
 * serializable lets a plugin expose it over HTTP or in a panel without a second shape.
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
 * `list()` is the key-free catalog. `runtime()` is a server-only handle whose concrete
 * shape belongs to the provider package; ai-gateway returns its pi-ai `MutableModels`
 * there. The SDK stays free of pi-ai so a generic plugin does not inherit an AI dependency.
 *
 * A consumer looks the provider up with the code version of its root:
 *
 * ```ts
 * const providers = api.registry(ModelProviders);
 * const provider = providers.get("ai-gateway", ctx);
 * ```
 *
 * The registry value is not a Chord contract: there is no `uses` entry and no wire
 * compatibility rule. Its table is replaced with each code version like every registry.
 */
export interface ModelProvider {
	readonly id: string;
	readonly title: string;
	list(): readonly ModelInfo[];
	runtime(): unknown;
}

export const ModelProviders = defineRegistry<ModelProvider>("moonan.model-providers", {
	conflict: "error",
});
