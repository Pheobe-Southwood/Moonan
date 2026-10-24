import { Panels, useReadable, useRemote } from "@moonan_ai/sdk/web";
import { Type, defineFacet, hostNamed, local, method, remote } from "@moonan_ai/sdk";
import { createElement as h, useState } from "react";

/**
 * The same contract as `server.mjs`, written a second time on purpose.
 *
 * A plugin without a build step cannot share a module between its two halves, and it does
 * not have to: contracts match by fingerprint (name + version + members). This is the
 * documented shape for a plain-JS plugin.
 */
const Clock = remote("moonan.clock", {
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

const S = {
	wrap: { maxWidth: 520, margin: "64px auto", padding: "0 24px", textAlign: "center" },
	time: {
		fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
		fontSize: 64,
		fontVariantNumeric: "tabular-nums",
		letterSpacing: "-0.02em",
		margin: "16px 0 8px",
	},
	hint: { color: "#8b8b99", fontSize: 13, margin: "0 0 20px" },
	row: { display: "flex", gap: 8, justifyContent: "center" },
	button: {
		appearance: "none",
		border: "1px solid #26262e",
		background: "#15151a",
		color: "#e7e7ec",
		font: "inherit",
		padding: "6px 14px",
		borderRadius: 7,
		cursor: "pointer",
	},
};

function ClockPanel({ host }) {
	const clock = useRemote(host, Clock, {});
	const at = useReadable(clock?.at, 0);
	// Formatted here, in the browser's own zone and locale: the server only ever sends an instant.
	const label = at ? new Date(at).toLocaleTimeString(undefined, { hour12: false }) : "--:--:--";
	const [busy, setBusy] = useState(false);

	const tick = async () => {
		if (!clock) return;
		setBusy(true);
		try {
			await clock.tick();
		} finally {
			setBusy(false);
		}
	};

	return h(
		"div",
		{ style: S.wrap },
		h("div", { style: { color: "#8b8b99", fontSize: 13 } }, "这个面板没有一行 AI 代码"),
		h("div", { style: S.time }, label),
		h(
			"p",
			{ style: S.hint },
			clock ? `Chord 状态已同步 · ${new Date(at).toISOString()}` : "等待 Clock 对象…",
		),
		h(
			"div",
			{ style: S.row },
			h(
				"button",
				{ type: "button", style: S.button, onClick: tick, disabled: !clock || busy },
				busy ? "请求中…" : "调用 tick()",
			),
			h(
				"a",
				{ style: { ...S.button, textDecoration: "none" }, href: "/api/clock", target: "_blank", rel: "noreferrer" },
				"GET /api/clock",
			),
		),
	);
}

/** `Panels` registrations must come from a `lifetime: "host"` object, hence this empty one. */
const Root = local("moonan.clock.web", {
	version: 1,
	input: Type.Object({}),
	members: { noop: method() },
});

export default defineFacet((api) => {
	api.serve(
		Root,
		(_input, _principal, self) => {
			self.register(Panels, {
				clock: { id: "clock", title: "时钟", order: 10, component: ClockPanel },
			});
			return { noop: () => undefined };
		},
		{ lifetime: "host" },
	);
});
