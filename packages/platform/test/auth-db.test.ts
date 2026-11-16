import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { start } from "../src/index.js";
import { silentLogger } from "../src/logger.js";
import { appFor, cleanup, tempDataDb, tempPluginsFile } from "./support.js";

const dirs: string[] = [];

afterEach(async () => {
	await cleanup();
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A directory holding the account database, so the test can inspect exactly what `start` did. */
async function authDbDir(): Promise<{ dir: string; file: string }> {
	const dir = await mkdtemp(join(tmpdir(), "moonan-auth-db-"));
	dirs.push(dir);
	return { dir, file: join(dir, "auth.db") };
}

/** `start` must fail in the account database before it touches the rest of the platform. */
async function expectAuthDbRefused(file: string): Promise<void> {
	const dataDb = await tempDataDb();
	const pluginsFile = await tempPluginsFile();
	await expect(
		start({
			port: 0,
			hostname: "127.0.0.1",
			authDb: file,
			dataDb,
			pluginsFile,
			official: false,
			logger: silentLogger,
		}),
	).rejects.toThrow(/账户数据库/);
}

function tableNames(file: string): string[] {
	const database = new DatabaseSync(file, { readOnly: true });
	try {
		return database
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
			.all()
			.map((row) => String(row.name));
	} finally {
		database.close();
	}
}

describe("auth database startup", () => {
	it("refuses a database with unrelated tables without modifying or replacing it", async () => {
		const { dir, file } = await authDbDir();
		const foreign = new DatabaseSync(file);
		try {
			foreign.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY, value TEXT)");
			foreign.prepare("INSERT INTO unrelated (value) VALUES (?)").run("keep me");
		} finally {
			foreign.close();
		}
		const before = await readFile(file);

		await expectAuthDbRefused(file);

		// The file is still the foreign database: no Moonan tables, no WAL change, no copy.
		expect(await readFile(file)).toEqual(before);
		expect(await readdir(dir)).toEqual(["auth.db"]);
		expect(tableNames(file)).toEqual(["unrelated"]);
	});

	it("refuses a database with a foreign application id without opening it for writing", async () => {
		const { dir, file } = await authDbDir();
		const foreign = new DatabaseSync(file);
		try {
			foreign.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY)");
			foreign.exec("PRAGMA application_id = 305419896");
		} finally {
			foreign.close();
		}
		const before = await readFile(file);
		const beforeMode = (await stat(file)).mode & 0o777;

		await expectAuthDbRefused(file);

		// The header pre-check is what keeps a mistyped --auth-db from being altered at all.
		expect(await readFile(file)).toEqual(before);
		expect(await readdir(dir)).toEqual(["auth.db"]);
		expect((await stat(file)).mode & 0o777).toBe(beforeMode);
		const check = new DatabaseSync(file, { readOnly: true });
		try {
			expect(check.prepare("PRAGMA application_id").get()).toEqual({
				application_id: 305419896,
			});
			expect(check.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
		} finally {
			check.close();
		}
		expect(tableNames(file)).toEqual(["unrelated"]);
	});

	it("refuses a corrupt non-SQLite account database without quarantining or recreating it", async () => {
		const { dir, file } = await authDbDir();
		const corrupt = "this is not a SQLite database\n";
		await writeFile(file, corrupt, "utf8");

		await expectAuthDbRefused(file);

		// The account database is never quarantined or replaced: unlike plugin data, there is
		// no plausible empty fallback for accounts, so refusing to start is the only safe move.
		expect(await readFile(file, "utf8")).toBe(corrupt);
		expect(await readdir(dir)).toEqual(["auth.db"]);
	});

	it("creates the account database 0600 inside a 0700 directory", async () => {
		const { dir, file } = await authDbDir();
		// Prove the hardening: mkdtemp's directory starts at 0700, so widen it first.
		await chmod(dir, 0o755);

		const app = await appFor([], { authDb: file });
		expect(app.authDb).toBe(file);
		expect((await stat(file)).mode & 0o777).toBe(0o600);
		expect((await stat(dir)).mode & 0o777).toBe(0o700);
	});
});
