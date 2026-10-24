import type { Subscribable } from "@earendil-works/chord";

/**
 * The change source the manifest listens to.
 *
 * chord does the fan-out itself: `self.on(name, source, handler)` accepts any
 * `Subscribable` ("an event source (a resource's events, any other `subscribe`)"), runs the
 * handler in the object's own root, keeps the subscription across reloads while the source
 * is the same, and drops it with the object. So this only holds the current value and
 * announces a new one; it does not know how many `Manifest` objects exist, which principal
 * each belongs to, or whether they are still alive.
 *
 * A subscriber is handed the current value first, then each new one — the convention
 * chord's own `Readable` follows. That closes the gap between a factory reading `value` and
 * its listener actually starting, which are not the same instant: an announcement made in
 * between would otherwise be lost until the next one.
 */
export interface Signal<T> extends Subscribable<T> {
	readonly value: T;
	set(value: T): void;
}

export function createSignal<T>(initial: T): Signal<T> {
	let value = initial;
	const listeners = new Set<(value: T) => void>();
	return {
		get value(): T {
			return value;
		},
		set(next: T): void {
			value = next;
			// Copy: a listener may unsubscribe while being called.
			for (const listener of [...listeners]) listener(next);
		},
		subscribe(listener: (value: T) => void): () => void {
			listeners.add(listener);
			listener(value);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}
