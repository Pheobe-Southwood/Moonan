import { createHost, webSocketLink, type Host } from "@earendil-works/chord";
import type { MoonanPrincipal } from "@moonan_ai/sdk";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { fetchAuthStatus } from "../auth.js";
import { browserFacetLoader } from "./facet-loader.js";
import { reloadOnce } from "./reload.js";

export type ConnectionStatus = "connecting" | "open" | "closed" | "error";

export interface ConnectionValue {
	status: ConnectionStatus;
	host: Host<MoonanPrincipal> | null;
	/** Set when the server refused this client's protocol version. */
	error: string | null;
}

const INITIAL: ConnectionValue = { status: "connecting", host: null, error: null };

const ConnectionContext = createContext<ConnectionValue>(INITIAL);

function socketUrl(): string {
	const scheme = location.protocol === "https:" ? "wss" : "ws";
	return `${scheme}://${location.host}/ws`;
}

export interface ConnectionProviderProps {
	children: ReactNode;
	/**
	 * Called when this link dropped and the platform reports no session behind it. The shell
	 * must stop reconnecting and return to the login page; the cookie is gone or revoked.
	 */
	onAuthLost?: () => void;
}

/**
 * One client host for the life of the page; only the link is rebuilt.
 *
 * Chord does not resume a link, but `host.connect` replaces the link of a host that lost
 * one: every remote binding is re-held over the new link and keeps its last values
 * readable until the new snapshots arrive (`RemoteBinding.detached`), and the browser
 * facets installed in this host — the Panels registry among them — stay installed.
 * Rebuilding the host per reconnect would throw all of that away to gain nothing.
 *
 * The provider mounts only behind the account gate, so a link always belongs to a session.
 */
export function ConnectionProvider({ children, onAuthLost }: ConnectionProviderProps) {
	const [value, setValue] = useState<ConnectionValue>(INITIAL);
	// The gate may re-render with a new callback; the effect below must keep its mount-once
	// semantics (rebuilding the host per render would discard every held reference).
	const onAuthLostRef = useRef(onAuthLost);
	onAuthLostRef.current = onAuthLost;

	useEffect(() => {
		let disposed = false;
		let socket: WebSocket | null = null;
		let retry: ReturnType<typeof setTimeout> | undefined;
		let attempt = 0;
		// A mismatch is terminal for this page: reload or show the banner, never reconnect.
		let mismatched = false;

		const host = createHost<MoonanPrincipal>({
			name: "browser",
			kind: "client",
			// The browser host's own principal. It never names a user and is never sent to the
			// platform: the link is authenticated by the session cookie, and the server stamps the
			// account's principal on it. This host's own requests act as the platform host instead
			// (see `connect.principal`).
			self: { kind: "browser" },
			loader: browserFacetLoader(),
			onError: (error: unknown) => console.error("[chord]", error),
		});

		const scheduleReconnect = () => {
			const delay = Math.min(5_000, 400 * 2 ** attempt);
			attempt += 1;
			retry = setTimeout(() => connect(), delay);
		};

		/**
		 * Decide what a closed link means. A network blip is retried forever; a session the
		 * platform no longer accepts (logout in another tab, password or role change, removed
		 * account) is terminal for this page — the server closed the link on purpose, and
		 * reconnecting would only loop against the same refusal.
		 */
		const reconnectOrLogin = async (): Promise<void> => {
			let authenticated: boolean | undefined;
			try {
				authenticated = (await fetchAuthStatus()).authenticated;
			} catch {
				// The status endpoint is unreachable too: treat it as a network problem and keep
				// the existing backoff. A dead platform is not the same as a lost session.
				authenticated = undefined;
			}
			if (disposed || mismatched) return;
			if (authenticated === false) {
				onAuthLostRef.current?.();
				return;
			}
			scheduleReconnect();
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
				// `connect.principal` is what the parent's own requests act as in this host:
				// the server's own code, not this browser and not an account.
				principal: { kind: "host" },
				onProtocolMismatch: () => {
					mismatched = true;
					if (reloadOnce("protocol mismatch")) return;
					setValue({ status: "error", host: null, error: "protocol_mismatch" });
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
				if (!mismatched) {
					void reconnectOrLogin().catch((error: unknown) => console.error("[chord]", error));
				}
			});

			next.addEventListener("error", () => {
				// `close` follows; keep the console quiet about the expected failure.
			});
		};

		setValue({ status: "connecting", host, error: null });
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
