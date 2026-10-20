/** Moonan 的 SQLite 数据层。所有数据明文存储，见 docs/adr/0005。 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type SqlValue = null | number | bigint | string | Uint8Array;
export type SqlRow = Record<string, SqlValue>;

export interface DatabaseOptions {
  /** 数据库文件路径；`:memory:` 用于测试。 */
  readonly file: string;
  readonly verbose?: boolean;
}

const SCHEMA_VERSION = 1;

/**
 * v1 初始 schema。
 *
 * 设计要点：
 * - `transcript.content` 存的是消息**原文**，永远不含 ActBlock（ActBlock 只存在于模型视图）。
 * - `transcript.seq` 是会话内单调序号；`id` 是全局自增，翻页用它做游标。
 * - `provider_cred.secret` 是明文 Key；唯一的非明文项是 `setting.ws_token` 的 sha256 摘要。
 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE setting (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE provider_cred (
    provider_id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('api_key', 'oauth')),
    secret TEXT,
    env TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE custom_provider (
    id TEXT PRIMARY KEY,
    record TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE agent_meta (
    id TEXT PRIMARY KEY,
    def TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE conversation (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    title TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_seq INTEGER NOT NULL DEFAULT 0
  ) STRICT;

  CREATE TABLE transcript (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
    content TEXT NOT NULL,
    model TEXT,
    tool_call_id TEXT,
    is_error INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    created_at INTEGER NOT NULL
  ) STRICT;

  CREATE INDEX transcript_conversation_seq ON transcript (conversation_id, seq);
  CREATE INDEX transcript_conversation_id_desc ON transcript (conversation_id, id DESC);

  CREATE TABLE queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('steer', 'follow_up', 'write')),
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;

  CREATE INDEX queue_conversation ON queue (conversation_id, id);
  `,
];

export class MoonanDatabase {
  readonly #db: DatabaseSync;
  readonly #file: string;
  #closed = false;

  constructor(options: DatabaseOptions) {
    this.#file = options.file;
    if (this.#file !== ':memory:') {
      mkdirSync(dirname(this.#file), { recursive: true });
    }
    this.#db = new DatabaseSync(this.#file);
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA synchronous = NORMAL');
    this.#db.exec('PRAGMA foreign_keys = ON');
    this.#db.exec('PRAGMA busy_timeout = 5000');
    this.#migrate();
  }

  get file(): string {
    return this.#file;
  }

  get handle(): DatabaseSync {
    if (this.#closed) throw new Error('MoonanDatabase 已关闭');
    return this.#db;
  }

  prepare(sql: string) {
    return this.handle.prepare(sql);
  }

  /** 执行单条语句（无返回值）。 */
  run(sql: string, ...params: SqlValue[]): void {
    this.handle.prepare(sql).run(...params);
  }

  get<T extends SqlRow = SqlRow>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.handle.prepare(sql).get(...params) as T | undefined;
  }

  all<T extends SqlRow = SqlRow>(sql: string, ...params: SqlValue[]): T[] {
    return this.handle.prepare(sql).all(...params) as T[];
  }

  /** 在一个事务里执行；抛错则回滚。 */
  transaction<T>(fn: () => T): T {
    this.handle.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.handle.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.handle.exec('ROLLBACK');
      } catch {
        // 回滚失败时保留原始错误
      }
      throw error;
    }
  }

  #migrate(): void {
    const row = this.get<{ user_version: number }>('PRAGMA user_version');
    const current = Number(row?.user_version ?? 0);
    for (let version = current; version < MIGRATIONS.length; version += 1) {
      const sql = MIGRATIONS[version];
      if (sql === undefined) continue;
      this.handle.exec('BEGIN IMMEDIATE');
      try {
        this.handle.exec(sql);
        this.handle.exec(`PRAGMA user_version = ${version + 1}`);
        this.handle.exec('COMMIT');
      } catch (error) {
        this.handle.exec('ROLLBACK');
        throw error;
      }
    }
  }

  get schemaVersion(): number {
    const row = this.get<{ user_version: number }>('PRAGMA user_version');
    return Number(row?.user_version ?? 0);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
}

export const LATEST_SCHEMA_VERSION = SCHEMA_VERSION;

export function openDatabase(file: string): MoonanDatabase {
  return new MoonanDatabase({ file });
}
