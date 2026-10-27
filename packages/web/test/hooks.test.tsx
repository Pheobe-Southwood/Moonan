import {
	ChordError,
	local,
	type Host,
	type Readable,
	type Ref,
	type RefStatus,
} from "@earendil-works/chord";
import { Type } from "typebox";
import { useReadable, useRemote } from "@moonan_ai/sdk/web";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePanels } from "../src/chord/panels.js";
import type { PanelContribution } from "@moonan_ai/sdk/web";

afterEach(cleanup);

const Counter = local("test.counter", {
	version: 1,
	input: Type.Object({}),
	members: { value: Type.Number() },
});

function fakeRef(): {
	ref: Ref<typeof Counter>;
	status: (status: RefStatus, error?: unknown) => void;
	release: ReturnType<typeof vi.fn>;
} {
	const listeners = new Set<(status: RefStatus, error: unknown) => void>();
	const release = vi.fn();
	const ref = {
		status: "live",
		error: undefined,
		contract: Counter,
		onStatus: (listener: (status: RefStatus, error: unknown) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		release,
	} as unknown as Ref<typeof Counter>;
	return {
		ref,
		status: (status, error) => {
			for (const listener of listeners) listener(status, error);
		},
		release,
	};
}

function fakeHost(held: Ref<typeof Counter>): Host<unknown> {
	return {
		hold: vi.fn(() => held),
	} as unknown as Host<unknown>;
}

describe("useRemote", () => {
	it("holds in a layout effect and releases on unmount", () => {
		const { ref, release } = fakeRef();
		const host = fakeHost(ref);
		const Probe = () => {
			const held = useRemote(host, Counter, {});
			return <div>{held ? "held" : "none"}</div>;
		};
		const view = render(<Probe />);
		expect(view.getByText("held")).toBeTruthy();
		expect(host.hold).toHaveBeenCalledTimes(1);
		view.unmount();
		expect(release).toHaveBeenCalledTimes(1);
	});

	it("reports a contract mismatch once and does not retry", () => {
		const { ref, status } = fakeRef();
		const host = fakeHost(ref);
		const onFatal = vi.fn();
		const Probe = () => {
			useRemote(host, Counter, {}, { onFatal });
			return null;
		};
		render(<Probe />);
		act(() => status("gone", new ChordError("contract_mismatch", "new contract")));
		expect(onFatal).toHaveBeenCalledTimes(1);
		expect(host.hold).toHaveBeenCalledTimes(1);
	});

	it("warns once when a contract error has no onFatal handler", () => {
		const { ref, status } = fakeRef();
		const host = fakeHost(ref);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const Probe = () => {
			useRemote(host, Counter, {});
			return null;
		};
		render(<Probe />);
		act(() => status("gone", new ChordError("upgrade_required", "stale facet")));
		expect(warn).toHaveBeenCalledTimes(1);
		// A reference reports its terminal state once; a panel must not spam the console.
		act(() => status("gone", new ChordError("upgrade_required", "stale facet")));
		expect(warn).toHaveBeenCalledTimes(1);
		warn.mockRestore();
	});
});

describe("useReadable", () => {
	it("reads the current value and follows updates", () => {
		let value = 1;
		const listeners = new Set<(next: number) => void>();
		const readable: Readable<number> = {
			get value() {
				return value;
			},
			subscribe(listener) {
				listeners.add(listener);
				listener(value);
				return () => listeners.delete(listener);
			},
			events() {
				return () => {};
			},
		};
		const Probe = () => {
			const next = useReadable(readable, 0);
			return <div>{next}</div>;
		};
		const view = render(<Probe />);
		expect(view.getByText("1")).toBeTruthy();
		act(() => {
			value = 2;
			for (const listener of listeners) listener(value);
		});
		expect(view.getByText("2")).toBeTruthy();
		view.unmount();
		expect(listeners.size).toBe(0);
	});
});

describe("usePanels", () => {
	it("sorts by order and keeps registration order for ties", () => {
		const table = new Map<string, PanelContribution>([
			["b", { id: "b", title: "B", order: 20, component: () => null }],
			["a", { id: "a", title: "A", order: 10, component: () => null }],
			["c", { id: "c", title: "C", order: 20, component: () => null }],
		]);
		const view = {
			table: () => table,
			get: (key: string) => table.get(key),
			subscribe: (listener: (next: typeof table) => void) => {
				listener(table);
				return () => {};
			},
		};
		const host = { registry: () => view } as unknown as Host<unknown>;
		const Probe = () => {
			const panels = usePanels(host);
			return <div>{panels.map((panel) => panel.id).join(",")}</div>;
		};
		const rendered = render(<Probe />);
		expect(rendered.getByText("a,b,c")).toBeTruthy();
	});
});
