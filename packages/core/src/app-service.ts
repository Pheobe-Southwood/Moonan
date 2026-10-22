import type { PluginInfo } from "@moonan/contracts";
import type { Store } from "./storage/store.js";

export interface AppState {
	user: string;
	locale: string;
	version: string;
	plugins: PluginInfo[];
}

/** Small observable state bag for app-wide settings and the loaded plugin list. */
export class AppService {
	private readonly listeners = new Set<(state: AppState) => void>();
	private readonly state: AppState;

	constructor(
		private readonly store: Store,
		version: string,
	) {
		this.state = {
			user: store.getSetting("user") ?? "你",
			locale: store.getSetting("locale") ?? "zh",
			version,
			plugins: [],
		};
	}

	get(): AppState {
		return { ...this.state, plugins: [...this.state.plugins] };
	}

	update(patch: { user?: string; locale?: string }): AppState {
		if (patch.user !== undefined) {
			this.state.user = patch.user;
			this.store.setSetting("user", patch.user);
		}
		if (patch.locale !== undefined) {
			this.state.locale = patch.locale;
			this.store.setSetting("locale", patch.locale);
		}
		this.emit();
		return this.get();
	}

	setPlugins(plugins: PluginInfo[]): void {
		this.state.plugins = plugins;
		this.emit();
	}

	subscribe(listener: (state: AppState) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(): void {
		const snapshot = this.get();
		for (const listener of this.listeners) {
			try {
				listener(snapshot);
			} catch {
				// listeners must never break the app state
			}
		}
	}
}
