import { defineRegistry } from "@earendil-works/chord";
import type { Host, RefStatus } from "@earendil-works/chord";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * What the shell hands to a panel: the browser chord host, and nothing else.
 *
 * Every reference a panel holds comes from here — `useRemote(host, …)`. The shell owns
 * no application state to pass down, which is what keeps it from acquiring opinions.
 */
export interface PanelProps {
	host: Host<unknown>;
}

/** One top-level page a browser facet contributes. */
export interface PanelContribution {
	id: string;
	/** The tab label. Data, not a shell dictionary key: the shell has no dictionary. */
	title: string;
	/** Ascending; ties keep registration order. */
	order?: number;
	component: (props: PanelProps) => ReactNode;
}

/**
 * The browser-side way into the shell's navigation.
 *
 * Chord registries are per host, and a panel component cannot cross the wire, so the
 * registry lives in the browser host and is filled by the plugin's own browser facet.
 * The shell subscribes and renders; it never imports a panel.
 */
export const Panels = defineRegistry<PanelContribution>("moonan.panels", { conflict: "error" });

/* Chord's generics do not survive the React boundary in a form worth writing down, and
 * this package emits no `.d.ts` for the app. References are deliberately loose here; the
 * contract types the provider side, which is where a mistake is expensive. */
type AnyRef = {
	readonly status?: RefStatus;
	readonly onStatus?: (listener: (status: RefStatus, error: unknown) => void) => () => void;
	release(): void;
	readonly [member: string]: any;
};
/** The one host method a UI needs: `hold`, chord's synchronous form for UI runtimes. */
type AnyHost = { hold(contract: any, input: any): AnyRef };

function safeValue<T>(readable: any, fallback: T): T {
	try {
		const value = readable?.value as T | undefined;
		return value === undefined ? fallback : value;
	} catch {
		// `not_ready` until the reference is live and the member has its first snapshot —
		// exactly the state a `hold` reference starts in.
		return fallback;
	}
}

/**
 * Acquires a reference from the browser host with `host.hold`.
 *
 * `hold` is the API chord designates for UI runtimes: synchronous, possibly still
 * `loading`, and re-held by the runtime itself when the link comes back, so a reconnect
 * costs no new reference. It is acquired in a layout effect rather than during render:
 * that keeps the impossible-to-render intermediate commit off the screen, and makes the
 * acquire/release pair symmetrical under StrictMode's mount → unmount → mount (a
 * reference taken during render would leak the discarded one).
 */
export function useRemote(host: unknown, contract: any, input: Record<string, unknown>): AnyRef | null {
	const key = JSON.stringify(input);
	const [ref, setRef] = useState<AnyRef | null>(null);
	const [attempt, setAttempt] = useState(0);
	const retries = useRef(0);

	useLayoutEffect(() => {
		const client = host as AnyHost | null | undefined;
		if (!client) {
			setRef(null);
			return;
		}
		let held: AnyRef;
		try {
			held = client.hold(contract, JSON.parse(key) as never);
		} catch (error) {
			// A type this host cannot place (an unknown name, a local type it does not serve).
			console.error("[chord] hold failed", error);
			setRef(null);
			return;
		}
		setRef(held);
		return () => {
			setRef(null);
			held.release();
		};
	}, [host, contract, key, attempt]);

	useEffect(() => {
		if (!ref?.onStatus) return;
		return ref.onStatus((status) => {
			// A reconnect re-holds in place (`loading`, last values readable) and needs nothing.
			// `gone` is terminal for this reference — the object was forced away while held —
			// and chord's guidance for a UI is to take a new one. Bounded, so a provider that
			// keeps answering `gone` cannot spin the page.
			if (status === "live") {
				retries.current = 0;
			} else if (status === "gone" && retries.current < 3) {
				retries.current += 1;
				setAttempt((value) => value + 1);
			}
		});
	}, [ref]);

	return ref;
}

/**
 * Follows a reference's status: `loading | live | released | gone`.
 *
 * `hold` returns before the object is live, so a panel renders from this instead of
 * guessing. `gone` is the state that needs a new reference — a forced disposal, a host
 * that closed, a contract the provider no longer serves.
 */
export function useRefStatus(ref: AnyRef | null): RefStatus | null {
	const [status, setStatus] = useState<RefStatus | null>(() => ref?.status ?? null);

	// Layout effect: the reference is acquired in one, and this is what turns that commit
	// into a painted one. With a passive effect the first paint would still say "loading".
	useLayoutEffect(() => {
		if (!ref) {
			setStatus(null);
			return;
		}
		setStatus(ref.status ?? null);
		return ref.onStatus?.((next) => setStatus(next));
	}, [ref]);

	return status;
}

/** Renders the current value of a chord `Readable`, and every later one. */
export function useReadable<T>(readable: any, fallback: T): T {
	const [value, setValue] = useState<T>(() => safeValue(readable, fallback));

	useLayoutEffect(() => {
		if (!readable) {
			setValue(fallback);
			return;
		}
		let cancelled = false;
		setValue(safeValue(readable, fallback));
		const stop = readable.subscribe((next: T) => {
			if (!cancelled) setValue(next);
		});
		return () => {
			cancelled = true;
			stop();
		};
	}, [readable]);

	return value;
}
