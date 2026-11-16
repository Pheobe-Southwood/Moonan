import {
	createHash,
	randomBytes,
	randomUUID,
	scrypt as scryptCallback,
	timingSafeEqual,
} from "node:crypto";
import { open as openFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { applySqliteMigrations, type SqliteMigration } from "@earendil-works/chord/sqlite";
import type { NodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import type { MoonanRole, UserAdminUser, UserPrincipal } from "@moonan_ai/sdk";
import { hardenPermissions, silenceSqliteExperimentalWarning } from "./sqlite-support.js";

/**
 * The account database.
 *
 * It is a separate SQLite file from `data.db` on purpose: a corrupt data database is
 * quarantined and replaced with an empty one, which must never silently discard accounts.
 * It is also intentionally not part of the plugin data export: an exported bundle must not
 * carry password hashes or sessions.
 *
 * There is no self-registration. The first start has zero users, the browser creates the
 * first administrator through `POST /api/auth/setup`, and every later account is created by
 * an administrator.
 */

const AUTH_SCHEMA_VERSION = 1;
/** ASCII "MOOA"; tells a SQLite file what wrote it. */
const AUTH_APPLICATION_ID = 0x4d4f4f41;
const SCHEMA_TABLE = "moonan_auth_schema";
const USER_TABLE = "moonan_users";
const SESSION_TABLE = "moonan_sessions";

/** The browser cookie. HttpOnly + SameSite=Lax; not Secure because the app is served over local HTTP. */
export const AUTH_COOKIE_NAME = "moonan_session";
/** 30 days. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const SCRYPT = { N: 16_384, r: 8, p: 1, keylen: 64, saltBytes: 16 } as const;
const SCRYPT_MAX_MEM = 128 * 1024 * 1024;

const MIGRATIONS: readonly SqliteMigration[] = [
	{
		version: 1,
		statements: [
			`CREATE TABLE ${USER_TABLE} (
				id TEXT PRIMARY KEY,
				username TEXT NOT NULL COLLATE NOCASE UNIQUE,
				role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
				password_hash TEXT NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			) STRICT`,
			`CREATE TABLE ${SESSION_TABLE} (
				id TEXT PRIMARY KEY,
				token_hash TEXT NOT NULL UNIQUE,
				user_id TEXT NOT NULL REFERENCES ${USER_TABLE}(id) ON DELETE CASCADE,
				created_at TEXT NOT NULL,
				expires_at TEXT NOT NULL
			) STRICT`,
			`CREATE INDEX ${SESSION_TABLE}_user ON ${SESSION_TABLE}(user_id)`,
			`CREATE INDEX ${SESSION_TABLE}_expiry ON ${SESSION_TABLE}(expires_at)`,
		],
	},
];

export type AuthErrorCode =
	| "invalid_body"
	| "invalid_credentials"
	| "username_taken"
	| "unknown_user"
	| "last_admin"
	| "setup_complete"
	| "unauthorized"
	| "admin_required"
	| "auth_db_invalid";

/** A refused or failed account operation. The HTTP layer maps `status` and keeps `code`. */
export class AuthError extends Error {
	constructor(
		readonly code: AuthErrorCode,
		message: string,
		readonly status = 400,
		readonly retryAfterSeconds?: number,
	) {
		super(message);
		this.name = "AuthError";
	}
}

interface UserRow {
	id: string;
	username: string;
	role: MoonanRole;
	password_hash: string;
	created_at: string;
	updated_at: string;
}

interface SessionRow {
	session_id: string;
	expires_at: string;
	user_id: string;
	username: string;
	role: MoonanRole;
	created_at: string;
	updated_at: string;
}

function nowIso(): string {
	return new Date().toISOString();
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isUniqueViolation(error: unknown): boolean {
	const message = errorMessage(error);
	return /UNIQUE constraint failed|constraint failed: UNIQUE/i.test(message);
}

function publicUser(row: UserRow | SessionRow): UserAdminUser {
	if ("session_id" in row) {
		return {
			id: row.user_id,
			username: row.username,
			role: row.role,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		};
	}
	return {
		id: row.id,
		username: row.username,
		role: row.role,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export function normalizeUsername(value: unknown): string {
	if (typeof value !== "string") throw new AuthError("invalid_body", "用户名必须是字符串", 400);
	const username = value.trim();
	if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(username)) {
		throw new AuthError(
			"invalid_body",
			"用户名需为 1–64 个字符，只能包含字母、数字、点、下划线和短横线，并以字母或数字开头",
			400,
		);
	}
	return username;
}

export function normalizePassword(value: unknown): string {
	if (typeof value !== "string") throw new AuthError("invalid_body", "密码必须是字符串", 400);
	if (value.length < 8 || value.length > 200) {
		throw new AuthError("invalid_body", "密码长度需为 8–200 个字符", 400);
	}
	return value;
}

export function normalizeRole(value: unknown): MoonanRole {
	if (value !== "admin" && value !== "user") {
		throw new AuthError("invalid_body", '角色必须是 "admin" 或 "user"', 400);
	}
	return value;
}

function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

function deriveKey(password: string, salt: Buffer, keylen: number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		scryptCallback(
			password,
			salt,
			keylen,
			{ N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT_MAX_MEM },
			(error, key) => {
				if (error) reject(error);
				else resolve(key as Buffer);
			},
		);
	});
}

/** Encode a password hash. The format carries its scrypt parameters so a future bump can verify old rows. */
export async function hashPassword(password: string): Promise<string> {
	const salt = randomBytes(SCRYPT.saltBytes);
	const key = await deriveKey(password, salt, SCRYPT.keylen);
	return [
		"scrypt",
		SCRYPT.N,
		SCRYPT.r,
		SCRYPT.p,
		salt.toString("base64"),
		key.toString("base64"),
	].join("$");
}

export async function verifyPassword(encoded: string, password: string): Promise<boolean> {
	const parts = encoded.split("$");
	if (parts.length !== 6 || parts[0] !== "scrypt") return false;
	const N = Number(parts[1]);
	const r = Number(parts[2]);
	const p = Number(parts[3]);
	const saltText = parts[4];
	const hashText = parts[5];
	if (!Number.isInteger(N) || N < 1024 || N > 1_048_576 || (N & (N - 1)) !== 0) return false;
	if (!Number.isInteger(r) || r < 1 || r > 32) return false;
	if (!Number.isInteger(p) || p < 1 || p > 16) return false;
	let salt: Buffer;
	let expected: Buffer;
	try {
		salt = Buffer.from(saltText ?? "", "base64");
		expected = Buffer.from(hashText ?? "", "base64");
	} catch {
		return false;
	}
	if (salt.length < 8 || expected.length < 16 || expected.length > 128) return false;
	const actual = await new Promise<Buffer>((resolve, reject) => {
		scryptCallback(
			password,
			salt,
			expected.length,
			{ N, r, p, maxmem: SCRYPT_MAX_MEM },
			(error, key) => {
				if (error) reject(error);
				else resolve(key as Buffer);
			},
		);
	});
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

let dummyHashPromise: Promise<string> | undefined;
/** Equalize the cost of an unknown username and a wrong password. */
async function verifyAgainstDummy(password: string): Promise<void> {
	dummyHashPromise ??= hashPassword(randomBytes(16).toString("hex"));
	await verifyPassword(await dummyHashPromise, password);
}

/**
 * Refuse a non-Moonan database before Chord opens it.
 *
 * Opening runs `PRAGMA journal_mode = WAL`, which would modify somebody else's file even
 * though the open is then refused. Inspect a non-WAL header through a read-only connection
 * first; a WAL database cannot have its journal mode changed by the open, so it goes to the
 * post-open identity check.
 */
async function assertNotForeignAuthDatabase(
	path: string,
	databaseClass: new (path: string, options: { readOnly: boolean }) => DatabaseSync,
): Promise<void> {
	if (path === ":memory:") return;
	let size: number;
	try {
		size = (await stat(path)).size;
	} catch {
		return;
	}
	if (size < 100) return;
	let handle;
	try {
		handle = await openFile(path, "r");
	} catch {
		return;
	}
	let header: Buffer;
	try {
		header = Buffer.alloc(100);
		const { bytesRead } = await handle.read(header, 0, 100, 0);
		if (bytesRead < 100) return;
	} finally {
		await handle.close();
	}
	if (header.toString("latin1", 0, 16) !== "SQLite format 3\u0000") return;
	const applicationId = header.readUInt32BE(68);
	if (applicationId !== 0 && applicationId !== AUTH_APPLICATION_ID) {
		throw new AuthError("auth_db_invalid", `账户数据库 ${path} 不是 Moonan 账户库`, 500);
	}
	if (header.readUInt8(18) === 2 || header.readUInt8(19) === 2) return;
	let probe: DatabaseSync;
	try {
		probe = new databaseClass(path, { readOnly: true });
	} catch {
		return;
	}
	try {
		let tables: { name: string }[];
		try {
			tables = probe
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
				.all() as { name: string }[];
		} catch {
			return;
		}
		if (tables.length > 0 && !tables.some((row) => row.name === SCHEMA_TABLE)) {
			throw new AuthError("auth_db_invalid", `账户数据库 ${path} 不是 Moonan 账户库`, 500);
		}
	} finally {
		probe.close();
	}
}

async function assertAuthDatabase(database: NodeSqliteDatabase, path: string): Promise<void> {
	const applicationId = (await database.get<{ application_id: number }>("PRAGMA application_id"))
		?.application_id ?? 0;
	if (applicationId !== 0 && applicationId !== AUTH_APPLICATION_ID) {
		throw new AuthError("auth_db_invalid", `账户数据库 ${path} 不是 Moonan 账户库`, 500);
	}
	const tables = await database.all<{ name: string }>(
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
	);
	if (tables.length > 0 && !tables.some((row) => row.name === SCHEMA_TABLE)) {
		throw new AuthError("auth_db_invalid", `账户数据库 ${path} 不是 Moonan 账户库`, 500);
	}
	if (applicationId === 0) {
		await database.exec(`PRAGMA application_id = ${AUTH_APPLICATION_ID}`);
	}
}

export class AuthStore {
	readonly path: string;

	private database!: NodeSqliteDatabase;

	private constructor(path: string) {
		this.path = path;
	}

	static async open(path: string): Promise<AuthStore> {
		const store = new AuthStore(path);
		await store.connect();
		return store;
	}

	async close(): Promise<void> {
		await this.database.close();
	}

	async hasUsers(): Promise<boolean> {
		const row = await this.database.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${USER_TABLE}`);
		return (row?.count ?? 0) > 0;
	}

	async countUsers(): Promise<number> {
		const row = await this.database.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${USER_TABLE}`);
		return row?.count ?? 0;
	}

	async listUsers(): Promise<UserAdminUser[]> {
		const rows = await this.database.all<UserRow>(
			`SELECT id, username, role, password_hash, created_at, updated_at FROM ${USER_TABLE} ORDER BY username COLLATE NOCASE`,
		);
		return rows.map(publicUser);
	}

	async getUser(id: string): Promise<UserAdminUser | undefined> {
		const row = await this.database.get<UserRow>(
			`SELECT id, username, role, password_hash, created_at, updated_at FROM ${USER_TABLE} WHERE id = ?`,
			id,
		);
		return row === undefined ? undefined : publicUser(row);
	}

	/** Create the first account. The transaction re-checks emptiness so two setup requests cannot both win. */
	async createFirstAdmin(input: { username: unknown; password: unknown }): Promise<UserAdminUser> {
		const username = normalizeUsername(input.username);
		const password = normalizePassword(input.password);
		const passwordHash = await hashPassword(password);
		const id = randomUUID();
		const at = nowIso();
		try {
			await this.database.transaction(async (transaction) => {
				const row = await transaction.get<{ count: number }>(
					`SELECT COUNT(*) AS count FROM ${USER_TABLE}`,
				);
				if ((row?.count ?? 0) > 0) {
					throw new AuthError("setup_complete", "管理员已经创建，请直接登录", 409);
				}
				await transaction.run(
					`INSERT INTO ${USER_TABLE} (id, username, role, password_hash, created_at, updated_at)
					 VALUES (?, ?, 'admin', ?, ?, ?)`,
					id,
					username,
					passwordHash,
					at,
					at,
				);
			});
		} catch (error) {
			if (error instanceof AuthError) throw error;
			if (isUniqueViolation(error)) {
				throw new AuthError("username_taken", `用户名 "${username}" 已被占用`, 409);
			}
			throw error;
		}
		await this.harden();
		return {
			id,
			username,
			role: "admin",
			createdAt: at,
			updatedAt: at,
		};
	}

	async createUser(input: {
		username: unknown;
		password: unknown;
		role?: unknown;
	}): Promise<UserAdminUser> {
		const username = normalizeUsername(input.username);
		const password = normalizePassword(input.password);
		const role = input.role === undefined ? "user" : normalizeRole(input.role);
		const passwordHash = await hashPassword(password);
		const id = randomUUID();
		const at = nowIso();
		try {
			await this.database.run(
				`INSERT INTO ${USER_TABLE} (id, username, role, password_hash, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
				id,
				username,
				role,
				passwordHash,
				at,
				at,
			);
		} catch (error) {
			if (isUniqueViolation(error)) {
				throw new AuthError("username_taken", `用户名 "${username}" 已被占用`, 409);
			}
			throw error;
		}
		await this.harden();
		return { id, username, role, createdAt: at, updatedAt: at };
	}

	/** Verify a password and return the public account, or `undefined`. Never says which half failed. */
	async verifyLogin(usernameValue: unknown, passwordValue: unknown): Promise<UserAdminUser | undefined> {
		if (typeof usernameValue !== "string" || typeof passwordValue !== "string") return undefined;
		const username = usernameValue.trim();
		if (username.length === 0 || passwordValue.length === 0 || passwordValue.length > 200) {
			await verifyAgainstDummy(passwordValue.length > 0 ? passwordValue : "x");
			return undefined;
		}
		const row = await this.database.get<UserRow>(
			`SELECT id, username, role, password_hash, created_at, updated_at FROM ${USER_TABLE}
			 WHERE username = ? COLLATE NOCASE`,
			username,
		);
		if (row === undefined) {
			await verifyAgainstDummy(passwordValue);
			return undefined;
		}
		const ok = await verifyPassword(row.password_hash, passwordValue);
		return ok ? publicUser(row) : undefined;
	}

	async createSession(userId: string): Promise<{ id: string; token: string; expiresAt: string }> {
		const id = randomUUID();
		const token = randomBytes(32).toString("base64url");
		const at = nowIso();
		const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
		try {
			await this.database.run(
				`INSERT INTO ${SESSION_TABLE} (id, token_hash, user_id, created_at, expires_at)
				 VALUES (?, ?, ?, ?, ?)`,
				id,
				hashToken(token),
				userId,
				at,
				expiresAt,
			);
		} catch (error) {
			throw new AuthError("auth_db_invalid", `无法创建会话：${errorMessage(error)}`, 500);
		}
		await this.harden();
		return { id, token, expiresAt };
	}

	async findSession(token: string): Promise<{ sessionId: string; user: UserAdminUser } | undefined> {
		if (token.length === 0) return undefined;
		const row = await this.database.get<SessionRow>(
			`SELECT s.id AS session_id, s.expires_at, u.id AS user_id, u.username, u.role, u.created_at, u.updated_at
			 FROM ${SESSION_TABLE} s JOIN ${USER_TABLE} u ON u.id = s.user_id
			 WHERE s.token_hash = ?`,
			hashToken(token),
		);
		if (row === undefined) return undefined;
		if (new Date(row.expires_at).getTime() <= Date.now()) {
			await this.database.run(`DELETE FROM ${SESSION_TABLE} WHERE id = ?`, row.session_id);
			return undefined;
		}
		return { sessionId: row.session_id, user: publicUser(row) };
	}

	async deleteSessionByToken(token: string): Promise<void> {
		if (token.length === 0) return;
		const changes = await this.database.runCounted(
			`DELETE FROM ${SESSION_TABLE} WHERE token_hash = ?`,
			hashToken(token),
		);
		if (changes > 0) await this.harden();
	}

	async deleteSessionsForUser(userId: string): Promise<void> {
		const changes = await this.database.runCounted(
			`DELETE FROM ${SESSION_TABLE} WHERE user_id = ?`,
			userId,
		);
		if (changes > 0) await this.harden();
	}

	async changePassword(userId: string, passwordValue: unknown): Promise<void> {
		const password = normalizePassword(passwordValue);
		const passwordHash = await hashPassword(password);
		const at = nowIso();
		const changed = await this.database.transaction(async (transaction) => {
			const changes = await transaction.runCounted(
				`UPDATE ${USER_TABLE} SET password_hash = ?, updated_at = ? WHERE id = ?`,
				passwordHash,
				at,
				userId,
			);
			if (changes === 0) return false;
			await transaction.run(`DELETE FROM ${SESSION_TABLE} WHERE user_id = ?`, userId);
			return true;
		});
		if (!changed) throw new AuthError("unknown_user", "用户不存在", 404);
		await this.harden();
	}

	async setRole(userId: string, roleValue: unknown): Promise<UserAdminUser> {
		const role = normalizeRole(roleValue);
		const at = nowIso();
		const user = await this.database.transaction(async (transaction) => {
			const row = await transaction.get<UserRow>(
				`SELECT id, username, role, password_hash, created_at, updated_at FROM ${USER_TABLE} WHERE id = ?`,
				userId,
			);
			if (row === undefined) throw new AuthError("unknown_user", "用户不存在", 404);
			if (row.role === role) return publicUser(row);
			if (row.role === "admin" && role !== "admin") {
				const count = await transaction.get<{ count: number }>(
					`SELECT COUNT(*) AS count FROM ${USER_TABLE} WHERE role = 'admin'`,
				);
				if ((count?.count ?? 0) <= 1) {
					throw new AuthError("last_admin", "不能降级最后一个管理员", 409);
				}
			}
			await transaction.run(
				`UPDATE ${USER_TABLE} SET role = ?, updated_at = ? WHERE id = ?`,
				role,
				at,
				userId,
			);
			await transaction.run(`DELETE FROM ${SESSION_TABLE} WHERE user_id = ?`, userId);
			return { ...publicUser(row), role, updatedAt: at };
		});
		await this.harden();
		return user;
	}

	async deleteUser(userId: string): Promise<UserAdminUser> {
		const user = await this.database.transaction(async (transaction) => {
			const row = await transaction.get<UserRow>(
				`SELECT id, username, role, password_hash, created_at, updated_at FROM ${USER_TABLE} WHERE id = ?`,
				userId,
			);
			if (row === undefined) throw new AuthError("unknown_user", "用户不存在", 404);
			if (row.role === "admin") {
				const count = await transaction.get<{ count: number }>(
					`SELECT COUNT(*) AS count FROM ${USER_TABLE} WHERE role = 'admin'`,
				);
				if ((count?.count ?? 0) <= 1) {
					throw new AuthError("last_admin", "不能删除最后一个管理员", 409);
				}
			}
			await transaction.run(`DELETE FROM ${USER_TABLE} WHERE id = ?`, userId);
			return publicUser(row);
		});
		await this.harden();
		return user;
	}

	async cleanExpiredSessions(): Promise<number> {
		const changes = await this.database.runCounted(
			`DELETE FROM ${SESSION_TABLE} WHERE expires_at <= ?`,
			nowIso(),
		);
		if (changes > 0) await this.harden();
		return changes;
	}

	private async harden(): Promise<void> {
		await hardenPermissions(this.path).catch(() => undefined);
	}

	private async connect(): Promise<void> {
		silenceSqliteExperimentalWarning();
		const [{ openNodeSqliteDatabase }, { DatabaseSync: Database }] = await Promise.all([
			import("@earendil-works/chord/sqlite/node"),
			import("node:sqlite"),
		]);
		try {
			await assertNotForeignAuthDatabase(this.path, Database);
		} catch (error) {
			if (error instanceof AuthError) throw error;
			throw new AuthError("auth_db_invalid", `账户数据库无法检查：${errorMessage(error)}`, 500);
		}
		let database: NodeSqliteDatabase;
		try {
			database = await openNodeSqliteDatabase(this.path);
		} catch (error) {
			throw new AuthError(
				"auth_db_invalid",
				`账户数据库无法打开（${errorMessage(error)}）。请恢复 ${this.path} 的备份，或停掉服务后人工移走它以重新初始化。`,
				500,
			);
		}
		try {
			await assertAuthDatabase(database, this.path);
			await database.exec("PRAGMA foreign_keys = ON");
			await hardenPermissions(this.path);
			await applySqliteMigrations(database, MIGRATIONS, { table: SCHEMA_TABLE });
			await database.run(
				`INSERT OR IGNORE INTO ${SCHEMA_TABLE} (singleton, version) VALUES (1, ?)`,
				AUTH_SCHEMA_VERSION,
			);
			const schema = await database.get<{ version: number }>(
				`SELECT version FROM ${SCHEMA_TABLE} WHERE singleton = 1`,
			);
			if ((schema?.version ?? 0) > AUTH_SCHEMA_VERSION) {
				throw new AuthError(
					"auth_db_invalid",
					`账户数据库 schema ${schema?.version} 比本版本支持的 ${AUTH_SCHEMA_VERSION} 更新`,
					500,
				);
			}
			await hardenPermissions(this.path);
			this.database = database;
			await this.cleanExpiredSessions();
		} catch (error) {
			await database.close().catch(() => undefined);
			if (error instanceof AuthError) throw error;
			throw new AuthError(
				"auth_db_invalid",
				`账户数据库不可用（${errorMessage(error)}）。请恢复备份或人工移走 ${this.path} 后重新初始化。`,
				500,
			);
		}
	}
}

/** The Chord principal for one authenticated request/link. */
export function principalFor(user: UserAdminUser, sessionId: string): UserPrincipal {
	return {
		kind: "user",
		id: user.id,
		username: user.username,
		role: user.role,
		session: sessionId,
	};
}

export function defaultAuthDb(env: NodeJS.ProcessEnv = process.env): string {
	const explicit = env.MOONAN_AUTH_DB?.trim();
	if (explicit) return explicit;
	return join(env.MOONAN_HOME?.trim() || join(homedir(), ".moonan"), "auth.db");
}
