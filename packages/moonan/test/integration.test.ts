import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHost, webSocketLink } from "@earendil-works/chord";
import { AgentContract, ChatContract, McpContract, ProvidersContract } from "@moonan_ai/contracts";
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

beforeAll(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "moonan-test-"));
	fake = await startFakeOpenAI();
	moonan = await createMoonan({
		dataDir,
		port: 0,
		version: VERSION,
		builtinPlugins,
	});

	socket = new WebSocket(`ws://127.0.0.1:${moonan.port}/ws`);
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("websocket failed")), { once: true });
	});
	host = createHost({ kind: "client", self: { id: "test" } });
	host.connect(webSocketLink(socket as never), { principal: { id: "test" } });
}, 60_000);

afterAll(async () => {
	await host?.close().catch(() => undefined);
	socket?.close();
	await moonan?.close();
	await fake?.close();
	await rm(dataDir, { recursive: true, force: true });
});

describe("moonan alpha1", () => {
	it("serves the built-in plugin list", async () => {
		const providers = await host.get(ProvidersContract, {});
		const list = providers.providers.value as { id: string }[];
		expect(Array.isArray(list)).toBe(true);
	});

	it("runs a full turn: user message in, act tool call, chat bubble out", async () => {
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
		await agent.updateConfig({
			name: "月见",
			model: { provider: "fake", id: "fake-model" },
			variables: [
				{ key: "botname", label: "角色名字", type: "text", value: "月见", global: true },
				{ key: "soul", label: "角色人设", type: "textarea", value: "安静的旧书店店主。", global: true },
			],
		});
		expect((agent.config.value as { model: unknown }).model).toEqual({ provider: "fake", id: "fake-model" });

		const chat = await host.get(ChatContract, { agent: AGENT });
		await chat.post({ text: "你好" });

		const bubble = await waitFor(
			() => (chat.messages.value as { direction: string; text: string }[]).find((message) => message.direction === "out"),
			20_000,
			"the act bubble",
		);
		expect(bubble.text).toContain("你来了");

		// The fake provider saw the batch note, the act call, and the tool result.
		const first = fake.requests[0];
		expect(JSON.stringify(first?.messages)).toContain("通过webui给你发送了 1 条消息");
		await waitFor(() => fake.requests.length >= 2, 20_000, "the follow-up request");
		expect(JSON.stringify(fake.requests[1]?.messages)).toContain("已发送");

		// The agent goes idle again once the run finishes.
		await waitFor(() => agent.phase.value === "idle", 20_000, "idle phase");
		expect(agent.live.value.turn).toBeGreaterThanOrEqual(2);
	}, 60_000);

	it("connects an MCP server and gives its tools to the main agent", async () => {
		const mcp = await host.get(McpContract, {});
		const fakeServer = fileURLToPath(new URL("../../testing/bin/fake-mcp.mjs", import.meta.url));
		const added = await mcp.addServer({
			name: "memory",
			transport: "stdio",
			command: process.execPath,
			args: [fakeServer],
		});
		expect(added.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(["recall_memory", "save_memory"]);

		const servers = await waitFor(
			() => ((mcp.servers.value as { status: string }[]).some((server) => server.status === "connected") ? mcp.servers.value : undefined),
			20_000,
			"a connected MCP server",
		);
		expect(servers).toHaveLength(1);

		const chat = await host.get(ChatContract, { agent: AGENT });
		const seen = fake.requests.length;
		await chat.post({ text: "你还记得咖啡的事吗" });
		const request = await waitFor(
			() => (fake.requests.length > seen ? fake.requests.at(-1) : undefined),
			20_000,
			"a model request after the MCP tools were attached",
		);
		const names = (request.tools ?? []).map((tool) => tool.function.name);
		expect(names.some((name) => name.includes("recall_memory"))).toBe(true);
		expect(names.some((name) => name.includes("save_memory"))).toBe(true);

		const serverId = (servers[0] as { id: string }).id;
		await mcp.setToolEnabled({ server: serverId, tool: "save_memory", enabled: false });
		const tool = (mcp.servers.value as { tools: { name: string; enabled: boolean }[] }[])[0]?.tools.find(
			(candidate) => candidate.name === "save_memory",
		);
		expect(tool?.enabled).toBe(false);
	}, 60_000);

	it("delivers consecutive messages as separate turns", async () => {
		const agent = await host.get(AgentContract, { agent: AGENT });
		const chat = await host.get(ChatContract, { agent: AGENT });
		const countOut = () => (chat.messages.value as { direction: string }[]).filter((message) => message.direction === "out").length;
		const before = countOut();

		// Sequential calls keep the assertion deterministic; the mid-run queue is
		// covered end to end by `pnpm e2e`, where three turns run back to back.
		await agent.send({ text: "第一句" });
		await agent.send({ text: "第二句" });

		try {
			await waitFor(() => countOut() >= before + 2, 45_000, "two replies for two messages");
		} catch (error) {
			console.error("phase", agent.phase.value, "bubbles", countOut(), "requests", fake.requests.length);
			throw error;
		}
		await waitFor(() => agent.phase.value === "idle", 30_000, "idle after both runs");
		expect(fake.requests.length).toBeGreaterThan(0);
	}, 60_000);
});
