import { defineRegistry } from "@earendil-works/chord";
import type { Host } from "@earendil-works/chord";
import { useEffect, useState, type ReactNode } from "react";

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
type AnyRef = Record<string, any>;
type AnyHost = { get(contract: any, input: any): Promise<AnyRef> };

function safeValue<T>(readable: any, fallback: T): T {
	try {
		const value = readable?.value as T | undefined;
		return value === undefined ? fallback : value;
	} catch {
		// `not_ready` while the reference is still hydrating.
		return fallback;
	}
}

/**
 * Acquires a remote reference from the browser host.
 *
 * Chord links never resume, so every reconnect builds a new host; `host` is in the
 * dependency list precisely because that is the event that must re-acquire. The
 * reference is released on unmount or when the host is replaced.
 */
export function useRemote(host: unknown, contract: any, input: Record<string, unknown>): AnyRef | null {
	const key = JSON.stringify(input);
	const [ref, setRef] = useState<AnyRef | null>(null);

	useEffect(() => {
		const client = host as AnyHost | null | undefined;
		if (!client) {
			setRef(null);
			return;
		}
		let cancelled = false;
		let held: AnyRef | null = null;
		let settled = false;
		// A `get` that never settles means the object is stuck activating. Say so, rather
		// than leaving the panel silently inert.
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

/** Renders the current value of a chord `Readable`, and every later one. */
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
	}, [readable]);

	return value;
}
