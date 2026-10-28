import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { CompatSchemasByApi } from "@earendil-works/pi-ai/providers/compat-schema";
import {
	CACHE_RETENTIONS,
	MODEL_INPUT_MODALITIES,
	MODEL_THINKING_LEVELS,
} from "@earendil-works/pi-ai/providers/model-schema";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import {
	API_IDS,
	API_LABELS,
	type ApiOption,
	type AuthKind,
	type CompatField,
	type GatewayOptions,
	type ModelConfig,
	type PresetSummary,
	type ProviderConfig,
} from "./schema.js";
import { cloneJson, normalizeBaseUrl, nowIso } from "./util.js";

export interface Preset {
	id: string;
	summary: PresetSummary;
	provider: Provider;
	models: Model<Api>[];
}

let cachedPresets: Preset[] | undefined;
let cachedOptions: GatewayOptions | undefined;

/** pi-ai's built-in catalogue, wrapped with the metadata the picker needs. */
export function presets(): Preset[] {
	if (cachedPresets) return cachedPresets;
	const result: Preset[] = [];
	for (const provider of builtinProviders()) {
		const models = [...provider.getModels()];
		const apis = [...new Set(models.map((model) => model.api))].sort(
			(a, b) => apiOrder(a) - apiOrder(b) || a.localeCompare(b),
		);
		result.push({
			id: provider.id,
			models,
			provider,
			summary: {
				id: provider.id,
				name: provider.name || provider.id,
				...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
				authKind: authKindOf(provider),
				modelCount: models.length,
				apis,
			},
		});
	}
	cachedPresets = result;
	return result;
}

export function presetById(id: string): Preset | undefined {
	return presets().find((preset) => preset.id === id);
}

export function presetSummaries(): PresetSummary[] {
	return presets().map((preset) => preset.summary);
}

function apiOrder(api: string): number {
	const index = API_IDS.indexOf(api as (typeof API_IDS)[number]);
	return index === -1 ? API_IDS.length : index;
}

export function authKindOf(provider: Pick<Provider, "auth">): AuthKind {
	const apiKey = provider.auth.apiKey !== undefined;
	const oauth = provider.auth.oauth !== undefined;
	if (apiKey && oauth) return "api-key+oauth";
	if (oauth) return "oauth";
	return "api-key";
}

/** The most common API among a provider's models; the provider default for new models. */
export function primaryApi(models: readonly { api: string }[]): string {
	const counts = new Map<string, number>();
	for (const model of models) counts.set(model.api, (counts.get(model.api) ?? 0) + 1);
	let best = "openai-completions";
	let bestCount = -1;
	for (const [api, count] of counts) {
		if (count > bestCount) {
			best = api;
			bestCount = count;
		}
	}
	return best;
}

export function presetToProviderConfig(preset: Preset): ProviderConfig {
	const at = nowIso();
	return {
		id: preset.id,
		name: preset.summary.name,
		source: "builtin",
		presetId: preset.id,
		enabled: true,
		api: primaryApi(preset.models),
		baseUrl: preset.provider.baseUrl ?? "",
		models: preset.models.map((model) => modelToConfig(model, preset.provider.baseUrl ?? "", at)),
		createdAt: at,
		updatedAt: at,
	};
}

/**
 * Copies the chat `Model` fields into the persisted form. Optional fields stay absent
 * instead of becoming `undefined`, so the JSON file stays clean and small.
 */
export function modelToConfig(model: Model<Api>, providerBaseUrl: string, at = nowIso()): ModelConfig {
	const baseUrl = model.baseUrl && normalizeBaseUrl(model.baseUrl) !== normalizeBaseUrl(providerBaseUrl)
		? model.baseUrl
		: undefined;
	return {
		id: model.id,
		name: model.name || model.id,
		...(model.api ? { api: model.api } : {}),
		...(baseUrl ? { baseUrl } : {}),
		type: "chat",
		input: [...model.input],
		...(model.inputLimits ? { inputLimits: cloneJson(model.inputLimits) } : {}),
		cost: cloneJson(model.cost),
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		reasoning: Boolean(model.reasoning),
		...(model.thinkingLevelMap ? { thinkingLevelMap: cloneJson(model.thinkingLevelMap) } : {}),
		...(model.promptCache ? { promptCache: cloneJson(model.promptCache) } : {}),
		...(model.samplingParams ? { samplingParams: cloneJson(model.samplingParams) } : {}),
		...(model.samplingParamsByThinkingLevel
			? { samplingParamsByThinkingLevel: cloneJson(model.samplingParamsByThinkingLevel) }
			: {}),
		...(model.compat ? { compat: cloneJson(model.compat) } : {}),
		...(model.headers ? { headers: { ...model.headers } } : {}),
		createdAt: at,
		updatedAt: at,
	};
}

/** Turns a TypeBox compat schema (pi-ai's own) into form metadata — no field list to drift. */
function describeCompat(schema: unknown): CompatField[] {
	if (typeof schema !== "object" || schema === null) return [];
	const properties = (schema as { properties?: Record<string, unknown> }).properties;
	if (!properties) return [];
	const fields: CompatField[] = [];
	for (const [key, raw] of Object.entries(properties)) {
		if (typeof raw !== "object" || raw === null) continue;
		const property = raw as {
			type?: string;
			const?: unknown;
			enum?: unknown[];
			anyOf?: { type?: string; const?: unknown }[];
			description?: string;
			default?: unknown;
		};
		const enumValues = enumValuesOf(property);
		let kind: CompatField["kind"] = "json";
		if (property.type === "boolean") kind = "boolean";
		else if (property.type === "number" || property.type === "integer") kind = "number";
		else if (property.type === "string") kind = enumValues ? "enum" : "string";
		else if (enumValues) kind = "enum";
		fields.push({
			key,
			label: key,
			kind,
			...(enumValues ? { options: enumValues } : {}),
			...(property.description ? { description: property.description } : {}),
			...(property.default !== undefined ? { default: cloneJson(property.default) } : {}),
		});
	}
	return fields;
}

function enumValuesOf(property: {
	const?: unknown;
	enum?: unknown[];
	anyOf?: { type?: string; const?: unknown }[];
}): string[] | undefined {
	if (typeof property.const === "string") return [property.const];
	if (Array.isArray(property.enum) && property.enum.every((value) => typeof value === "string")) {
		return property.enum as string[];
	}
	if (Array.isArray(property.anyOf) && property.anyOf.every((entry) => typeof entry.const === "string")) {
		return property.anyOf.map((entry) => entry.const as string);
	}
	return undefined;
}

export function gatewayOptions(): GatewayOptions {
	if (cachedOptions) return cachedOptions;
	const compatByApi = CompatSchemasByApi as unknown as Record<string, unknown>;
	const apis: ApiOption[] = API_IDS.map((id) => ({
		id,
		label: API_LABELS[id] ?? id,
		compatFields: describeCompat(compatByApi[id]),
	}));
	cachedOptions = {
		apis,
		thinkingLevels: [...MODEL_THINKING_LEVELS],
		inputModalities: [...MODEL_INPUT_MODALITIES],
		cacheRetentions: [...CACHE_RETENTIONS],
		transports: ["auto", "sse", "websocket", "websocket-cached"],
		toolChoices: ["auto", "none"],
	};
	return cachedOptions;
}

/** Reset the module-level catalogue; only tests use it. */
export function resetCatalogCache(): void {
	cachedPresets = undefined;
	cachedOptions = undefined;
}
