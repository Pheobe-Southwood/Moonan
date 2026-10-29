import { Panels, useReadable, useRemote } from "@moonan_ai/sdk/web";
import { Type, defineFacet, hostNamed, local, method, remote } from "@moonan_ai/sdk";
import { createElement as h } from "react";

/**
 * The browser half of the fixture. The server tests never execute this file — they only
 * check that it is served under `/facets/<key>/web.js` and that its content hash is stable
 * across a server-only reload — but it has to be a real facet, contract included.
 *
 * The contract is written twice on purpose: `web.js` cannot import `server.mjs` (it is a
 * separate module graph in another process), and chord matches by fingerprint, not identity.
 */
const Demo = remote("test.demo", {
	version: 1,
	input: Type.Object({}),
	host: hostNamed("moonan"),
	variants: {
		v1: {
			state: {
				at: Type.Number(),
			},
			methods: {
				tick: method(),
			},
		},
	},
});

function DemoPanel({ host }) {
	const demo = useRemote(host, Demo, {});
	const at = useReadable(demo?.at, 0);
	return h("div", { style: { padding: 24 } }, new Date(at).toISOString());
}

/** `Panels` registrations must come from a `lifetime: "host"` object, hence this empty one. */
const Root = local("test.demo.web", {
	version: 1,
	input: Type.Object({}),
	members: { noop: method() },
});

export default defineFacet((api) => {
	api.serve(
		Root,
		(_input, _principal, self) => {
			self.register(Panels, {
				demo: { id: "demo", title: "Demo", order: 10, component: DemoPanel },
			});
			return { noop: () => undefined };
		},
		{ lifetime: "host" },
	);
});
