import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { arr, bool, compile, literal, obj, opt, str } from "@moonan_ai/sdk";
import { quarantineFile, writeJsonFileAtomic } from "./data.js";

const REGISTRY_FORMAT = 1;
const MAX_REGISTRY_FILE = 1024 * 1024;

const RegistryDocumentSchema = obj({
	format: literal(REGISTRY_FORMAT),
	updatedAt: opt(str()),
	plugins: arr(obj({ ref: str(), enabled: bool() })),
});
const registryValidator = compile(RegistryDocumentSchema);

/** One persisted plugin entry: the address and whether the platform should load it. */
export interface RegistryEntry {
	ref: string;
	enabled: boolean;
}

interface RegistryDocument {
	format: typeof REGISTRY_FORMAT;
	updatedAt?: string;
	plugins: RegistryEntry[];
}

type ReadResult =
	| { kind: "missing" }
	| { kind: "ok"; entries: RegistryEntry[] }
	| { kind: "bad"; error: string };

/**
 * The engine's plugin selection, kept in its own small JSON file.
 *
 * It is deliberately outside the unified `moonan:data` file:
 *
 * - the platform must know which plugins to load **before** it builds the chord host, while
 *   `moonan:data` is served by a facet inside that host;
 * - importing a data bundle must never be able to enable a different set of plugins.
 *
 * The format is versioned and validated on every read; a broken file is moved aside (never
 * deleted) and the platform starts with the official defaults only.
 */
export class PluginRegistry {
	readonly file: string;
	private list: RegistryEntry[];
	private notice: string | undefined;
	private queue: Promise<unknown> = Promise.resolve();

	private constructor(file: string, entries: RegistryEntry[], notice: string | undefined) {
		this.file = file;
		this.list = entries;
		this.notice = notice;
	}

	static async open(file: string): Promise<PluginRegistry> {
		const main = await readRegistry(file);
		if (main.kind === "ok") return new PluginRegistry(file, main.entries, undefined);

		const backup = await readRegistry(`${file}.bak`);
		if (backup.kind === "ok") {
			return new PluginRegistry(
				file,
				backup.entries,
				main.kind === "missing"
					? "插件注册表不存在，已从备份恢复。下次保存会重新写入主文件。"
					: `插件注册表无法读取（${main.error}），已从备份恢复。下次保存会重新写入主文件。`,
			);
		}
		if (main.kind === "missing") return new PluginRegistry(file, [], undefined);

		const quarantine = await quarantineFile(file);
		return new PluginRegistry(
			file,
			[],
			quarantine === undefined
				? `插件注册表无法读取（${main.error}），且无法保留损坏文件。已从官方默认开始。`
				: `插件注册表无法读取（${main.error}）。已保留为 ${quarantine}，从官方默认开始。`,
		);
	}

	entries(): readonly RegistryEntry[] {
		return this.list.map((entry) => ({ ...entry }));
	}

	/** A recovery/read-back notice worth showing in `/api/v1/plugins`. */
	warning(): string | undefined {
		return this.notice;
	}

	/**
	 * Replaces the whole file. Serialized and atomic; the in-memory list only changes after
	 * the write succeeded, so a failed save leaves the previous selection readable.
	 */
	async replace(entries: readonly RegistryEntry[]): Promise<void> {
		const next = normalize(entries);
		return this.serialize(async () => {
			const document: RegistryDocument = {
				format: REGISTRY_FORMAT,
				updatedAt: new Date().toISOString(),
				plugins: next,
			};
			await writeJsonFileAtomic(this.file, document, { backup: true });
			this.list = next;
			this.notice = undefined;
		});
	}

	async close(): Promise<void> {
		await this.queue.catch(() => undefined);
	}

	private serialize<T>(task: () => Promise<T>): Promise<T> {
		const run = this.queue.then(task, task);
		this.queue = run.catch(() => undefined);
		return run;
	}
}

/** `MOONAN_PLUGINS_FILE`, then `$MOONAN_HOME/plugins.json`, then `~/.moonan/plugins.json`. */
export function defaultPluginsFile(env: NodeJS.ProcessEnv = process.env): string {
	const explicit = env.MOONAN_PLUGINS_FILE?.trim();
	if (explicit) return explicit;
	return join(env.MOONAN_HOME?.trim() || join(homedir(), ".moonan"), "plugins.json");
}

function normalize(entries: readonly RegistryEntry[]): RegistryEntry[] {
	const seen = new Set<string>();
	const list: RegistryEntry[] = [];
	for (const entry of entries) {
		const ref = entry.ref.trim();
		if (ref.length === 0 || seen.has(ref)) continue;
		seen.add(ref);
		list.push({ ref, enabled: entry.enabled === true });
	}
	return list;
}

async function readRegistry(file: string): Promise<ReadResult> {
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
		return { kind: "bad", error: String(error) };
	}
	if (text.length > MAX_REGISTRY_FILE) return { kind: "bad", error: "file is too large" };
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		return { kind: "bad", error: `invalid JSON: ${String(error)}` };
	}
	if (!registryValidator.check(value)) return { kind: "bad", error: "plugin registry does not match the moonan format" };
	const document = value as RegistryDocument;
	return { kind: "ok", entries: normalize(document.plugins) };
}
