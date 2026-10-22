import { McpContract, McpServerStateSchema } from "@moonan/contracts";
import { defineServerPlugin } from "@moonan/plugin-sdk";
import { Type } from "typebox";

export default defineServerPlugin("mcp", ({ chord, mcp, log }) => {
	chord.serve(McpContract, (_input, _principal, self) => {
		const servers = self.state("servers", Type.Array(McpServerStateSchema), mcp.list());

		let closed = false;
		const refresh = () => {
			if (closed) return;
			void chord
				.root((ctx) => {
					servers.replace(ctx, mcp.list(), { diff: true });
				})
				.catch((error: unknown) => {
					if (!closed) log.warn("MCP state refresh failed", error);
				});
		};

		const unsubscribe = mcp.subscribe(refresh);
		chord.signal.addEventListener(
			"abort",
			() => {
				closed = true;
				unsubscribe();
			},
			{ once: true },
		);

		return {
			variant: "v1" as const,
			servers,
			addServer: async (input: Parameters<typeof mcp.add>[0]) => {
				const state = await mcp.add(input);
				refresh();
				return state;
			},
			removeServer: ({ id }: { id: string }) => {
				mcp.remove(id);
				refresh();
			},
			setToolEnabled: ({ server, tool, enabled }: { server: string; tool: string; enabled: boolean }) => {
				mcp.setToolEnabled(server, tool, enabled);
				refresh();
			},
			reconnect: async ({ id }: { id: string }) => {
				await mcp.reconnect(id);
				refresh();
			},
		};
	});
});
