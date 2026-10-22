import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import type { Store } from "./store.js";

/**
 * Credentials live in the same plaintext SQLite file as everything else.
 * `modify` is the only write path, so concurrent refreshes cannot interleave.
 */
export class SqliteCredentialStore implements CredentialStore {
	private readonly chains = new Map<string, Promise<unknown>>();

	constructor(private readonly store: Store) {}

	private serialize<T>(providerId: string, task: () => Promise<T>): Promise<T> {
		const previous = this.chains.get(providerId) ?? Promise.resolve();
		const next = previous.then(task, task);
		this.chains.set(
			providerId,
			next.catch(() => undefined),
		);
		return next;
	}

	async read(providerId: string): Promise<Credential | undefined> {
		return this.store.getCredential(providerId);
	}

	async list(): Promise<readonly CredentialInfo[]> {
		return this.store.listCredentialInfos();
	}

	async modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		return this.serialize(providerId, async () => {
			const current = this.store.getCredential(providerId);
			const updated = await fn(current);
			if (updated !== undefined) this.store.putCredential(providerId, updated);
			return updated ?? current;
		});
	}

	async delete(providerId: string): Promise<void> {
		await this.serialize(providerId, async () => {
			this.store.deleteCredential(providerId);
		});
	}
}
