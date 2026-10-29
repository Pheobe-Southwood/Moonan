import type { ModelInfo, ModelProvider } from "@moonan_ai/sdk";
import type { MutableModels } from "@earendil-works/pi-ai";

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
