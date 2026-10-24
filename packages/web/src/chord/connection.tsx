import { createHost, webSocketLink, type Host } from "@earendil-works/chord";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { browserFacetLoader } from "./facet-loader.js";

export type ConnectionStatus = "connecting" | "open" | "closed" | "error";

export interface ConnectionValue {
	status: ConnectionStatus;
	host: Host<unknown> | null;
	/** Bumped on every successful (re)connect; refs must be re-acquired when it changes. */
	generation: number;
	/** Set when the server refused this client's protocol version. */
	error: string | null;
}

const INITIAL: ConnectionValue = { status: "connecting", host: null, generation: 0, error: null };

const ConnectionContext = createContext<ConnectionValue>(INITIAL);

/** Set just before a mismatch reload, so a still-incompatible shell shows a banner instead of looping. */
const MISMATCH_KEY = "moonan.protocol-mismatch";

function socketUrl(): string {
	const scheme = location.protocol === "https:" ? "wss" : "ws";
	return `${scheme}://${location.host}/ws`;
}

/** Chord's answer to an incompatible client: reload the page and hope the new shell matches. */
function reloadOnce(): boolean {
	const now = Date.now();
	const last = Number(sessionStorage.getItem(MISMATCH_KEY) ?? 0);
	if (now - last < 10_000) return false;
	sessionStorage.setItem(MISMATCH_KEY, String(now));
	location.reload();
	return true;
}

/**
 * Chord links never resume: when one closes, every reference over it is gone.
 * The app therefore throws the client host away and builds a new one per
 * connection, bumping `generation` so hooks re-acquire their refs.
 */
export function ConnectionProvider({ children }: { children: ReactNode }) {
	const [value, setValue] = useState<ConnectionValue>(INITIAL);

	useEffect(() => {
		let disposed = false;
		let socket: WebSocket | null = null;
		let host: Host<unknown> | null = null;
		let retry: ReturnType<typeof setTimeout> | undefined;
		let attempt = 0;
		let generation = 0;
		// A mismatch is terminal for this page: reloading or showing the banner, never reconnecting.
		let mismatched = false;

		const scheduleReconnect = () => {
			const delay = Math.min(5_000, 400 * 2 ** attempt);
			attempt += 1;
			retry = setTimeout(open, delay);
		};

		const open = () => {
			if (disposed) return;
			setValue((current) => ({ ...current, status: "connecting" }));
			const next = new WebSocket(socketUrl());
			socket = next;

			next.addEventListener("open", () => {
				if (disposed || socket !== next) return;
				attempt = 0;
				generation += 1;
				const created = createHost({
					kind: "client",
					self: { id: "browser" },
					loader: browserFacetLoader(generation),
					onError: (error: unknown) => console.error("[chord]", error),
				});
				created.connect(webSocketLink(next), {
					principal: { id: "local" },
					onProtocolMismatch: () => {
						mismatched = true;
						if (reloadOnce()) return;
						setValue({
							status: "error",
							host: null,
							generation,
							error: "protocol_mismatch",
						});
					},
				});
				host = created;
				setValue({ status: "open", host: created, generation, error: null });
			});

			next.addEventListener("close", () => {
				if (disposed || socket !== next) return;
				socket = null;
				const previous = host;
				host = null;
				if (previous) void previous.close().catch(() => undefined);
				setValue((current) =>
					current.status === "error"
						? current
						: { status: "closed", host: null, generation: current.generation, error: null },
				);
				if (!mismatched) scheduleReconnect();
			});

			next.addEventListener("error", () => {
				// `close` follows; keep the console quiet about the expected failure.
			});
		};

		open();

		return () => {
			disposed = true;
			if (retry) clearTimeout(retry);
			socket?.close();
			if (host) void host.close().catch(() => undefined);
		};
	}, []);

	return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>;
}

export function useConnection(): ConnectionValue {
	return useContext(ConnectionContext);
}
