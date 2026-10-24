import { defineFacet, local, method } from "@earendil-works/chord";
import { Panels } from "@moonan_ai/web-api";
import { Type } from "typebox";
import { McpTab } from "./ui.js";

/**
 * The browser half of the plugin. It owns no data: it registers the panel into the
 * shell's own `Panels` registry, which is a chord registry on the browser host and
 * never crosses to the server. Registrations must come from a `lifetime: "host"` object.
 */
const Root = local("moonan.mcp.web", {
	version: 1,
	input: Type.Object({}),
	members: { noop: method() },
});

export default defineFacet((api) => {
	api.serve(
		Root,
		(_input, _principal, self) => {
			self.register(Panels, {
				mcp: { id: "mcp", title: { zh: "MCP", en: "MCP" }, order: 50, component: McpTab },
			});
			return { noop: () => undefined };
		},
		{ lifetime: "host" },
	);
});
