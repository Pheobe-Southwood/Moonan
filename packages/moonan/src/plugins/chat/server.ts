import type { Cell } from "@earendil-works/chord";
import { ChatContract, ChatMessageSchema, type ChatMessage } from "@moonan_ai/contracts";
import { defineServerPlugin, type ServerHost } from "@moonan_ai/plugin-sdk";
import { Type } from "typebox";

const BATCH_WINDOW_MS = 2_000;
const MAIN_AGENT = "main";
const HISTORY_LIMIT = 200;

function formatTime(timestamp: number): string {
	const date = new Date(timestamp);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * The chat window. Owns the two-second batch rule and the `send_message` tool —
 * the only way a character can reach the person.
 */
export default defineServerPlugin("chat", (host: ServerHost) => {
	const cells = new Map<string, Cell<ChatMessage[]>>();

	const appendBubble = (agentId: string, direction: "in" | "out", text: string): ChatMessage => {
		const message = host.chat.append(agentId, direction, text);
		const cell = cells.get(agentId);
		if (cell) {
			void host.chord
				.root((ctx) => {
					cell.change(ctx, (draft) => {
						draft.push(message);
					});
				})
				.catch(() => undefined);
		}
		return message;
	};

	host.agents.registerTool(MAIN_AGENT, {
		name: "send_message",
		label: "向对话窗口发送消息",
		description:
			"以角色的身份向用户发送一条消息，显示在 WebUI 的对话窗口中。这是用户唯一能看到的内容；心理描写不要放进这里，直接输出为文本即可。",
		parameters: Type.Object({
			content: Type.String({ description: "角色对用户说的话，或做的动作，可以同时包含动作描写与台词。" }),
		}),
		execute: async (_toolCallId, params) => {
			const { content } = params as { content: string };
			appendBubble(MAIN_AGENT, "out", content);
			return { content: [{ type: "text" as const, text: "已发送" }], details: undefined };
		},
	});

	host.chord.serve(ChatContract, (input, _principal, self) => {
		const agentId = input.agent;
		const messages = self.state("messages", Type.Array(ChatMessageSchema), host.chat.page(agentId, { limit: HISTORY_LIMIT }));
		cells.set(agentId, messages);

		let timer: ReturnType<typeof setTimeout> | undefined;
		let pending: { text: string; at: number }[] = [];

		const flush = () => {
			timer = undefined;
			const batch = pending;
			pending = [];
			if (batch.length === 0) return;
			if (!host.agents.canSend(agentId)) return;
			const lines = batch.map((message) => `[${formatTime(message.at)}] ${message.text}`).join("\n");
			host.agents.send(agentId, `${host.app.get().user}通过webui给你发送了 ${batch.length} 条消息：\n${lines}`, "steer");
		};

		return {
			variant: "v1" as const,
			messages,
			post: ({ text }: { text: string }) => {
				const message = appendBubble(agentId, "in", text);
				pending.push({ text, at: message.createdAt });
				if (!timer) timer = setTimeout(flush, BATCH_WINDOW_MS);
			},
			page: ({ before, limit }: { before?: number; limit: number }) => host.chat.page(agentId, { before, limit }),
		};
	});
});
