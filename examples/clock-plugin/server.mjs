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
 * The clock's contract: one object, two state members, one method.
 *
 * `hostNamed("moonan")` is where the object lives — the platform's host, since that is
 * the only server host there is. `web.js` declares the same contract again; the two
 * copies match by fingerprint (name + version + members), not by module identity.
 */
export const Clock = remote("moonan.clock", {
	version: 1,
	input: Type.Object({}),
	host: hostNamed("moonan"),
	variants: {
		v1: {
			state: {
				/** Milliseconds since the epoch. The panel formats it in the *browser's* zone —
				 * formatting on the server would show the server's zone to the user. */
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

function sleep(ms, signal) {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

/**
 * Registry contributions must come from an object that lives as long as the facet, and
 * only a `lifetime: "host"` object qualifies. This one exists for that alone.
 */
const Root = local("moonan.clock.root", {
	version: 1,
	input: Type.Object({}),
	members: {},
});

export default defineFacet((api) => {
	// The live clock. Default lifetime: it exists while a panel is watching, and its task
	// stops when the last reference is released — no background work nobody asked for.
	api.serve(Clock, (_input, _principal, self) => {
		const at = self.state("at", Type.Number(), Date.now());

		self.task(async (ctx) => {
			while (!ctx.signal.aborted) {
				await sleep(1000, ctx.signal);
				if (ctx.signal.aborted) break;
				const now = Date.now();
				// A state change needs a root, and a task already runs in one.
				at.change(ctx, () => now);
			}
		});

		const tick = (ctx) => at.change(ctx, () => Date.now());

		return { variant: "v1", at, tick };
	});

	// A plain HTTP endpoint, next to the object protocol, on the same port.
	api.serve(
		Root,
		(_input, _principal, self) => {
			self.register(Routes, {
				"GET /api/clock": (_request, response) => {
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
