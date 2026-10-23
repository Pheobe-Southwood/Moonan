import { defineFacet, local, method } from "@earendil-works/chord";
import { Type } from "typebox";
import { LogsContract, Panels, TranscriptAdmin } from "@moonan_ai/contracts";

/** Read-only view over one agent's raw transcript. Live deltas come from AgentContract.live. */
const Root = local("moonan.logs.root", {
	version: 1,
	input: Type.Object({}),
	members: { noop: method() },
});

export default defineFacet((api) => {
	api.serve(
		Root,
		(_input, _principal, self) => {
			self.register(Panels, { logs: { id: "logs", titleKey: "nav.logs", order: 20 } });
			return { noop: () => undefined };
		},
		{ lifetime: "host" },
	);

	api.serve(LogsContract, (input, _principal, self) => {
		const transcript = self.get(TranscriptAdmin, {});
		return {
			variant: "v1" as const,
			page: ({ before, limit }: { before?: number; limit: number }) =>
				transcript.page({ agent: input.agent, before, limit }),
		};
	});
});
