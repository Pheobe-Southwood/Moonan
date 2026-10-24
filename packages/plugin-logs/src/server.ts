import { defineFacet } from "@earendil-works/chord";
import { TranscriptAdmin } from "@moonan_ai/contracts";
import { LogsContract } from "./contract.js";

/** Read-only view over one agent's raw transcript. Live deltas come from AgentContract.live. */
export default defineFacet(
	(api) => {
		api.serve(LogsContract, (input, _principal, self) => {
			const transcript = self.get(TranscriptAdmin, {});
			return {
				variant: "v1" as const,
				page: ({ before, limit }: { before?: number; limit: number }) =>
					transcript.page({ agent: input.agent, before, limit }),
			};
		});
	},
	{ uses: [TranscriptAdmin] },
);
