import type { DiscoveryResult, DiscoveredModel, GatewayConfig, ProviderConfig } from "./schema.js";
import { presetById } from "./catalog.js";
import { resolveAuth } from "./runtime.js";
import {
	cloneJson,
	displayNameFromId,
	errorMessage,
	isLocalEndpoint,
	normalizeBaseUrl,
	normalizeHeaders,
	sanitizeEndpoint,
} from "./util.js";

export const GATEWAY_VERSION = "0.0.4-alpha2";
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_ERROR_BODY = 400;

export interface DiscoveryOptions {
	/** Injected by tests; production uses global fetch. */
	fetch?: typeof fetch;
	timeoutMs?: number;
	signal?: AbortSignal;
	now?: () => Date;
}

interface AuthInfo {
	apiKey?: string;
	headers?: Record<string, string | null>;
	baseUrl?: string;
	env?: Record<string, string>;
	source?: string;
}

interface RawModel {
	id: string;
	name: string;
	api?: string;
	contextWindow?: number;
	maxTokens?: number;
	input?: ("text" | "image")[];
	reasoning?: boolean;
	cost?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		tiers?: { input: number; output: number; cacheRead: number; cacheWrite: number; inputTokensAbove: number }[];
	};
	ownedBy?: string;
	created?: number;
}

/**
 * Fetches a provider's model list from its own API.
 *
 * There is no universal endpoint, so this covers the common shapes (OpenAI-compatible
 * `/models`, Anthropic `/models`, Google `models`, Ollama `/api/tags`) and falls back to
 * pi-ai's built-in catalogue for providers whose API cannot enumerate models (Bedrock,
 * Vertex, and built-ins whose auth is ambient/OAuth only). The fallback is labelled in
 * the result, never passed off as a live read.
 */
export async function discoverModels(
	getConfig: () => GatewayConfig,
	provider: ProviderConfig,
	options: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
	const now = options.now ?? (() => new Date());
	const timeoutMs = options.timeoutMs ?? getConfig().settings.discoveryTimeoutMs;
	const warnings: string[] = [];
	const preset = provider.presetId ? presetById(provider.presetId) : undefined;

	let auth: AuthInfo | undefined;
	try {
		auth = await resolveAuth(getConfig, provider, options.signal);
	} catch (error) {
		warnings.push(`凭据解析失败：${errorMessage(error)}`);
	}

	const baseUrl = normalizeBaseUrl(auth?.baseUrl ?? provider.baseUrl);
	if (!baseUrl) {
		throw new Error("Base URL 为空：先在「连接」里填写上游地址。");
	}
	const api = provider.api;
	const key = auth?.apiKey ?? provider.apiKey;
	const keylessLocal = isLocalEndpoint(baseUrl);

	if (!auth && !key && !keylessLocal && provider.source === "custom") {
		throw new Error("缺少 API Key：先在「连接」里保存密钥，或把 Base URL 填成本机地址。");
	}

	if (needsCatalogOnly(api) || (!auth && !key && preset && !keylessLocal)) {
		if (!preset) {
			throw new Error(
				auth || key
					? "这个 API 不支持通用模型列表。"
					: "没有可用凭据，而且这个提供商没有内置目录。",
			);
		}
		warnings.push(
			needsCatalogOnly(api)
				? "该 API 不支持通用模型列表，已返回 pi-ai 内置目录。"
				: "没有找到可用凭据，已返回 pi-ai 内置目录；保存 API Key 后可以重新拉取。",
		);
		return catalogResult(provider, preset, warnings, now());
	}

	const authHeaders = normalizeHeaders(provider.headers, auth?.headers);
	if (!hasHeader(authHeaders, "authorization") && !hasHeader(authHeaders, "x-api-key") && !hasHeader(authHeaders, "api-key")) {
		if (key) {
			if (api === "anthropic-messages") authHeaders["x-api-key"] = key;
			else if (api === "google-generative-ai" || api === "google-vertex") authHeaders["x-goog-api-key"] = key;
			else if (api === "azure-openai-responses") authHeaders["api-key"] = key;
			else authHeaders.authorization = `Bearer ${key}`;
		}
	}
	if (!hasHeader(authHeaders, "accept")) authHeaders.accept = "application/json";
	if (!hasHeader(authHeaders, "user-agent")) authHeaders["user-agent"] = `moonan-ai-gateway/${GATEWAY_VERSION}`;
	if (api === "anthropic-messages" && !hasHeader(authHeaders, "anthropic-version")) {
		authHeaders["anthropic-version"] = "2023-06-01";
	}

	const endpoint = endpointFor(api, baseUrl);
	const timeout = AbortSignal.timeout(Math.max(1_000, Math.min(timeoutMs, 120_000)));
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	const doFetch = options.fetch ?? globalThis.fetch;

	let response: Response;
	let bodyText: string;
	try {
		response = await doFetch(endpoint, {
			method: "GET",
			headers: authHeaders,
			redirect: "follow",
			signal,
		});
		bodyText = await readCapped(response);
	} catch (error) {
		// A local OpenAI-compatible endpoint is often Ollama. Its native list lives at
		// /api/tags and works even when /v1/models does not exist.
		if (keylessLocal && api.startsWith("openai")) {
			const tags = await tryOllamaTags(baseUrl, options, timeoutMs, options.signal);
			if (tags) {
				warnings.push("已回退到 Ollama /api/tags。");
				return {
					providerId: provider.id,
					endpoint: sanitizeEndpoint(tags.endpoint),
					fetchedAt: now().toISOString(),
					source: "upstream",
					models: tags.models.map((model) => ({ ...model, alreadyConfigured: false })),
					warnings,
				};
			}
		}
		if (preset && isEnumerableFailure(error)) {
			warnings.push(`上游请求失败（${shortError(error)}），已返回 pi-ai 内置目录。`);
			return catalogResult(provider, preset, warnings, now());
		}
		throw new Error(`请求上游模型列表失败：${shortError(error)}`);
	}

	const responseInfo = { status: response.status, ok: response.ok, headers: response.headers };

	if (!responseInfo.ok) {
		const detail = cleanSnippet(bodyText);
		if ((responseInfo.status === 404 || responseInfo.status === 405 || responseInfo.status === 501) && preset) {
			warnings.push(`上游没有模型列表端点（HTTP ${responseInfo.status}），已返回 pi-ai 内置目录。`);
			return catalogResult(provider, preset, warnings, now());
		}
		if (responseInfo.status === 401 || responseInfo.status === 403) {
			throw new Error(
				`认证失败（HTTP ${responseInfo.status}）：检查 API Key 或自定义请求头。${detail ? `\n${detail}` : ""}`,
			);
		}
		if (responseInfo.status === 429) {
			throw new Error(`上游限流（HTTP 429），稍后重试。${detail ? `\n${detail}` : ""}`);
		}
		if (preset && responseInfo.status >= 500) {
			warnings.push(`上游暂时不可用（HTTP ${responseInfo.status}），已返回 pi-ai 内置目录。`);
			return catalogResult(provider, preset, warnings, now());
		}
		throw new Error(`上游返回 HTTP ${responseInfo.status}。${detail ? `\n${detail}` : ""}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(bodyText);
	} catch (error) {
		if (preset) {
			warnings.push(`上游返回的不是 JSON（${shortError(error)}），已返回 pi-ai 内置目录。`);
			return catalogResult(provider, preset, warnings, now());
		}
		throw new Error("上游返回的不是 JSON；检查 Base URL 是否指向 API 根路径。");
	}

	const { models, skipped } = normalizeModels(api, parsed);
	if (skipped > 0) warnings.push(`已跳过 ${skipped} 个非对话条目。`);
	if (models.length === 0) {
		if (preset) {
			warnings.push("上游没有返回可用的对话模型，已返回 pi-ai 内置目录。");
			return catalogResult(provider, preset, warnings, now());
		}
		throw new Error("上游没有返回可用的对话模型。");
	}

	return {
		providerId: provider.id,
		endpoint: sanitizeEndpoint(endpoint),
		fetchedAt: now().toISOString(),
		source: "upstream",
		models: models.map((model) => ({ ...model, alreadyConfigured: false })),
		warnings,
	};
}

function needsCatalogOnly(api: string): boolean {
	return api === "bedrock-converse-stream" || api === "google-vertex";
}

function endpointFor(api: string, baseUrl: string): string {
	const base = baseUrl.replace(/\/+$/, "");
	if (api === "anthropic-messages") {
		// pi-ai's Anthropic base URL is `https://api.anthropic.com`; the REST API lives
		// under /v1. A custom proxy that already ends in /v1 should not get a second one.
		return base.endsWith("/v1") ? `${base}/models?limit=1000` : `${base}/v1/models?limit=1000`;
	}
	if (api === "google-generative-ai") return `${base}/models?pageSize=1000`;
	if (api === "azure-openai-responses") return `${base}/models?api-version=2024-10-21`;
	return `${base}/models`;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
	return Object.keys(headers).some((key) => key.toLowerCase() === name);
}

async function readCapped(response: Response): Promise<string> {
	const length = Number(response.headers.get("content-length") ?? "0");
	if (length > MAX_BODY_BYTES) throw new Error(`上游响应过大（${length} bytes）`);
	const text = await response.text();
	if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new Error("上游响应超过 8 MB");
	return text;
}

function cleanSnippet(text: string): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (!compact) return "";
	return compact.length > MAX_ERROR_BODY ? `${compact.slice(0, MAX_ERROR_BODY)}…` : compact;
}

function shortError(error: unknown): string {
	if (error instanceof Error) {
		if (error.name === "TimeoutError" || /aborted|timeout/i.test(error.message)) return "请求超时";
		if (error.name === "AbortError") return "请求已取消";
		return error.message;
	}
	return String(error);
}

function isEnumerableFailure(error: unknown): boolean {
	return error instanceof Error && error.name !== "AbortError";
}

function numberFrom(...values: unknown[]): number | undefined {
	for (const value of values) {
		if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.round(value);
		if (typeof value === "string" && value.trim() !== "") {
			const parsed = Number(value);
			if (Number.isFinite(parsed) && parsed > 0) return Math.round(parsed);
		}
	}
	return undefined;
}

function booleanFrom(...values: unknown[]): boolean | undefined {
	for (const value of values) if (typeof value === "boolean") return value;
	return undefined;
}

function stringFrom(...values: unknown[]): string | undefined {
	for (const value of values) if (typeof value === "string" && value.trim() !== "") return value.trim();
	return undefined;
}

function arrayFrom(...values: unknown[]): unknown[] | undefined {
	for (const value of values) if (Array.isArray(value)) return value;
	return undefined;
}

function recordFrom(...values: unknown[]): Record<string, unknown> | undefined {
	for (const value of values) {
		if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
	}
	return undefined;
}

function normalizeInput(item: Record<string, unknown>, skip: boolean): ("text" | "image")[] | undefined {
	const architecture = recordFrom(item.architecture);
	const modalities = recordFrom(item.modalities);
	const capabilities = recordFrom(item.capabilities);
	const raw =
		arrayFrom(item.input, architecture?.input_modalities, modalities?.input) ??
		(capabilities?.vision === true ? ["text", "image"] : undefined);
	if (!raw) return skip ? ["text"] : undefined;
	const input = raw.filter((value): value is "text" | "image" => value === "text" || value === "image");
	if (input.length === 0) return undefined;
	return [...new Set(input.includes("text") ? input : ["text", ...input])] as ("text" | "image")[];
}

function normalizeCost(item: Record<string, unknown>): RawModel["cost"] | undefined {
	const direct = recordFrom(item.cost);
	if (direct) {
		const input = numberFrom(direct.input);
		const output = numberFrom(direct.output);
		if (input !== undefined || output !== undefined) {
			const cost = {
				input: input ?? 0,
				output: output ?? 0,
				cacheRead: numberFrom(direct.cacheRead) ?? 0,
				cacheWrite: numberFrom(direct.cacheWrite) ?? 0,
			};
			const tiers = arrayFrom(direct.tiers);
			if (tiers) {
				const normalizedTiers = tiers
					.map((tier) => recordFrom(tier))
					.filter((tier): tier is Record<string, unknown> => tier !== undefined)
					.map((tier) => ({
						input: numberFrom(tier.input) ?? 0,
						output: numberFrom(tier.output) ?? 0,
						cacheRead: numberFrom(tier.cacheRead) ?? 0,
						cacheWrite: numberFrom(tier.cacheWrite) ?? 0,
						inputTokensAbove: numberFrom(tier.inputTokensAbove) ?? 0,
					}));
				return normalizedTiers.length > 0 ? { ...cost, tiers: normalizedTiers } : cost;
			}
			return cost;
		}
	}

	// OpenRouter pricing is USD per token as strings. pi-ai's cost is USD per million.
	const pricing = recordFrom(item.pricing);
	if (!pricing) return undefined;
	const values = {
		input: Number(pricing.prompt ?? pricing.input ?? NaN),
		output: Number(pricing.completion ?? pricing.output ?? NaN),
		cacheRead: Number(pricing.input_cache_read ?? pricing.cache_read ?? NaN),
		cacheWrite: Number(pricing.input_cache_write ?? pricing.cache_write ?? NaN),
	};
	if (!Object.values(values).some((value) => Number.isFinite(value) && value > 0)) return undefined;
	const largest = Math.max(...Object.values(values).filter((value) => Number.isFinite(value)));
	const scale = largest > 0 && largest <= 1 ? 1_000_000 : 1;
	const n = (value: number) => (Number.isFinite(value) ? Math.round(value * scale * 1_000_000) / 1_000_000 : 0);
	return { input: n(values.input), output: n(values.output), cacheRead: n(values.cacheRead), cacheWrite: n(values.cacheWrite) };
}

function normalizeModels(api: string, payload: unknown): { models: RawModel[]; skipped: number } {
	const array = extractArray(payload);
	if (!array) throw new Error("无法识别模型列表：响应里没有 data / models 数组。");
	const seen = new Set<string>();
	const models: RawModel[] = [];
	let skipped = 0;
	for (const entry of array) {
		const item = recordFrom(entry);
		if (!item) {
			skipped += 1;
			continue;
		}
		let id = stringFrom(item.id, item.model, item.slug);
		if (!id) id = stringFrom(item.name);
		if (!id) {
			skipped += 1;
			continue;
		}
		if (id.startsWith("models/")) id = id.slice("models/".length);
		if (!shouldInclude(api, id, item)) {
			skipped += 1;
			continue;
		}
		if (seen.has(id)) continue;
		seen.add(id);

		const name =
			stringFrom(item.display_name, item.displayName) ??
			(stringFrom(item.name) && stringFrom(item.name) !== `models/${id}` ? stringFrom(item.name)! : displayNameFromId(id));
		const topProvider = recordFrom(item.top_provider);
		const limits = recordFrom(item.limits);
		const modelInfo = recordFrom(item.model_info);
		const contextWindow = numberFrom(
			item.context_length,
			item.contextWindow,
			item.context_window,
			item.max_context_length,
			item.max_input_tokens,
			item.inputTokenLimit,
			topProvider?.context_length,
			limits?.context_window,
			limits?.max_context_window,
			modelInfo?.["general.context_length"],
		);
		const maxTokens = numberFrom(
			item.max_completion_tokens,
			item.max_output_tokens,
			item.maxTokens,
			item.outputTokenLimit,
			topProvider?.max_completion_tokens,
			limits?.max_output_tokens,
		);
		const input = normalizeInput(item, true);
		const reasoning = booleanFrom(item.reasoning, item.supports_reasoning, recordFrom(item.capabilities)?.reasoning);
		const cost = normalizeCost(item);
		const model: RawModel = {
			id,
			name,
			...(contextWindow ? { contextWindow } : {}),
			...(maxTokens ? { maxTokens } : {}),
			...(input ? { input } : {}),
			...(reasoning !== undefined ? { reasoning } : {}),
			...(cost ? { cost } : {}),
			...(stringFrom(item.owned_by) ? { ownedBy: stringFrom(item.owned_by) } : {}),
			...(numberFrom(item.created) ? { created: numberFrom(item.created) } : {}),
		};
		models.push(model);
	}
	models.sort((a, b) => a.id.localeCompare(b.id, "en"));
	return { models, skipped };
}

function extractArray(payload: unknown): unknown[] | undefined {
	if (Array.isArray(payload)) return payload;
	const object = recordFrom(payload);
	return object ? arrayFrom(object.data, object.models) : undefined;
}

function shouldInclude(api: string, id: string, item: Record<string, unknown>): boolean {
	if (typeof item.type === "string" && ["embedding", "image", "audio", "moderation"].includes(item.type)) return false;
	const methods = arrayFrom(item.supportedGenerationMethods);
	if (api === "google-generative-ai" && methods && !methods.includes("generateContent")) return false;
	if (/embedding|embed-|whisper|tts-|dall-e|moderation|transcribe|speech|audio|realtime|sora|image-1/i.test(id)) {
		return false;
	}
	const output = arrayFrom(recordFrom(item.architecture)?.output_modalities);
	if (output && !output.includes("text")) return false;
	return true;
}

async function tryOllamaTags(
	baseUrl: string,
	options: DiscoveryOptions,
	timeoutMs: number,
	parentSignal?: AbortSignal,
): Promise<{ endpoint: string; models: RawModel[] } | undefined> {
	let origin: string;
	try {
		origin = new URL(baseUrl).origin;
	} catch {
		return undefined;
	}
	const endpoint = `${origin}/api/tags`;
	const timeout = AbortSignal.timeout(Math.max(1_000, Math.min(timeoutMs, 30_000)));
	const signal = parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
	const doFetch = options.fetch ?? globalThis.fetch;
	try {
		const response = await doFetch(endpoint, { headers: { accept: "application/json" }, signal });
		if (!response.ok) return undefined;
		const payload = (await response.json()) as { models?: unknown };
		if (!Array.isArray(payload.models)) return undefined;
		const models: RawModel[] = [];
		for (const entry of payload.models) {
			const item = recordFrom(entry);
			if (!item) continue;
			const id = stringFrom(item.name, item.model);
			if (!id) continue;
			models.push({
				id,
				name: displayNameFromId(id),
				contextWindow: numberFrom(item.context_length, item.contextWindow),
				maxTokens: numberFrom(item.max_output_tokens),
				input: ["text"],
			});
		}
		return models.length > 0 ? { endpoint, models } : undefined;
	} catch {
		return undefined;
	}
}

function catalogResult(
	provider: ProviderConfig,
	preset: NonNullable<ReturnType<typeof presetById>>,
	warnings: string[],
	now: Date,
): DiscoveryResult {
	const models: (DiscoveredModel & { alreadyConfigured: boolean })[] = preset.models.map((model) => ({
		id: model.id,
		name: model.name || model.id,
		api: model.api,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		...(model.input ? { input: [...model.input] } : {}),
		...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
		...(model.cost ? { cost: cloneJson(model.cost) } : {}),
		alreadyConfigured: false,
	}));
	return {
		providerId: provider.id,
		endpoint: `catalog://${preset.id}`,
		fetchedAt: now.toISOString(),
		source: "catalog",
		models,
		warnings,
	};
}
