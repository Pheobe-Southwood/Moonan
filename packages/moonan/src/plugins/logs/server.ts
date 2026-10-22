import { LogsContract } from "@moonan_ai/contracts";
import { defineServerPlugin } from "@moonan_ai/plugin-sdk";

/** Read-only view over one agent's raw transcript. Live deltas come from AgentContract.live. */
export default defineServerPlugin("logs", ({ chord, logs }) => {
	chord.serve(LogsContract, (input, _principal, _self) => {
		return {
			variant: "v1" as const,
			page: ({ before, limit }: { before?: number; limit: number }) => logs.page(input.agent, { before, limit }),
		};
	});
});
