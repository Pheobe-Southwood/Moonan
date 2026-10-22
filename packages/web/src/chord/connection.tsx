import { createHost, webSocketLink, type Host } from "@earendil-works/chord";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type ConnectionStatus = "connecting" | "open" | "closed";

export interface ConnectionValue {
	status: ConnectionStatus;
	host: Host<unknown> | null;
	/** Bumped on every successful (re)connect; refs must be re-acquired when it changes. */
	generation: number;
}

const INITIAL: ConnectionValue = { status: "connecting", host: null, generation: 0 };

const ConnectionContext = createContext<ConnectionValue>(INITIAL);

function socketUrl(): string {
	const scheme = location.protocol === "https:" ? "wss" : "ws";
	return `${scheme}://${location.host}/ws`;
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
				const created = createHost({
					kind: "client",
					self: { id: "browser" },
					onError: (error: unknown) => console.error("[chord]", error),
				});
				created.connect(webSocketLink(next), { principal: { id: "local" } });
				host = created;
				generation += 1;
				setValue({ status: "open", host: created, generation });
			});

			next.addEventListener("close", () => {
				if (disposed || socket !== next) return;
				socket = null;
				const previous = host;
				host = null;
				if (previous) void previous.close().catch(() => undefined);
				setValue((current) => ({ status: "closed", host: null, generation: current.generation }));
				scheduleReconnect();
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
