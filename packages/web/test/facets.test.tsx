import type { FacetSetEntry } from "@moonan_ai/sdk";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFacetBatches, type FacetBatchHost } from "../src/chord/facets.js";

// The hook deliberately reports a failed batch with console.error; the tests assert the state.
const originalError = console.error;
beforeEach(() => {
	console.error = vi.fn();
});
afterEach(() => {
	console.error = originalError;
});

interface Props {
	host: FacetBatchHost;
	live: boolean;
	facets: FacetSetEntry[];
}

function facet(name: string, url: string, hash: string): FacetSetEntry {
	return { name, version: "1", source: "directory", web: { url, hash } };
}

function fakeHost() {
	const load = vi.fn(async (_urls: readonly string[], _options?: { awaitHostObjects?: boolean }) => undefined);
	const reload = vi.fn(async (_urls: readonly string[], _options?: { remove?: readonly string[] }) => ({}));
	const ready = vi.fn(async () => undefined);
	const host = { load, reload, ready } as unknown as FacetBatchHost;
	return { host, load, reload, ready };
}

function setup(initial: FacetSetEntry[]) {
	const fake = fakeHost();
	const rendered = renderHook((props: Props) => useFacetBatches(props.host, props.live, props.facets), {
		initialProps: { host: fake.host, live: true, facets: initial },
	});
	return { ...fake, ...rendered };
}

describe("useFacetBatches", () => {
	it("installs once, defers host-object readiness, and records the signature", async () => {
		const a = facet("a", "/facets/a/web.js", "h1");
		const { load, ready, result } = setup([a]);

		await waitFor(() => expect(result.current.signature).toBe("/facets/a/web.js#h1"));
		expect(load).toHaveBeenCalledWith(["/facets/a/web.js"], { awaitHostObjects: false });
		expect(ready).toHaveBeenCalledTimes(1);
		expect(result.current.failures).toEqual([]);
		expect(result.current.batchFailure).toBeNull();
	});

	it("advances the signature at the commit even when activation fails", async () => {
		const a = facet("a", "/facets/a/web.js", "h1");
		const b = facet("a", "/facets/a/web.js", "h2");
		const fake = fakeHost();
		const { result, rerender } = renderHook((props: Props) => useFacetBatches(props.host, props.live, props.facets), {
			initialProps: { host: fake.host, live: true, facets: [a] },
		});
		await waitFor(() => expect(result.current.signature).toBe("/facets/a/web.js#h1"));

		fake.reload.mockResolvedValueOnce({});
		fake.ready.mockRejectedValueOnce(new Error("activation failed"));
		await act(async () => {
			rerender({ host: fake.host, live: true, facets: [b] });
		});

		await waitFor(() => expect(result.current.failures.length).toBe(1));
		// The commit is final; `ready()` failing does not undo it.
		expect(result.current.signature).toBe("/facets/a/web.js#h2");
	});

	it("keeps the old signature when the reload is refused before the commit, and retries on the next publish", async () => {
		const h1 = facet("a", "/facets/a/web.js", "h1");
		const h2 = facet("a", "/facets/a/web.js", "h2");
		const fake = fakeHost();
		const { result, rerender } = renderHook((props: Props) => useFacetBatches(props.host, props.live, props.facets), {
			initialProps: { host: fake.host, live: true, facets: [h1] },
		});
		await waitFor(() => expect(result.current.signature).toBe("/facets/a/web.js#h1"));

		fake.reload.mockRejectedValueOnce(new Error("contract refused"));
		await act(async () => {
			rerender({ host: fake.host, live: true, facets: [h2] });
		});
		await waitFor(() => expect(result.current.failures.length).toBe(1));
		// chord's prepare is transactional: nothing committed, so the old facets (and ledger) stay.
		expect(result.current.signature).toBe("/facets/a/web.js#h1");

		fake.reload.mockResolvedValueOnce({});
		await act(async () => {
			rerender({ host: fake.host, live: true, facets: [facet("a", "/facets/a/web.js", "h2")] });
		});
		await waitFor(() => expect(result.current.signature).toBe("/facets/a/web.js#h2"));
	});

	it("passes removed facet URLs to chord", async () => {
		const a = facet("a", "/facets/a/web.js", "h1");
		const b = facet("b", "/facets/b/web.js", "h1");
		const fake = fakeHost();
		const { result, rerender } = renderHook((props: Props) => useFacetBatches(props.host, props.live, props.facets), {
			initialProps: { host: fake.host, live: true, facets: [a, b] },
		});
		await waitFor(() => expect(result.current.signature).toContain("/facets/a/web.js#h1"));

		fake.reload.mockResolvedValueOnce({});
		await act(async () => {
			rerender({ host: fake.host, live: true, facets: [a] });
		});

		expect(fake.reload).toHaveBeenCalledWith(["/facets/a/web.js"], { remove: ["/facets/b/web.js"] });
	});

	it("reports a first install failure and leaves the shell without a signature", async () => {
		const fake = fakeHost();
		fake.load.mockRejectedValueOnce(new Error("import failed"));
		const { result } = renderHook((props: Props) => useFacetBatches(props.host, props.live, props.facets), {
			initialProps: { host: fake.host, live: true, facets: [facet("a", "/facets/a/web.js", "h1")] },
		});

		await waitFor(() => expect(result.current.batchFailure).toBe("import failed"));
		expect(result.current.signature).toBe("");
	});

	it("installs into a replaced host instead of trusting the old ledger", async () => {
		const a = facet("a", "/facets/a/web.js", "h1");
		const first = fakeHost();
		const second = fakeHost();
		const { result, rerender } = renderHook((props: Props) => useFacetBatches(props.host, props.live, props.facets), {
			initialProps: { host: first.host, live: true, facets: [a] },
		});
		await waitFor(() => expect(result.current.signature).toBe("/facets/a/web.js#h1"));

		await act(async () => {
			// Same manifest, new host: the new host has no facets installed yet.
			rerender({ host: second.host, live: true, facets: [facet("a", "/facets/a/web.js", "h1")] });
		});

		await waitFor(() => expect(second.load).toHaveBeenCalledWith(["/facets/a/web.js"], { awaitHostObjects: false }));
		expect(first.load).toHaveBeenCalledTimes(1);
	});

	it("does nothing until the manifest is live", async () => {
		const fake = fakeHost();
		renderHook((props: Props) => useFacetBatches(props.host, props.live, props.facets), {
			initialProps: { host: fake.host, live: false, facets: [facet("a", "/facets/a/web.js", "h1")] },
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(fake.load).not.toHaveBeenCalled();
		expect(fake.reload).not.toHaveBeenCalled();
	});
});
