import { chmod, copyFile, mkdir, open, rename } from "node:fs/promises";
import { dirname, extname, join } from "node:path";

/**
 * Atomic JSON file helpers for the platform's engine configuration.
 *
 * The unified plugin data lives in SQLite now (`./data.ts`); this module is what remains for
 * the one JSON file the platform still owns: the plugin registry (`~/.moonan/plugins.json`),
 * which has to be readable before the Chord host exists and must not be changed by a data
 * import. Keeping the helpers here means "one file write implementation" is still a fact the
 * layering test can assert, without making the data store pretend it is a JSON document.
 */

/**
 * Writes a JSON document atomically: a private temporary file, `fsync`, an optional copy of
 * the previous document to `${file}.bak`, then `rename` over the target.
 */
export async function writeJsonFileAtomic(
	file: string,
	value: unknown,
	options: { backup?: boolean } = {},
): Promise<void> {
	const directory = dirname(file);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await chmod(directory, 0o700).catch(() => undefined);
	const temporary = join(
		directory,
		`.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
	);
	const payload = `${JSON.stringify(value, null, 2)}\n`;
	const handle = await open(temporary, "w", 0o600);
	try {
		await handle.writeFile(payload, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	await chmod(temporary, 0o600).catch(() => undefined);
	if (options.backup) {
		await copyFile(file, `${file}.bak`).catch(() => undefined);
		await chmod(`${file}.bak`, 0o600).catch(() => undefined);
	}
	await rename(temporary, file);
	await chmod(file, 0o600).catch(() => undefined);
	try {
		const directoryHandle = await open(directory, "r");
		try {
			await directoryHandle.sync();
		} finally {
			await directoryHandle.close();
		}
	} catch {
		/* best effort on platforms that cannot open a directory */
	}
}

/**
 * Moves a broken file aside instead of deleting it. The plugin registry uses this so a bad
 * edit is still on disk for the user (and the `.bak` recovery stays possible). The suffix
 * replaces the file's own position but keeps its extension, so the original name stays
 * recognizable and only one naming scheme exists for every platform config file.
 */
export async function quarantineFile(file: string): Promise<string | undefined> {
	const target = quarantinePath(file);
	try {
		await rename(file, target);
		return target;
	} catch {
		return undefined;
	}
}

/** The name `quarantineFile` moves a broken file to (`plugins.json` -> `plugins.corrupt-<ts>.json`). */
export function quarantinePath(file: string, at: number = Date.now()): string {
	const extension = extname(file);
	const stem = extension.length > 0 ? file.slice(0, -extension.length) : file;
	return `${stem}.corrupt-${at}${extension}`;
}
