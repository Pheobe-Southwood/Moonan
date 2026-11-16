import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * SQLite setup shared by the two databases Moonan owns.
 *
 * `data.db` holds exportable plugin datasets and `auth.db` holds accounts and sessions.
 * They are separate files on purpose: a corrupt data database is quarantined and replaced
 * with an empty one (existing behavior), which must never silently discard accounts.
 */

let sqliteWarningFilterInstalled = false;

/**
 * Node 22 marks `node:sqlite` experimental and prints an ExperimentalWarning on first import.
 * That would be the first line of every `moonan` start. Keep Node's default printer for
 * every other warning; drop only this known one. Must run before `node:sqlite` is imported.
 */
export function silenceSqliteExperimentalWarning(): void {
	if (sqliteWarningFilterInstalled) return;
	sqliteWarningFilterInstalled = true;
	const listeners = process.listeners("warning");
	process.removeAllListeners("warning");
	process.on("warning", (warning) => {
		if (
			warning.name === "ExperimentalWarning" &&
			warning.message.includes("SQLite is an experimental feature")
		) {
			return;
		}
		for (const listener of listeners) (listener as (warning: Error) => void)(warning);
	});
}

/**
 * The directory is `0700` and the database (and SQLite's WAL sidecars) `0600`: local data
 * stays private to the OS user. SQLite creates `-wal`/`-shm` with 0644 on first write, so
 * this runs after every commit; the `0700` directory is the primary boundary, the file
 * modes are the second layer.
 */
export async function hardenPermissions(path: string): Promise<void> {
	if (path === ":memory:") return;
	const directory = dirname(path);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await chmod(directory, 0o700).catch(() => undefined);
	await chmod(path, 0o600).catch(() => undefined);
	await chmod(`${path}-wal`, 0o600).catch(() => undefined);
	await chmod(`${path}-shm`, 0o600).catch(() => undefined);
}
