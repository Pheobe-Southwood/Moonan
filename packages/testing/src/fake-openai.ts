import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface FakeChatMessage {
	role: string;
	content?: unknown;
	tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[];
}

export interface FakeChatRequest {
	model?: string;
	messages?: FakeChatMessage[];
	stream?: boolean;
	tools?: { type: string; function: { name: string; description?: string } }[];
}

export interface FakeToolCall {
	name: string;
	arguments: Record<string, unknown>;
}

/** One assistant turn. `stream` order: thinking, text, then tool calls. */
export interface FakeTurn {
	thinking?: string;
	text?: string;
	toolCalls?: FakeToolCall[];
}

export type FakeScript = (request: FakeChatRequest, index: number) => FakeTurn | FakeTurn[];

export interface FakeOpenAIOptions {
	port?: number;
	/** Default: calls `send_message` once, then wraps up after the tool result comes back. */
	script?: FakeScript;
	/** Milliseconds between streamed chunks. */
	chunkDelayMs?: number;
}

export interface FakeOpenAI {
	baseUrl: string;
	port: number;
	requests: FakeChatRequest[];
	close(): Promise<void>;
}

/** True when the model is answering right after a tool ran, not a fresh user turn. */
function lastIsToolResult(request: FakeChatRequest): boolean {
	const messages = request.messages ?? [];
	return messages.length > 0 && messages[messages.length - 1]?.role === "tool";
}

const defaultScript: FakeScript = (request) => {
	if (!lastIsToolResult(request)) {
		return {
			thinking: "对方在等我开口。先给她一句回应，看看她的反应。",
			toolCalls: [
				{
					name: "send_message",
					arguments: { content: "「你来了。」她把杯子推到你面前，没有抬头。" },
				},
			],
		};
	}
	return { text: "回应已经送达，剩下的等她接话。可以收尾了。" };
};

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readBody(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

/**
 * A fake OpenAI-compatible endpoint: enough of `/v1/chat/completions` streaming
 * for pi-ai to run a real turn offline. Tool calls are emitted exactly the way
 * the real API emits them.
 */
export async function startFakeOpenAI(options: FakeOpenAIOptions = {}): Promise<FakeOpenAI> {
	const script = options.script ?? defaultScript;
	const chunkDelay = options.chunkDelayMs ?? 5;
	const requests: FakeChatRequest[] = [];
	let counter = 0;

	const server: Server = createServer((request, response) => {
		handle(request, response).catch((error: unknown) => {
			console.error("[fake-openai]", error);
			if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: { message: String(error) } }));
		});
	});

	const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		if (!request.url?.includes("/chat/completions")) {
			response.writeHead(404, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: { message: "not found" } }));
			return;
		}
		const body = JSON.parse((await readBody(request)) || "{}") as FakeChatRequest;
		requests.push(body);
		const turns = script(body, counter++);
		const list = Array.isArray(turns) ? turns : [turns];

		response.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});

		const id = `chatcmpl-fake-${counter}`;
		const created = Math.floor(Date.now() / 1000);
		const model = body.model ?? "fake-model";
		const send = (delta: unknown, finish: string | null = null): void => {
			const payload = {
				id,
				object: "chat.completion.chunk",
				created,
				model,
				choices: [{ index: 0, delta, finish_reason: finish }],
			};
			response.write(`data: ${JSON.stringify(payload)}\n\n`);
		};

		send({ role: "assistant", content: "" });
		for (const turn of list) {
			if (turn.thinking) {
				for (const piece of chunk(turn.thinking)) {
					send({ reasoning_content: piece });
					await sleep(chunkDelay);
				}
			}
			if (turn.text) {
				for (const piece of chunk(turn.text)) {
					send({ content: piece });
					await sleep(chunkDelay);
				}
			}
			if (turn.toolCalls?.length) {
				let index = 0;
				for (const call of turn.toolCalls) {
					send({
						tool_calls: [
							{
								index,
								id: `call_${counter}_${index}`,
								type: "function",
								function: { name: call.name, arguments: JSON.stringify(call.arguments) },
							},
						],
					});
					index += 1;
					await sleep(chunkDelay);
				}
			}
			if (turn.toolCalls?.length) send({}, "tool_calls");
			else send({}, "stop");
		}
		response.write("data: [DONE]\n\n");
		response.end();
	};

	await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;

	return {
		baseUrl: `http://127.0.0.1:${port}/v1`,
		port,
		requests,
		close: async () => {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

function chunk(text: string): string[] {
	const size = 8;
	const pieces: string[] = [];
	for (let index = 0; index < text.length; index += size) pieces.push(text.slice(index, index + size));
	return pieces.length > 0 ? pieces : [text];
}
