import { describe, expect, it } from "vitest";
import { emptyConfig } from "../src/config.js";
import { buildGatewayModels } from "../src/runtime.js";

describe("gateway model runtime", () => {
	it("builds one MutableModels with every enabled provider", () => {
		const config = emptyConfig();
		config.providers.push({
			id: "atlas",
			name: "Atlas",
			source: "custom",
			enabled: true,
			api: "openai-completions",
			baseUrl: "http://127.0.0.1:1234/v1",
			apiKey: "sk-test-12345678",
			models: [
				{
					id: "hand-written",
					name: "Hand Written",
					type: "chat",
					input: ["text"],
					cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 64_000,
					maxTokens: 8_192,
					reasoning: false,
					createdAt: "2026-01-01T00:00:00.000Z",
					updatedAt: "2026-01-01T00:00:00.000Z",
				},
			],
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		});

		const runtime = buildGatewayModels(() => config);
		expect(runtime.warnings).toEqual([]);
		expect(runtime.models.getModel("atlas", "hand-written")?.id).toBe("hand-written");
	});

	it("skips a disabled provider", () => {
		const config = emptyConfig();
		config.providers.push({
			id: "off",
			name: "Off",
			source: "custom",
			enabled: false,
			api: "openai-completions",
			baseUrl: "http://127.0.0.1:1234/v1",
			models: [],
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		});
		const runtime = buildGatewayModels(() => config);
		expect(runtime.models.getModels()).toEqual([]);
	});
});
