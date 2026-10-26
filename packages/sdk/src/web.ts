import {
	defineRegistry,
	isChordError,
	type AnyContract,
	type Host,
	type InputOf,
	type Readable,
	type Ref,
	type RefStatus,
} from "@earendil-works/chord";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export type { InputOf, Readable, Ref, RefStatus } from "@earendil-works/chord";
export { isChordError } from "@earendil-works/chord";

/** A `gone` error that no new reference can fix: the page needs the build for the new contract. */
export function isFatalContractError(error: unknown): boolean {
	return isChordError(error, "contract_mismatch") || isChordError(error, "upgrade_required");
}

/** Options of {@link useRemote}. */
export interface UseRemoteOptions {
	/**
	 * Called once when the reference can no longer be recovered: a non-retryable contract
	 * error, or a `gone` reference after the bounded retries. The shell uses this to reload
	 * the page instead of rendering a permanently loading screen.
	 */
	onFatal?: (error: unknown) => void;
}

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

/**
 * Reads a state member, falling back while it has no value yet.
 *
 * `hold` returns before the object is live, and chord reports that as `not_ready` when the
 * member is read — a transition, not a failure. `not_in_variant` is the other expected one:
 * the provider's variant does not carry this member. Anything else is a bug in the read
 * path and is reported rather than hidden behind the fallback.
 */
function readOr<T>(readable: Readable<T> | undefined, fallback: T): T {
	if (!readable) return fallback;
	try {
		return readable.value;
	} catch (error) {
		if (isChordError(error, "not_ready") || isChordError(error, "not_in_variant")) return fallback;
		console.error("[chord] reading state failed", error);
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
export function useRemote<C extends AnyContract>(
	host: Host<unknown> | null | undefined,
	contract: C,
	input: InputOf<C>,
	options: UseRemoteOptions = {},
): Ref<C> | null {
	// The input is a plain JSON address, and a panel commonly passes a fresh `{}` each
	// render. Key on its content so identity churn does not re-acquire the reference.
	const key = JSON.stringify(input);
	const [ref, setRef] = useState<Ref<C> | null>(null);
	const [attempt, setAttempt] = useState(0);
	const retries = useRef(0);
	const fatalReported = useRef(false);
	const onFatal = useRef(options.onFatal);
	onFatal.current = options.onFatal;

	useLayoutEffect(() => {
		if (!host) {
			setRef(null);
			return;
		}
		let held: Ref<C>;
		try {
			held = host.hold(contract, JSON.parse(key) as InputOf<C>);
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
		if (!ref) return;
		return ref.onStatus((status: RefStatus, error: unknown) => {
			// A reconnect re-holds in place (`loading`, last values readable) and needs nothing.
			// `gone` is terminal for this reference — the object was forced away while held —
			// and chord's guidance for a UI is to take a new one. Bounded, so a provider that
			// keeps answering `gone` cannot spin the page.
			if (status === "live") {
				retries.current = 0;
				fatalReported.current = false;
				return;
			}
			if (status !== "gone") return;

			// A contract that the provider no longer covers cannot be fixed by taking another
			// reference: the page needs the build that knows the new contract.
			if (isFatalContractError(error)) {
				if (!fatalReported.current) {
					fatalReported.current = true;
					onFatal.current?.(error);
				}
				return;
			}

			if (retries.current < 3) {
				retries.current += 1;
				setAttempt((value) => value + 1);
				return;
			}
			if (!fatalReported.current) {
				fatalReported.current = true;
				onFatal.current?.(error);
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
export function useRefStatus<C extends AnyContract>(ref: Ref<C> | null): RefStatus | null {
	const [status, setStatus] = useState<RefStatus | null>(() => ref?.status ?? null);

	// Layout effect: the reference is acquired in one, and this is what turns that commit
	// into a painted one. With a passive effect the first paint would still say "loading".
	useLayoutEffect(() => {
		if (!ref) {
			setStatus(null);
			return;
		}
		setStatus(ref.status);
		return ref.onStatus((next: RefStatus) => setStatus(next));
	}, [ref]);

	return status;
}

/** Renders the current value of a chord `Readable`, and every later one. */
export function useReadable<T>(readable: Readable<T> | undefined, fallback: T): T {
	const [value, setValue] = useState<T>(() => readOr(readable, fallback));

	useLayoutEffect(() => {
		if (!readable) {
			setValue(fallback);
			return;
		}
		let cancelled = false;
		setValue(readOr(readable, fallback));
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
