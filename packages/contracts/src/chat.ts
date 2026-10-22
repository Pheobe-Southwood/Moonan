import { hostNamed, method, remote } from "@earendil-works/chord";
import { Type } from "typebox";
import { ChatMessageSchema } from "./common.js";

/** The chat window: bubbles on both sides. Opening it does not message the agent. */
export const ChatContract = remote("moonan.chat", {
	version: 1,
	input: Type.Object({ agent: Type.String() }),
	host: hostNamed("moonan"),
	variants: {
		v1: {
			state: {
				messages: Type.Array(ChatMessageSchema),
			},
			methods: {
				/** A message the person typed. Batched for two seconds, then injected as one user message. */
				post: method(Type.Object({ text: Type.String() })),
				page: method(
					Type.Object({ before: Type.Optional(Type.Number()), limit: Type.Number() }),
					Type.Array(ChatMessageSchema),
				),
			},
		},
	},
});
