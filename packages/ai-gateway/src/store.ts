import { chmod, copyFile, mkdir, open, readFile, rename, stat, access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Value } from "typebox/value";
import { GatewayConfigSchema, type GatewayConfig, type GatewaySettings } from "./schema.js";
import { cloneJson, errorMessage, nowIso } from "./util.js";

export interface LoadedConfig {
	config: GatewayConfig;
	notice?: string;
	recovered: boolean;
}

export interface SaveResult {
	savedAt: string;
	mode: string;
	bytes: number;
}

export function defaultSettings(): GatewaySettings {
	return {
		discoveryTimeoutMs: 20_000,
		requestDefaults: {
			cacheRetention: "short",
			transport: "auto",
			maxRetries: 2,
			maxRetryDelayMs: 60_000,
			timeoutMs: 600_000,
		},
	};
}

export function emptyConfig(): GatewayConfig {
	const at = nowIso();
	return { version: 1, providers: [], settings: defaultSettings(), createdAt: at, updatedAt: at };
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
	const explicitFile = env.MOONAN_AI_GATEWAY_CONFIG?.trim();
	if (explicitFile) return explicitFile;
	const home = env.MOONAN_AI_GATEWAY_HOME?.trim();
	const directory = home
		? home
		: join(env.MOONAN_HOME?.trim() || join(homedir(), ".moonan"), "ai-gateway");
	return join(directory, "config.json");
}

function schemaError(value: unknown): string {
	const errors = [...Value.Errors(GatewayConfigSchema, value)];
	const first = errors[0];
	if (!first) return "configuration does not match the schema";
	const path = first.instancePath === "" ? "(root)" : first.instancePath;
	return `${path}: ${first.message}`;
}

function isConfig(value: unknown): value is GatewayConfig {
	return Value.Check(GatewayConfigSchema, value);
}

/**
 * The plugin's only persistence. It owns one JSON file in the plugin's own directory.
 *
 * The file contains API keys, so it is created with mode 0600 and rewritten atomically
 * (write a sibling, fsync, rename). Writes are serialized so two concurrent methods cannot
 * interleave a read-modify-write. A corrupt main file falls back to the last backup; if
 * that is unusable too, the corrupt file is preserved and the gateway starts empty.
 */
export class ConfigStore {
	readonly configPath: string;
	readonly backupPath: string;
	readonly directory: string;
	private queue: Promise<unknown> = Promise.resolve();
	private notice: string | undefined;
	private lastSavedAt: string | undefined;
	/** False after a recovery/empty start: preserving the old backup beats copying a bad main over it. */
	private mainHealthy = false;

	constructor(configPath = defaultConfigPath()) {
		this.configPath = configPath;
		this.backupPath = `${configPath}.bak`;
		this.directory = dirname(configPath);
	}

	get currentNotice(): string | undefined {
		return this.notice;
	}

	async load(): Promise<LoadedConfig> {
		const main = await this.readFile(this.configPath);
		if (main.kind === "missing") {
			this.mainHealthy = false;
			const backup = await this.readFile(this.backupPath);
			if (backup.kind === "ok") {
				this.notice = "主配置不存在，已从备份恢复。保存后会重新写入主文件。";
				return { config: backup.value, recovered: true, notice: this.notice };
			}
			this.notice = undefined;
			return { config: emptyConfig(), recovered: false };
		}
		if (main.kind === "ok") {
			this.mainHealthy = true;
			this.notice = undefined;
			this.lastSavedAt = main.value.updatedAt;
			return { config: main.value, recovered: false };
		}
		this.mainHealthy = false;

		// The main file is unreadable or does not fit the schema. Try the backup before
		// sacrificing anything: a half-written file is exactly why the backup exists.
		const backup = await this.readFile(this.backupPath);
		if (backup.kind === "ok") {
			this.notice = `主配置无法读取（${main.error}），已从备份恢复。保存后会重新写入主文件。`;
			return { config: backup.value, recovered: true, notice: this.notice };
		}

		const quarantine = `${this.configPath}.corrupt-${Date.now()}.json`;
		try {
			await rename(this.configPath, quarantine);
			this.notice = `主配置无法读取（${main.error}）。已保留为 ${quarantine}，从空配置开始。`;
		} catch (error) {
			this.notice = `主配置无法读取（${main.error}），且无法备份损坏文件：${errorMessage(error)}。从空配置开始。`;
		}
		return { config: emptyConfig(), recovered: true, ...(this.notice ? { notice: this.notice } : {}) };
	}

	private async readFile(path: string): Promise<
		| { kind: "missing" }
		| { kind: "ok"; value: GatewayConfig }
		| { kind: "bad"; error: string }
	> {
		let text: string;
		try {
			text = await readFile(path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
			return { kind: "bad", error: errorMessage(error) };
		}
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch (error) {
			return { kind: "bad", error: `invalid JSON: ${errorMessage(error)}` };
		}
		if (!isConfig(value)) return { kind: "bad", error: schemaError(value) };
		return { kind: "ok", value: cloneJson(value) };
	}

	/**
	 * Replaces the on-disk file. The caller has already modified the in-memory value and is
	 * waiting for this to succeed before publishing the new state.
	 */
	save(config: GatewayConfig): Promise<SaveResult> {
		const next = cloneJson(config);
		next.updatedAt = nowIso();
		if (!Value.Check(GatewayConfigSchema, next)) {
			throw new Error("refusing to save a configuration that does not match the schema");
		}
		const task = async (): Promise<SaveResult> => {
			await mkdir(this.directory, { recursive: true, mode: 0o700 });
			await chmod(this.directory, 0o700).catch(() => undefined);
			const temporary = join(
				this.directory,
				`.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
			);
			const payload = `${JSON.stringify(next, null, 2)}\n`;
			const handle = await open(temporary, "w", 0o600);
			try {
				await handle.writeFile(payload, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			await chmod(temporary, 0o600).catch(() => undefined);

			// Keep one previous revision. `copyFile` is best-effort: a first save has no
			// previous file, and a backup failure must not destroy a successful save.
			// After a recovery, skip the copy: the main file is known to be bad and the
			// old backup is the only good revision left.
			if (this.mainHealthy) {
				await copyFile(this.configPath, this.backupPath).catch(() => undefined);
				await chmod(this.backupPath, 0o600).catch(() => undefined);
			}
			await rename(temporary, this.configPath);
			await chmod(this.configPath, 0o600).catch(() => undefined);

			// Persist the rename itself. Not every platform allows opening a directory; the
			// rename above is still atomic where it matters.
			try {
				const directoryHandle = await open(this.directory, "r");
				try {
					await directoryHandle.sync();
				} finally {
					await directoryHandle.close();
				}
			} catch {
				/* best-effort */
			}

			this.notice = undefined;
			this.lastSavedAt = next.updatedAt;
			this.mainHealthy = true;
			return { savedAt: next.updatedAt, mode: "0600", bytes: Buffer.byteLength(payload) };
		};

		const result = this.queue.then(task, task);
		this.queue = result.catch(() => undefined);
		return result;
	}

	async writable(): Promise<boolean> {
		try {
			await mkdir(this.directory, { recursive: true, mode: 0o700 });
			await access(this.directory, constants.W_OK);
			return true;
		} catch {
			return false;
		}
	}

	async info(): Promise<{
		exists: boolean;
		mode?: string;
		lastSavedAt?: string;
	}> {
		try {
			const info = await stat(this.configPath);
			return {
				exists: true,
				mode: `0${(info.mode & 0o777).toString(8)}`,
				lastSavedAt: this.lastSavedAt,
			};
		} catch {
			return { exists: false, lastSavedAt: this.lastSavedAt };
		}
	}
}
