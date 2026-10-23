import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHost, webSocketLink } from "@earendil-works/chord";
import { AgentContract, ChatContract, LogsContract, ProvidersContract } from "@moonan_ai/contracts";
import { createMoonan, type Moonan } from "@moonan_ai/core";
import { startFakeOpenAI, type FakeOpenAI } from "@moonan_ai/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { builtinPlugins, VERSION } from "../src/plugins/index.js";

const AGENT = "main";

let dataDir: string;
let moonan: Moonan;
let fake: FakeOpenAI;
let host: ReturnType<typeof createHost>;
let socket: WebSocket;

async function waitFor<T>(probe: () => T | undefined | false, timeoutMs = 20_000, label = "condition"): Promise<T> {
	const started = Date.now();
	for (;;) {
		const value = probe();
		if (value) return value;
		if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

beforeAll(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "moonan-reload-turn-"));
	// Slow enough that the reload lands in the middle of the model stream.
	fake = await startFakeOpenAI({ chunkDelayMs: 150 });
	moonan = await createMoonan({ dataDir, port: 0, version: VERSION, builtinPlugins });
	socket = new WebSocket(`ws://127.0.0.1:${moonan.port}/ws`);
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("websocket failed")), { once: true });
	});
	host = createHost({ kind: "client", self: { id: "test" } });
	host.connect(webSocketLink(socket as never), { principal: { id: "test" } });

	const providers = await host.get(ProvidersContract, {});
	await providers.addCustom({
		id: "fake",
		name: "Fake",
		baseUrl: fake.baseUrl,
		api: "openai-completions",
		models: [{ id: "fake-model", name: "Fake model" }],
	});
	await providers.setKey({ provider: "fake", key: "test-key" });
	const agent = await host.get(AgentContract, { agent: AGENT });
	await agent.updateConfig({ name: "月见", model: { provider: "fake", id: "fake-model" }, variables: [] });
}, 60_000);

afterAll(async () => {
	await host?.close().catch(() => undefined);
	socket?.close();
	await moonan?.close().catch(() => undefined);
	await fake?.close();
	await rm(dataDir, { recursive: true, force: true });
});

describe("reload during a turn", () => {
	it("finishes the old turn once and keeps serving afterwards", async () => {
		const agent = await host.get(AgentContract, { agent: AGENT });
		const chat = await host.get(ChatContract, { agent: AGENT });
		const outs = () => (chat.messages.value as { direction: string; text: string }[]).filter((message) => message.direction === "out");

		await chat.post({ text: "你好" });
		await waitFor(() => agent.phase.value === "streaming", 10_000, "the turn to start");

		const chatUrl = builtinPlugins.find((plugin) => plugin.id === "chat")?.module;
		expect(chatUrl).toBeTruthy();
		await moonan.chordHost.reload([chatUrl as URL]);

		await waitFor(() => agent.phase.value === "idle", 30_000, "idle after the reload");
		expect(outs()).toHaveLength(1);
		expect(outs()[0]?.text).toContain("你来了");

		// The reload swapped the code while the turn was in flight; the transcript
		// must hold the user message exactly once (watermark, not append-everything).
		const logs = await host.get(LogsContract, { agent: AGENT });
		const page = await logs.page({ limit: 100 });
		const users = page.filter((entry) => entry.role === "user" && JSON.stringify(entry.message).includes("你好"));
		expect(users).toHaveLength(1);

		// And the new code still answers: a queued batch becomes the next turn.
		await chat.post({ text: "第二句" });
		await waitFor(() => outs().length === 2, 30_000, "a second reply");
	}, 90_000);
});
