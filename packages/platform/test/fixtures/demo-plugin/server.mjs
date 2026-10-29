import {
	Routes,
	Type,
	defineFacet,
	hostNamed,
	local,
	method,
	remote,
} from "@moonan_ai/sdk";

/**
 * The directory-plugin fixture behind the platform's integration tests.
 *
 * It is a fixture, not a demo: a directory plugin with two facets, one remote object and one
 * plain HTTP route. `web.js` declares the same contract a second time and registers a panel,
 * which is what the catalog tests want an entry for.
 *
 * It lives under `packages/platform/` on purpose, so its bare imports (`@moonan_ai/sdk`)
 * resolve from the platform's own `node_modules`, exactly like a real directory plugin.
 * Keep the two files small and free of timers: the reload tests compare `web.js` content
 * hashes across a batch.
 */
const Demo = remote("test.demo", {
	version: 1,
	input: Type.Object({}),
	host: hostNamed("moonan"),
	variants: {
		v1: {
			state: {
				/** Milliseconds since the epoch; the panel formats it in its own zone. */
				at: Type.Number(),
			},
			methods: {
				tick: method(),
			},
		},
	},
});

function stamp(ms = Date.now()) {
	const date = new Date(ms);
	const pad = (n) => String(n).padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** `Routes` contributions must come from an object that lives as long as the facet. */
const Root = local("test.demo.root", {
	version: 1,
	input: Type.Object({}),
	members: {},
});

export default defineFacet((api) => {
	api.serve(Demo, (_input, _principal, self) => {
		const at = self.state("at", Type.Number(), Date.now());
		const tick = (ctx) => at.change(ctx, () => Date.now());
		return { variant: "v1", at, tick };
	});

	api.serve(
		Root,
		(_input, _principal, self) => {
			self.register(Routes, {
				"GET /api/demo": (_request, response) => {
					const now = Date.now();
					const payload = JSON.stringify({ now, label: stamp(now), iso: new Date(now).toISOString() });
					response.writeHead(200, {
						"content-type": "application/json; charset=utf-8",
						"cache-control": "no-store",
					});
					response.end(payload);
				},
			});
			return {};
		},
		{ lifetime: "host" },
	);
});
