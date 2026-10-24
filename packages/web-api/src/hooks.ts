import { useEffect, useRef, useState } from "react";

/* Chord's generics are painful at the React boundary and this package ships no .d.ts
 * for the app, so refs are deliberately untyped here; contracts still type the server. */
type AnyRef = Record<string, any>;

/** The browser chord host; a panel receives it as `unknown`, so cast once here. */
type Host = { get(contract: any, input: any): Promise<AnyRef> };

function safeValue<T>(readable: any, fallback: T): T {
	try {
		const value = readable?.value as T | undefined;
		return value === undefined ? fallback : value;
	} catch {
		return fallback;
	}
}

/**
 * Acquires a remote reference from the browser host. The host instance changes on
 * every reconnect (chord links never resume), so `host` in the dependency list is
 * what re-acquires the reference; it is released on unmount or host change.
 */
export function useRemote(host: unknown, contract: any, input: Record<string, unknown>): AnyRef | null {
	const key = JSON.stringify(input);
	const [ref, setRef] = useState<AnyRef | null>(null);

	useEffect(() => {
		const client = host as Host | null | undefined;
		if (!client) {
			setRef(null);
			return;
		}
		let cancelled = false;
		let held: AnyRef | null = null;
		let settled = false;
		// A get that never settles means the object is stuck activating; say so instead
		// of leaving a panel silently inert.
		const slow = setTimeout(() => {
			if (!settled) console.warn(`[chord] get still pending after 10s: ${String(contract?.name ?? contract)}`);
		}, 10_000);
		client
			.get(contract, JSON.parse(key) as never)
			.then((acquired) => {
				settled = true;
				clearTimeout(slow);
				if (cancelled) {
					(acquired as unknown as { release(): void }).release();
					return;
				}
				held = acquired as unknown as AnyRef;
				setRef(held);
			})
			.catch((error: unknown) => {
				settled = true;
				clearTimeout(slow);
				console.error("[chord] get failed", error);
			});
		return () => {
			cancelled = true;
			settled = true;
			clearTimeout(slow);
			held?.release();
			setRef(null);
		};
	}, [host, contract, key]);

	return ref;
}

/** Subscribes to a chord `Readable` and renders its current value. */
export function useReadable<T>(readable: any, fallback: T): T {
	const [value, setValue] = useState<T>(() => safeValue(readable, fallback));

	useEffect(() => {
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
		// `fallback` is a constant at every call site.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [readable]);

	return value;
}

export interface ActionState {
	pending: boolean;
	error: string | null;
}

/** Wraps a chord call with pending/error state for forms. */
export function useAction<A extends unknown[], R>(
	fn: (...args: A) => Promise<R> | R,
): ActionState & { run: (...args: A) => Promise<R | undefined>; clear: () => void } {
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const mounted = useRef(true);

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	const run = async (...args: A): Promise<R | undefined> => {
		setPending(true);
		setError(null);
		try {
			return await fn(...args);
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			if (mounted.current) setError(message);
			return undefined;
		} finally {
			if (mounted.current) setPending(false);
		}
	};

	return { run, pending, error, clear: () => setError(null) };
}
