import type { ModelConfig, ProviderView } from "../schema.js";

export const PROVIDER_COLORS = ["#b6a4ff", "#ff7a59", "#6fe3c1", "#f4c56a", "#8ac7ff", "#ff8fa3", "#c9f77a", "#ffb86b"];

/** Colors by insertion order: with a handful of providers this is always distinct. */
export function colorForIndex(index: number): string {
	return PROVIDER_COLORS[((index % PROVIDER_COLORS.length) + PROVIDER_COLORS.length) % PROVIDER_COLORS.length]!;
}

export function providerColors(providers: { id: string }[]): Map<string, string> {
	return new Map(providers.map((provider, index) => [provider.id, colorForIndex(index)]));
}

export function formatTokens(value: number | undefined): string {
	if (value === undefined || !Number.isFinite(value) || value <= 0) return "—";
	if (value >= 1_000_000) {
		const millions = value / 1_000_000;
		return `${millions >= 10 ? Math.round(millions) : millions.toFixed(1).replace(/\.0$/, "")}M`;
	}
	if (value >= 1_000) {
		const thousands = value / 1_000;
		return `${thousands >= 100 ? Math.round(thousands) : thousands.toFixed(1).replace(/\.0$/, "")}k`;
	}
	return String(Math.round(value));
}

export function formatPrice(value: number | undefined): string {
	if (value === undefined || !Number.isFinite(value)) return "—";
	if (value === 0) return "0";
	if (value < 0.01) return `$${value.toFixed(4)}`;
	if (value < 1) return `$${value.toFixed(2)}`;
	return `$${value.toFixed(value >= 100 ? 0 : 2).replace(/\.00$/, "")}`;
}

export function formatCostPair(cost: ModelConfig["cost"]): string {
	return `${formatPrice(cost.input)} / ${formatPrice(cost.output)}`;
}

export function totalModels(providers: ProviderView[]): number {
	return providers.reduce((total, provider) => total + provider.models.length, 0);
}

export function maxContext(providers: ProviderView[]): number {
	let max = 0;
	for (const provider of providers) for (const model of provider.models) max = Math.max(max, model.contextWindow);
	return max;
}

export function reasoningCount(providers: ProviderView[]): number {
	return providers.reduce(
		(total, provider) => total + provider.models.filter((model) => model.reasoning).length,
		0,
	);
}

export function visionCount(providers: ProviderView[]): number {
	return providers.reduce(
		(total, provider) => total + provider.models.filter((model) => model.input.includes("image")).length,
		0,
	);
}

export function providerModelApis(provider: ProviderView): string[] {
	return [...new Set(provider.models.map((model) => model.api ?? provider.api))];
}

export function relativeTime(value: string | undefined): string {
	if (!value) return "尚未写入";
	const time = Date.parse(value);
	if (!Number.isFinite(time)) return value;
	const delta = Date.now() - time;
	if (delta < 60_000) return "刚刚";
	if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
	if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
	return new Date(time).toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

export function scaleHeight(contextWindow: number, max: number): number {
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) return 6;
	const minLog = Math.log2(4_096);
	const maxLog = Math.log2(Math.max(max, 1_000_000));
	const log = Math.log2(Math.max(contextWindow, 2_048));
	const ratio = Math.min(1, Math.max(0, (log - minLog) / (maxLog - minLog)));
	return Math.round(10 + ratio * 90);
}

export function authLabel(kind: string): string {
	if (kind === "api-key+oauth") return "API Key / OAuth";
	if (kind === "oauth") return "OAuth";
	if (kind === "api-key") return "API Key";
	return kind;
}

export function isHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

export function parseJsonValue(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
	if (text.trim() === "") return { ok: true, value: undefined };
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

