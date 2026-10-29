import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHost, webSocketLink } from "@earendil-works/chord";
import WebSocket from "ws";
import { start } from "../../../platform/dist/index.js";
import { silentLogger } from "../../../platform/dist/logger.js";
import { AiGateway } from "../../dist/contract.js";
import { defaultSettings } from "../../dist/config.js";

const home = await mkdtemp(join(tmpdir(), "moonan-gateway-home-"));
const pluginsDir = await mkdtemp(join(tmpdir(), "moonan-gateway-plugins-"));
const dataFile = join(home, "data.json");
const consumerDir = fileURLToPath(new URL("./consumer-plugin", import.meta.url));

const upstream = createServer((request, response) => {
	if (request.url === "/v1/models" && request.headers.authorization === "Bearer sk-upstream-12345678") {
		response.writeHead(200, { "content-type": "application/json" });
		response.end(
			JSON.stringify({
				data: [
					{
						id: "atlas-4o",
						name: "Atlas 4o",
						context_length: 200_000,
						max_completion_tokens: 32_768,
						architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
						pricing: { prompt: "0.0000025", completion: "0.00001" },
					},
					{ id: "atlas-coder", name: "Atlas Coder", context_length: 262_144, max_completion_tokens: 32_768 },
					{ id: "atlas-reasoner", name: "Atlas Reasoner", context_length: 1_000_000, reasoning: true },
				],
			}),
		);
		return;
	}
	response.writeHead(401, { "content-type": "application/json" });
	response.end(JSON.stringify({ error: { message: "bad key" } }));
});
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const address = upstream.address();
if (typeof address !== "object" || address === null) throw new Error("no upstream port");
const upstreamUrl = `http://127.0.0.1:${address.port}/v1`;

let app;
let client;

async function connect(target) {
	const socket = new WebSocket(target.url.replace(/^http/, "ws") + "/ws");
	const host = createHost({ kind: "client", self: { id: "browser" }, onError: () => undefined });
	host.connect(webSocketLink(socket), { principal: { id: "host" } });
	await new Promise((resolve, reject) => {
		socket.once("open", () => resolve());
		socket.once("error", reject);
	});
	const ref = await host.get(AiGateway, {});
	return { socket, host, ref };
}

async function closeClient(current) {
	if (!current) return;
	current.ref?.release?.();
	await current.host.close().catch(() => undefined);
	current.socket.terminate();
}

async function waitFor(read, predicate, label) {
	const deadline = Date.now() + 8_000;
	for (;;) {
		try {
			const value = read();
			if (predicate(value)) return value;
		} catch {
			/* not ready */
		}
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

try {
	app = await start({
		port: 0,
		plugins: ["@moonan_ai/ai-gateway", consumerDir],
		pluginsDir,
		dataFile,
		logger: silentLogger,
	});
	client = await connect(app);
	const ref = client.ref;

	await ref.addProvider({
		id: "atlas",
		name: "Atlas Local",
		api: "openai-completions",
		baseUrl: upstreamUrl,
		apiKey: "sk-upstream-12345678",
	});
	await waitFor(
		() => ref.snapshot.value,
		(snapshot) => snapshot.providers.some((provider) => provider.id === "atlas"),
		"provider in snapshot",
	);

	await ref.saveModel({
		providerId: "atlas",
		model: {
			id: "hand-written",
			name: "Hand Written",
			api: "openai-completions",
			type: "chat",
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 64_000,
			maxTokens: 8_192,
			reasoning: false,
			samplingParams: { top_p: 0.9 },
		},
	});
	await waitFor(
		() => ref.snapshot.value.providers.find((provider) => provider.id === "atlas"),
		(provider) => provider?.models.some((model) => model.id === "hand-written") ?? false,
		"model in snapshot",
	);

	const discovery = await ref.discoverModels({ id: "atlas" });
	assert.equal(discovery.source, "upstream");
	assert.equal(discovery.models.length, 3);
	assert.equal(discovery.models[0]?.alreadyConfigured, false);

	const imported = await ref.importModels({
		providerId: "atlas",
		models: discovery.models.map(({ alreadyConfigured: _ignored, ...model }) => model),
		mode: "skip",
	});
	assert.equal(imported.added, 3);
	assert.equal(imported.skipped, 0);

	await ref.saveSettings({ settings: { ...defaultSettings(), discoveryTimeoutMs: 12_345 } });
	const snapshot = await waitFor(
		() => ref.snapshot.value,
		(value) => value.settings.discoveryTimeoutMs === 12_345 && value.providers[0]?.models.length === 4,
		"settings and imported models",
	);
	assert.equal(snapshot.providers[0]?.hasKey, true);
	assert.equal(snapshot.providers[0]?.keyHint, "•••• 5678");
	assert.ok(!JSON.stringify(snapshot).includes("sk-upstream-12345678"));

	const status = await (await fetch(`${app.url}/api/ai-gateway/status`)).json();
	assert.equal(status.providers, 1);
	assert.equal(status.models, 4);
	assert.equal(status.storage.exists, true);
	assert.equal(status.storage.mode, "0600");
	assert.equal(status.storage.dataPath, dataFile);
	assert.equal(status.storage.namespace, "ai-gateway/config");
	assert.equal(status.storage.datasets, 1);

	const configText = await (await fetch(`${app.url}/api/ai-gateway/config`)).text();
	assert.ok(!configText.includes("sk-upstream-12345678"));
	assert.ok(configText.includes("•••• 5678"));

	const exported = await (await fetch(`${app.url}/api/data/export`)).json();
	assert.ok(exported.datasets.some((dataset) => dataset.namespace === "ai-gateway/config"));
	assert.ok(!JSON.stringify(exported).includes("sk-upstream-12345678"));
	const withSecrets = await (await fetch(`${app.url}/api/data/export?includeSecrets=1`)).json();
	assert.ok(JSON.stringify(withSecrets).includes("sk-upstream-12345678"));
	const importResponse = await fetch(`${app.url}/api/data/import`, {
		method: "POST",
		body: JSON.stringify(exported),
	});
	assert.equal(importResponse.status, 200);
	await waitFor(
		() => ref.snapshot.value,
		(value) => value.providers[0]?.hasKey === true,
		"redacted import preserved the key",
	);

	const consumer = await (await fetch(`${app.url}/api/model-provider`)).json();
	assert.ok(consumer.models.includes("hand-written"));
	assert.equal(consumer.model, "hand-written");

	const raw = await readFile(dataFile, "utf8");
	const stored = JSON.parse(raw);
	assert.ok(raw.includes("sk-upstream-12345678"));
	assert.equal(stored.datasets["ai-gateway/config"].version, 1);
	assert.equal((await stat(dataFile)).mode & 0o777, 0o600);

	const reload = await fetch(`${app.url}/api/plugins/reload`, { method: "POST" });
	assert.equal(reload.status, 200);
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(ref.snapshot.value.providers[0]?.models.length, 4);

	const edited = JSON.parse(raw);
	edited.datasets["ai-gateway/config"].value.providers[0].name = "Atlas Renamed";
	await writeFile(dataFile, JSON.stringify(edited, null, 2), "utf8");
	const reloaded = await ref.reloadFromDisk();
	assert.equal(reloaded.providers[0]?.name, "Atlas Renamed");

	await ref.addBuiltinProvider({ presetId: "anthropic" });
	const withBuiltin = await waitFor(
		() => ref.snapshot.value,
		(value) => value.providers.some((provider) => provider.id === "anthropic"),
		"built-in provider",
	);
	const anthropic = withBuiltin.providers.find((provider) => provider.id === "anthropic");
	assert.ok(anthropic.models.length > 10);

	await closeClient(client);
	client = undefined;
	await app.close();
	app = await start({
		port: 0,
		plugins: ["@moonan_ai/ai-gateway", consumerDir],
		pluginsDir,
		dataFile,
		logger: silentLogger,
	});
	client = await connect(app);
	const restored = await waitFor(
		() => client.ref.snapshot.value,
		(value) => value.providers.length === 2,
		"restored providers",
	);
	const atlas = restored.providers.find((provider) => provider.id === "atlas");
	assert.equal(atlas?.name, "Atlas Renamed");
	assert.equal(atlas?.hasKey, true);
	assert.equal(atlas?.models.length, 4);
	assert.equal(restored.settings.discoveryTimeoutMs, 12_345);

	console.log(JSON.stringify({ ok: true, providers: restored.providers.length, models: status.models }));
} catch (error) {
	console.error(error.stack || error);
	process.exitCode = 1;
} finally {
	await closeClient(client).catch(() => undefined);
	await app?.close().catch(() => undefined);
	await new Promise((resolve) => upstream.close(() => resolve()));
	await rm(home, { recursive: true, force: true });
	await rm(pluginsDir, { recursive: true, force: true });
}
