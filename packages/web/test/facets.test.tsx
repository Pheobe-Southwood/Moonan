import type { FacetSetEntry } from "@moonan_ai/sdk";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { facetUrl } from "../src/chord/facet-loader.js";
import { facetSignature, useFacetBatches, type FacetBatchHost } from "../src/chord/facets.js";

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

/** What the browser host actually loads: the catalog URL canonicalized against the page. */
function abs(url: string): string {
	return new URL(url, location.href).href;
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

describe("facetUrl", () => {
	it("is the absolute module URL chord names the facet by: no query, no hash", () => {
		expect(facetUrl("/facets/a/web.js?chord2-reload=1#x")).toBe(abs("/facets/a/web.js"));
		expect(facetUrl("facets/a/web.js")).toBe(abs("/facets/a/web.js"));
	});
});

describe("facetSignature", () => {
	it("is canonical, hash-sensitive and order-insensitive", () => {
		const a = facet("a", "/facets/a/web.js", "h1");
		const b = facet("b", "/facets/b/web.js", "h1");
		expect(facetSignature([])).toBe("none");
		expect(facetSignature([a, b])).toBe(facetSignature([b, a]));
		expect(facetSignature([a])).not.toBe(facetSignature([facet("a", "/facets/a/web.js", "h2")]));
		expect(facetSignature([a])).toContain(`${abs("/facets/a/web.js")}#h1`);
	});
});

describe("useFacetBatches", () => {
	it("installs the first batch with one awaitable host.load and records the signature", async () => {
		const a = facet("a", "/facets/a/web.js", "h1");
		const { load, reload, ready, result } = setup([a]);

		await waitFor(() => expect(result.current.signature).toContain("h1"));
		// chord's documented startup: install and await the facets' host objects in one call.
		expect(load).toHaveBeenCalledWith([abs("/facets/a/web.js")]);
		expect(load).toHaveBeenCalledTimes(1);
		expect(reload).not.toHaveBeenCalled();
		expect(ready).not.toHaveBeenCalled();
		expect(result.current.failures).toEqual([]);
		expect(result.current.batchFailure).toBeNull();
	});

	it("reloads only the facet whose content hash changed", async () => {
		const a1 = facet("a", "/facets/a/web.js", "h1");
		const b = facet("b", "/facets/b/web.js", "h1");
		const a2 = facet("a", "/facets/a/web.js", "h2");
		const fake = fakeHost();
		const { result, rerender } = renderHook((props: Props) => useFacetBatches(props.host, props.live, props.facets), {
			initialProps: { host: fake.host, live: true, facets: [a1, b] },
		});
		await waitFor(() => expect(result.current.signature).toContain("h1"));

		await act(async () => {
			rerender({ host: fake.host, live: true, facets: [a2, b] });
		});

		await waitFor(() => expect(result.current.signature).toContain("h2"));
		// `reload` lists only the changed facet; b keeps running with its objects and cells.
		expect(fake.reload).toHaveBeenCalledWith([abs("/facets/a/web.js")], {});
		expect(fake.ready).toHaveBeenCalledTimes(1);
	});

	it("passes removed facet names to chord as `remove` and lists nothing to reload", async () => {
		const a = facet("a", "/facets/a/web.js", "h1");
		const b = facet("b", "/facets/b/web.js", "h1");
		const fake = fakeHost();
		const { result, rerender } = renderHook((props: Props) => useFacetBatches(props.host, props.live, props.facets), {
			initialProps: { host: fake.host, live: true, facets: [a, b] },
		});
		await waitFor(() => expect(result.current.signature).toContain("b"));

		await act(async () => {
			rerender({ host: fake.host, live: true, facets: [a] });
		});

		// Only a removal: chord still commits, with an empty facet list plus `remove`.
		expect(fake.reload).toHaveBeenCalledWith([], { remove: [abs("/facets/b/web.js")] });
	});

	it("adds a new facet with reload(added) and leaves the installed ones alone", async () => {
		const a = facet("a", "/facets/a/web.js", "h1");
		const b = facet("b", "/facets/b/web.js", "h1");
		const fake = fakeHost();
		const { result, rerender } = renderHook((props: Props) => useFacetBatches(props.host, props.live, props.facets), {
			initialProps: { host: fake.host, live: true, facets: [a] },
		});
		await waitFor(() => expect(result.current.signature).toContain("a"));

		await act(async () => {
			rerender({ host: fake.host, live: true, facets: [a, b] });
		});

		expect(fake.reload).toHaveBeenCalledWith([abs("/facets/b/web.js")], {});
	});

	it("advances the signature at the commit even when activation fails", async () => {
		const a = facet("a", "/facets/a/web.js", "h1");
		const b = facet("a", "/facets/a/web.js", "h2");
		const fake = fakeHost();
		const { result, rerender } = renderHook((props: Props) => useFacetBatches(props.host, props.live, props.facets), {
			initialProps: { host: fake.host, live: true, facets: [a] },
		});
		await waitFor(() => expect(result.current.signature).toContain("h1"));

		fake.ready.mockRejectedValueOnce(new Error("activation failed"));
		await act(async () => {
			rerender({ host: fake.host, live: true, facets: [b] });
		});

		await waitFor(() => expect(result.current.failures.length).toBe(1));
		// The commit is final; `ready()` failing does not undo it.
		expect(result.current.signature).toContain("h2");
	});

	it("keeps the old signature when the reload is refused before the commit", async () => {
		const h1 = facet("a", "/facets/a/web.js", "h1");
		const h2 = facet("a", "/facets/a/web.js", "h2");
		const fake = fakeHost();
		const { result, rerender } = renderHook((props: Props) => useFacetBatches(props.host, props.live, props.facets), {
			initialProps: { host: fake.host, live: true, facets: [h1] },
		});
		await waitFor(() => expect(result.current.signature).toContain("h1"));

		fake.reload.mockRejectedValueOnce(new Error("contract refused"));
		await act(async () => {
			rerender({ host: fake.host, live: true, facets: [h2] });
		});
		await waitFor(() => expect(result.current.failures.length).toBe(1));
		// chord's prepare is transactional: nothing committed, so the old facets (and ledger) stay.
		expect(result.current.signature).toContain("h1");

		await act(async () => {
			rerender({ host: fake.host, live: true, facets: [facet("a", "/facets/a/web.js", "h2")] });
		});
		await waitFor(() => expect(result.current.signature).toContain("h2"));
	});

	it("records the installed batch and reports a first install failure", async () => {
		const fake = fakeHost();
		fake.load.mockRejectedValueOnce(new Error("activation failed"));
		const { result } = renderHook((props: Props) => useFacetBatches(props.host, props.live, props.facets), {
			initialProps: { host: fake.host, live: true, facets: [facet("a", "/facets/a/web.js", "h1")] },
		});

		await waitFor(() => expect(result.current.batchFailure).toBe("activation failed"));
		// `install` is not rolled back, so the facets are there and must not be installed twice.
		expect(result.current.signature).toContain("h1");
	});

	it("installs into a replaced host instead of trusting the old ledger", async () => {
		const a = facet("a", "/facets/a/web.js", "h1");
		const first = fakeHost();
		const second = fakeHost();
		const { result, rerender } = renderHook((props: Props) => useFacetBatches(props.host, props.live, props.facets), {
			initialProps: { host: first.host, live: true, facets: [a] },
		});
		await waitFor(() => expect(result.current.signature).toContain("h1"));

		await act(async () => {
			// Same catalog, new host: the new host has no facets installed yet.
			rerender({ host: second.host, live: true, facets: [facet("a", "/facets/a/web.js", "h1")] });
		});

		await waitFor(() => expect(second.load).toHaveBeenCalledWith([abs("/facets/a/web.js")]));
		expect(first.load).toHaveBeenCalledTimes(1);
	});

	it("serializes overlapping batches: an in-flight first install is never installed twice", async () => {
		const a = facet("a", "/facets/a/web.js", "h1");
		const b = facet("b", "/facets/b/web.js", "h2");
		const fake = fakeHost();
		let releaseLoad: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			releaseLoad = resolve;
		});
		fake.load.mockImplementationOnce(async () => {
			await gate;
		});
		const { result, rerender } = renderHook((props: Props) => useFacetBatches(props.host, props.live, props.facets), {
			initialProps: { host: fake.host, live: true, facets: [a] },
		});
		await waitFor(() => expect(fake.load).toHaveBeenCalledTimes(1));

		// The catalog changes while the first install is still in flight.
		await act(async () => {
			rerender({ host: fake.host, live: true, facets: [b] });
		});
		releaseLoad();

		await waitFor(() => expect(result.current.signature).toContain("h2"));
		// The second batch waited for the first and took the `reload` path: no duplicate install.
		expect(fake.load).toHaveBeenCalledTimes(1);
		expect(fake.reload).toHaveBeenCalledWith([abs("/facets/b/web.js")], { remove: [abs("/facets/a/web.js")] });
	});

	it("does nothing until the catalog is live", async () => {
		const fake = fakeHost();
		renderHook((props: Props) => useFacetBatches(props.host, props.live, props.facets), {
			initialProps: { host: fake.host, live: false, facets: [facet("a", "/facets/a/web.js", "h1")] },
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(fake.load).not.toHaveBeenCalled();
		expect(fake.reload).not.toHaveBeenCalled();
	});
});
