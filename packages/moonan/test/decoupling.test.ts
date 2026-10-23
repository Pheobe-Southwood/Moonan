import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

async function waitFor<T>(probe: () => T | undefined | false, timeoutMs = 15_000, label = "condition"): Promise<T> {
	const started = Date.now();
	for (;;) {
		const value = probe();
		if (value) return value;
		if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

function tables(file: string): string[] {
	const db = new DatabaseSync(file, { readOnly: true });
	try {
		const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[];
		return rows.map((row) => row.name);
	} finally {
		db.close();
	}
}

async function connect(instance: Moonan): Promise<void> {
	socket = new WebSocket(`ws://127.0.0.1:${instance.port}/ws`);
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("websocket failed")), { once: true });
	});
	host = createHost({ kind: "client", self: { id: "test" } });
	host.connect(webSocketLink(socket as never), { principal: { id: "test" } });
}

async function pickModel(): Promise<void> {
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
}

beforeAll(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "moonan-decouple-"));
	fake = await startFakeOpenAI();
	moonan = await createMoonan({ dataDir, port: 0, version: VERSION, builtinPlugins });
	await connect(moonan);
	await pickModel();
}, 60_000);

afterAll(async () => {
	await host?.close().catch(() => undefined);
	socket?.close();
	await moonan?.close().catch(() => undefined);
	await fake?.close();
	await rm(dataDir, { recursive: true, force: true });
});

describe("data ownership", () => {
	it("keeps chat out of the kernel database", async () => {
		const chat = await host.get(ChatContract, { agent: AGENT });
		await chat.post({ text: "你好" });
		await waitFor(
			() => (chat.messages.value as { direction: string }[]).some((message) => message.direction === "out"),
			20_000,
			"a reply",
		);

		const kernel = tables(join(dataDir, "moonan.db"));
		expect(kernel).toContain("agent_messages");
		expect(kernel).not.toContain("chat_messages");
		expect(kernel).not.toContain("mcp_servers");
		expect(kernel).not.toContain("plugin_state");

		const chatTables = tables(join(dataDir, "plugins-data", "chat.db"));
		expect(chatTables).toContain("messages");
		expect(chatTables).toContain("schema_migrations");
	}, 60_000);

	it("answers a post before the model does", async () => {
		const chat = await host.get(ChatContract, { agent: AGENT });
		const started = Date.now();
		await chat.post({ text: "第二句" });
		expect(Date.now() - started).toBeLessThan(500);

		const agent = await host.get(AgentContract, { agent: AGENT });
		const sent = Date.now();
		await agent.send({ text: "第三句" });
		expect(Date.now() - sent).toBeLessThan(500);
	}, 60_000);

	it("reads the transcript through the logs contract", async () => {
		const agent = await host.get(AgentContract, { agent: AGENT });
		await waitFor(() => agent.phase.value === "idle", 30_000, "idle");
		const logs = await host.get(LogsContract, { agent: AGENT });
		const page = await logs.page({ limit: 50 });
		expect(page.length).toBeGreaterThan(0);
		expect(page.some((entry) => entry.role === "user")).toBe(true);
	}, 60_000);

	it("keeps chat history across a restart", async () => {
		await host.close().catch(() => undefined);
		socket.close();
		await moonan.close();

		moonan = await createMoonan({ dataDir, port: 0, version: VERSION, builtinPlugins });
		await connect(moonan);
		const chat = await host.get(ChatContract, { agent: AGENT });
		await waitFor(() => (chat.messages.value as { direction: string }[]).length > 0, 10_000, "restored bubbles");
		const texts = (chat.messages.value as { text: string }[]).map((message) => message.text);
		expect(texts.some((text) => text.includes("你好"))).toBe(true);
	}, 60_000);
});
