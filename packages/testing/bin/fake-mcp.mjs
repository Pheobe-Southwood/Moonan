#!/usr/bin/env node
/**
 * A tiny MCP server over stdio for tests and demos: newline-delimited JSON-RPC,
 * two tools, no dependencies. Spawn it with `node bin/fake-mcp.mjs`.
 */
import { createInterface } from "node:readline";

const PROTOCOL = "2025-11-25";

const TOOLS = [
	{
		name: "recall_memory",
		title: "回忆",
		description: "检索角色过去记下的事情。",
		inputSchema: {
			type: "object",
			properties: { topic: { type: "string", description: "要回忆的主题" } },
			required: ["topic"],
		},
	},
	{
		name: "save_memory",
		title: "记住",
		description: "把一件事写进角色的长期记忆。",
		inputSchema: {
			type: "object",
			properties: { note: { type: "string", description: "要记住的内容" } },
			required: ["note"],
		},
	},
];

const MEMORY = [
	{ topic: "咖啡", text: "她只喝黑咖啡，不加糖。" },
	{ topic: "雨", text: "下雨天书店不开门，她会坐在窗边看书。" },
	{ topic: "名字", text: "上一个喊她全名的人，已经很久没来了。" },
];

function recall(topic) {
	const needle = String(topic ?? "").toLowerCase();
	const hit = MEMORY.find((entry) => entry.topic.toLowerCase().includes(needle) || needle.includes(entry.topic.toLowerCase()));
	return hit ? hit.text : `没有关于「${topic}」的记忆。`;
}

function handle(method, params) {
	switch (method) {
		case "initialize":
			return {
				protocolVersion: PROTOCOL,
				capabilities: { tools: {} },
				serverInfo: { name: "fake-memory", version: "0.0.1" },
			};
		case "ping":
			return {};
		case "tools/list":
			return { tools: TOOLS };
		case "tools/call": {
			const name = params?.name;
			const args = params?.arguments ?? {};
			if (name === "recall_memory") {
				return { content: [{ type: "text", text: recall(args.topic) }] };
			}
			if (name === "save_memory") {
				MEMORY.push({ topic: String(args.note ?? "").slice(0, 12), text: String(args.note ?? "") });
				return { content: [{ type: "text", text: "记下了。" }] };
			}
			return { content: [{ type: "text", text: `未知工具：${name}` }], isError: true };
		}
		case "resources/list":
			return { resources: [] };
		case "prompts/list":
			return { prompts: [] };
		default:
			throw new Error(`method not found: ${method}`);
	}
}

const lines = createInterface({ input: process.stdin, terminal: false });
lines.on("line", (line) => {
	const text = line.trim();
	if (!text) return;
	let message;
	try {
		message = JSON.parse(text);
	} catch {
		return;
	}
	if (message.id === undefined) return; // notification
	try {
		const result = handle(message.method, message.params);
		process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
	} catch (error) {
		process.stdout.write(
			`${JSON.stringify({
				jsonrpc: "2.0",
				id: message.id,
				error: { code: -32601, message: error instanceof Error ? error.message : String(error) },
			})}\n`,
		);
	}
});
