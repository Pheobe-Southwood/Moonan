import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionProvider } from "../src/chord/connection.js";

/**
 * The platform authenticates a browser link with the session cookie and closes a link whose
 * session ended. A closed link must then be distinguished from a network blip: the provider
 * asks `/api/auth/status`, stops reconnecting when nobody is signed in (and tells the shell),
 * and keeps the backoff when the session is still valid. These tests replace the platform
 * with a fake WebSocket and fetch.
 */
interface FakeListener {
	(event?: unknown): void;
}

class FakeSocket {
	static instances: FakeSocket[] = [];
	readyState = 0;
	readonly url: string;
	private readonly listeners = new Map<string, Set<FakeListener>>();

	constructor(url: string) {
		this.url = url;
		FakeSocket.instances.push(this);
	}

	addEventListener(type: string, listener: FakeListener): void {
		const listeners = this.listeners.get(type) ?? new Set<FakeListener>();
		listeners.add(listener);
		this.listeners.set(type, listeners);
	}

	send(): void {
		// The link buffers frames while the socket is opening; nothing needs a wire here.
	}

	close(): void {
		if (this.readyState > 1) return;
		this.readyState = 3;
		this.dispatch("close");
	}

	/** The server accepted the link. */
	open(): void {
		if (this.readyState !== 0) return;
		this.readyState = 1;
		this.dispatch("open");
	}

	/** The server dropped the link. */
	drop(): void {
		if (this.readyState > 1) return;
		this.readyState = 3;
		this.dispatch("close");
	}

	private dispatch(type: string): void {
		for (const listener of this.listeners.get(type) ?? []) listener({});
	}
}

function json(status: number, body: unknown): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
	} as unknown as Response;
}

function statusBody(authenticated: boolean): Response {
	return json(200, { version: "0.1.0-alpha2", setupRequired: false, authenticated });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	FakeSocket.instances = [];
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
	vi.stubGlobal("WebSocket", FakeSocket);
	// chord reports the link teardown through `onError`; that is expected here.
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function renderProvider(onAuthLost = vi.fn()) {
	const view = render(
		<ConnectionProvider onAuthLost={onAuthLost}>
			<div>shell</div>
		</ConnectionProvider>,
	);
	await waitFor(() => expect(FakeSocket.instances.length).toBe(1));
	return { view, onAuthLost };
}

describe("ConnectionProvider auth loss", () => {
	it("asks for the session when the link drops and stops reconnecting when it is gone", async () => {
		fetchMock.mockResolvedValue(statusBody(false));
		const { view, onAuthLost } = await renderProvider();
		const first = FakeSocket.instances[0]!;
		expect(first.url).toMatch(/^ws:\/\/.+\/ws$/);

		act(() => first.open());
		act(() => first.drop());

		await waitFor(() => expect(onAuthLost).toHaveBeenCalledTimes(1));
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/auth/status",
			expect.objectContaining({ credentials: "same-origin" }),
		);

		// Past the first backoff step: a reconnect would have opened a second socket.
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(FakeSocket.instances.length).toBe(1);
		view.unmount();
	});

	it("keeps reconnecting when the session is still valid", async () => {
		fetchMock.mockResolvedValue(statusBody(true));
		const { onAuthLost } = await renderProvider();
		const first = FakeSocket.instances[0]!;

		act(() => first.open());
		act(() => first.drop());

		// The first backoff step is 400 ms; a live session gets a fresh link.
		await waitFor(() => expect(FakeSocket.instances.length).toBe(2), { timeout: 2000 });
		expect(onAuthLost).not.toHaveBeenCalled();
	});

	it("treats an unreachable status endpoint as a network problem, not a lost session", async () => {
		fetchMock.mockRejectedValue(new TypeError("network down"));
		const { onAuthLost } = await renderProvider();
		const first = FakeSocket.instances[0]!;

		act(() => first.open());
		act(() => first.drop());

		await waitFor(() => expect(FakeSocket.instances.length).toBe(2), { timeout: 2000 });
		expect(onAuthLost).not.toHaveBeenCalled();
	});
});
