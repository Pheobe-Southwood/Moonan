import { createHost, webSocketLink, type Host } from "@earendil-works/chord";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { browserFacetLoader } from "./facet-loader.js";

export type ConnectionStatus = "connecting" | "open" | "closed" | "error";

export interface ConnectionValue {
	status: ConnectionStatus;
	host: Host<unknown> | null;
	/** Bumped only when the host itself is replaced; references are re-acquired on that change alone. */
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
 * One client host for the life of the page; only the link is rebuilt.
 *
 * Chord does not resume a link, but `host.connect` replaces the link of a host that lost
 * one: every remote binding is re-held over the new link and keeps its last values
 * readable until the new snapshots arrive (`RemoteBinding.detached`), and the browser
 * facets installed in this host — the Panels registry among them — stay installed.
 * Rebuilding the host per reconnect would throw all of that away to gain nothing.
 */
export function ConnectionProvider({ children }: { children: ReactNode }) {
	const [value, setValue] = useState<ConnectionValue>(INITIAL);

	useEffect(() => {
		let disposed = false;
		let socket: WebSocket | null = null;
		let retry: ReturnType<typeof setTimeout> | undefined;
		let attempt = 0;
		// A mismatch is terminal for this page: reload or show the banner, never reconnect.
		let mismatched = false;

		const host = createHost({
			kind: "client",
			self: { id: "browser" },
			loader: browserFacetLoader(),
			onError: (error: unknown) => console.error("[chord]", error),
		});

		const scheduleReconnect = () => {
			const delay = Math.min(5_000, 400 * 2 ** attempt);
			attempt += 1;
			retry = setTimeout(() => connect(), delay);
		};

		const connect = () => {
			if (disposed || mismatched) return;
			setValue((current) => (current.status === "error" ? current : { ...current, status: "connecting" }));

			const next = new WebSocket(socketUrl());
			socket = next;

			// The link is created before the socket opens on purpose. The server sends `hello`
			// from its connection's constructor, as soon as it accepts, so whether a listener
			// attached later still sees it is a race in the runtime's event loop, not a
			// guarantee. A client without that hello never learns `acks: true`, so it never sends
			// an acknowledgement and the server stops draining this link's flow-control window:
			// state stops arriving, with no error to show for it. Creating the link first is the
			// safe order and costs nothing: `webSocketLink` buffers outgoing frames until open,
			// and no frame can arrive before the link it arrives on exists.
			host.connect(webSocketLink(next), {
				principal: { id: "browser" },
				onProtocolMismatch: () => {
					mismatched = true;
					if (reloadOnce()) return;
					setValue({ status: "error", host: null, generation: 0, error: "protocol_mismatch" });
					void host.close().catch(() => undefined);
				},
			});

			next.addEventListener("open", () => {
				if (disposed || socket !== next) return;
				attempt = 0;
				setValue((current) => (current.status === "error" ? current : { ...current, status: "open", error: null }));
			});

			next.addEventListener("close", () => {
				if (disposed || socket !== next) return;
				socket = null;
				setValue((current) => (current.status === "error" ? current : { ...current, status: "closed" }));
				if (!mismatched) scheduleReconnect();
			});

			next.addEventListener("error", () => {
				// `close` follows; keep the console quiet about the expected failure.
			});
		};

		setValue({ status: "connecting", host, generation: 1, error: null });
		connect();

		return () => {
			disposed = true;
			if (retry) clearTimeout(retry);
			socket?.close();
			void host.close().catch(() => undefined);
		};
	}, []);

	return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>;
}

export function useConnection(): ConnectionValue {
	return useContext(ConnectionContext);
}
