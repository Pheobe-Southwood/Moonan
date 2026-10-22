import { useEffect, useRef, useState } from "react";
import { useConnection } from "./connection.js";

/* Chord's generics are painful at the React boundary and we ship no .d.ts for the
 * app, so refs are deliberately untyped here; contracts still type the server. */
type AnyRef = Record<string, any>;

function safeValue<T>(readable: any, fallback: T): T {
	try {
		const value = readable?.value as T | undefined;
		return value === undefined ? fallback : value;
	} catch {
		return fallback;
	}
}

/**
 * Acquires a remote reference and re-acquires it after every reconnect. The
 * reference is released on unmount so the server object can go away.
 */
export function useRemote(contract: any, input: Record<string, unknown>): AnyRef | null {
	const { host, generation } = useConnection();
	const key = JSON.stringify(input);
	const [ref, setRef] = useState<AnyRef | null>(null);

	useEffect(() => {
		if (!host) {
			setRef(null);
			return;
		}
		let cancelled = false;
		let held: AnyRef | null = null;
		host
			.get(contract, JSON.parse(key) as never)
			.then((acquired) => {
				if (cancelled) {
					(acquired as unknown as { release(): void }).release();
					return;
				}
				held = acquired as unknown as AnyRef;
				setRef(held);
			})
			.catch((error: unknown) => {
				console.error("[chord] get failed", error);
			});
		return () => {
			cancelled = true;
			held?.release();
			setRef(null);
		};
	}, [host, generation, contract, key]);

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
