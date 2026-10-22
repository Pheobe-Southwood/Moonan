import { hostNamed, method, remote } from "@earendil-works/chord";
import { Type } from "typebox";
import { TranscriptEntrySchema } from "./common.js";

/**
 * The raw transcript of one agent: full pi-ai messages, paged from the store.
 * Live streaming is read from `AgentContract.live`, not from here.
 */
export const LogsContract = remote("moonan.logs", {
	version: 1,
	input: Type.Object({ agent: Type.String() }),
	host: hostNamed("moonan"),
	variants: {
		v1: {
			state: {},
			methods: {
				page: method(
					Type.Object({ before: Type.Optional(Type.Number()), limit: Type.Number() }),
					Type.Array(TranscriptEntrySchema),
				),
			},
		},
	},
});
