import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { presetById, presetToProviderConfig } from "../src/catalog.js";
import { discoverModels } from "../src/discovery.js";
import type { GatewayConfig, ProviderConfig } from "../src/schema.js";
import { emptyConfig } from "../src/config.js";

let server: Server;
let baseUrl: string;
const seen: { url?: string; authorization?: string }[] = [];

beforeAll(async () => {
	server = createServer((request, response) => {
		seen.push({ url: request.url, authorization: request.headers.authorization });
		if (request.url !== "/v1/models") {
			response.writeHead(404, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: "not found" }));
			return;
		}
		if (request.headers.authorization !== "Bearer sk-upstream-12345678") {
			response.writeHead(401, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: { message: "bad key" } }));
			return;
		}
		response.writeHead(200, { "content-type": "application/json" });
		response.end(
			JSON.stringify({
				object: "list",
				data: [
					{
						id: "atlas-4o",
						name: "Atlas 4o",
						context_length: 200_000,
						max_completion_tokens: 32_768,
						architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
						pricing: { prompt: "0.0000025", completion: "0.00001" },
					},
					{
						id: "atlas-reasoner",
						name: "Atlas Reasoner",
						context_length: 1_000_000,
						max_completion_tokens: 64_000,
						reasoning: true,
						architecture: { input_modalities: ["text"], output_modalities: ["text"] },
					},
					{
						id: "atlas-embed",
						name: "Atlas Embed",
						context_length: 8_192,
						architecture: { input_modalities: ["text"], output_modalities: ["embedding"] },
					},
				],
			}),
		);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (typeof address !== "object" || address === null) throw new Error("no port");
	baseUrl = `http://127.0.0.1:${address.port}/v1`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

function configFor(provider: ProviderConfig): GatewayConfig {
	const config = emptyConfig();
	config.providers.push(provider);
	return config;
}

function customProvider(apiKey?: string): ProviderConfig {
	return {
		id: "atlas",
		name: "Atlas",
		source: "custom",
		enabled: true,
		api: "openai-completions",
		baseUrl,
		...(apiKey ? { apiKey, keyUpdatedAt: new Date().toISOString() } : {}),
		models: [],
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
}

describe("model discovery", () => {
	it("reads an OpenAI-compatible model list with the stored key", async () => {
		seen.length = 0;
		const provider = customProvider("sk-upstream-12345678");
		const config = configFor(provider);
		const result = await discoverModels(() => config, provider, { timeoutMs: 2_000, now: () => new Date("2026-01-02T03:04:05Z") });

		expect(result.source).toBe("upstream");
		expect(result.fetchedAt).toBe("2026-01-02T03:04:05.000Z");
		expect(result.endpoint).toMatch(/\/v1\/models$/);
		expect(result.models.map((model) => model.id)).toEqual(["atlas-4o", "atlas-reasoner"]);
		expect(result.warnings.join(" ")).toMatch(/跳过 1 个/);
		expect(seen[0]?.authorization).toBe("Bearer sk-upstream-12345678");

		const atlas = result.models.find((model) => model.id === "atlas-4o");
		expect(atlas?.contextWindow).toBe(200_000);
		expect(atlas?.maxTokens).toBe(32_768);
		expect(atlas?.input).toEqual(["text", "image"]);
		expect(atlas?.cost).toEqual({ input: 2.5, output: 10, cacheRead: 0, cacheWrite: 0 });

		const reasoner = result.models.find((model) => model.id === "atlas-reasoner");
		expect(reasoner?.reasoning).toBe(true);
	});

	it("reports an authentication failure instead of pretending to have a list", async () => {
		const provider = customProvider("wrong-key-12345678");
		const config = configFor(provider);
		await expect(discoverModels(() => config, provider, { timeoutMs: 2_000 })).rejects.toThrow(/认证失败（HTTP 401）/);
	});

	it("refuses a remote custom provider without a key", async () => {
		const provider = customProvider();
		provider.baseUrl = "https://example.invalid/v1";
		const config = configFor(provider);
		await expect(discoverModels(() => config, provider, { timeoutMs: 2_000 })).rejects.toThrow(/缺少 API Key/);
	});

	it("falls back to pi-ai's catalogue for a built-in provider without credentials", async () => {
		const preset = presetById("anthropic");
		if (!preset) throw new Error("anthropic preset missing");
		const provider = presetToProviderConfig(preset);
		const config = configFor(provider);
		const result = await discoverModels(() => config, provider, { timeoutMs: 2_000 });
		expect(result.source).toBe("catalog");
		expect(result.endpoint).toBe("catalog://anthropic");
		expect(result.models.length).toBe(preset.models.length);
		expect(result.models[0]?.alreadyConfigured).toBe(false);
		expect(result.warnings.join(" ")).toMatch(/内置目录/);
	});
});
