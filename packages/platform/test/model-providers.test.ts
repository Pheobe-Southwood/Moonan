import { afterEach, describe, expect, it } from "vitest";
import { appFor, cleanup, pluginDir } from "./support.js";

const PROVIDER = `
import { ModelProviders, Type, defineFacet, local } from "@moonan_ai/sdk";

const Root = local("test.model-provider.root", {
	version: 1,
	input: Type.Object({}),
	members: {},
});

export default defineFacet((api) => {
	api.serve(
		Root,
		(_input, _principal, self) => {
			self.register(ModelProviders, {
				fake: {
					id: "fake",
					title: "Fake provider",
					list: () => [
						{ providerId: "fake", modelId: "m1", name: "Model One", input: ["text"], reasoning: false },
					],
					runtime: () => ({ ok: true }),
				},
			});
			return {};
		},
		{ lifetime: "host" },
	);
});
`;

const CONSUMER = `
import { ModelProviders, Routes, Type, defineFacet, local } from "@moonan_ai/sdk";

const Root = local("test.model-consumer.root", {
	version: 1,
	input: Type.Object({}),
	members: {},
});

export default defineFacet((api) => {
	const providers = api.registry(ModelProviders);
	api.serve(
		Root,
		(_input, _principal, self) => {
			self.register(Routes, {
				"GET /api/model-provider": (_request, response) => {
					const provider = providers.get("fake");
					response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
					response.end(
						JSON.stringify({
							list: provider?.list() ?? [],
							runtime: provider?.runtime() ?? null,
						}),
					);
				},
			});
			return {};
		},
		{ lifetime: "host" },
	);
});
`;

afterEach(cleanup);

describe("ModelProviders registry", () => {
	it("lets one plugin resolve another plugin's model provider by id", async () => {
		const app = await appFor([await pluginDir(PROVIDER), await pluginDir(CONSUMER)]);
		const body = (await (await fetch(`${app.url}/api/model-provider`)).json()) as {
			list: { modelId: string; name: string }[];
			runtime: unknown;
		};
		expect(body.list).toEqual([
			expect.objectContaining({ providerId: "fake", modelId: "m1", name: "Model One" }),
		]);
		expect(body.runtime).toEqual({ ok: true });
	});

	it("returns undefined when the provider is absent", async () => {
		const app = await appFor([await pluginDir(CONSUMER)]);
		const body = (await (await fetch(`${app.url}/api/model-provider`)).json()) as {
			list: unknown[];
			runtime: unknown;
		};
		expect(body.list).toEqual([]);
		expect(body.runtime).toBeNull();
	});
});
