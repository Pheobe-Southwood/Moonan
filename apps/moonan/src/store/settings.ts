import type { ApiKeyCredential, Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai';
import type { SqlRow, MoonanDatabase } from './db.js';

interface SettingRow extends SqlRow {
  key: string;
  value: string;
  updated_at: number;
}

/** 通用 key-value 设置表。 */
export class SettingsRepo {
  constructor(private readonly db: MoonanDatabase) {}

  get(key: string): string | undefined {
    const row = this.db.get<SettingRow>('SELECT value FROM setting WHERE key = ?', key);
    return row?.value;
  }

  set(key: string, value: string, now = Date.now()): void {
    this.db.run(
      `INSERT INTO setting (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key,
      value,
      now,
    );
  }

  delete(key: string): void {
    this.db.run('DELETE FROM setting WHERE key = ?', key);
  }

  all(): Record<string, string> {
    const rows = this.db.all<SettingRow>('SELECT key, value FROM setting ORDER BY key');
    const result: Record<string, string> = {};
    for (const row of rows) result[row.key] = row.value;
    return result;
  }
}

interface CredRow extends SqlRow {
  provider_id: string;
  type: string;
  secret: string | null;
  env: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * 明文 `CredentialStore`：把 pi-ai 的凭据原样存进 SQLite。
 *
 * `modify` 是唯一写路径，因此 OAuth 刷新不会被并发双重执行（rc1 里 OAuth 只是占位，
 * 但契约照实现，rc2 接上真实 OAuth 时不用改）。
 */
export class SqliteCredentialStore implements CredentialStore {
  constructor(private readonly db: MoonanDatabase) {}

  async read(providerId: string): Promise<Credential | undefined> {
    const row = this.db.get<CredRow>('SELECT * FROM provider_cred WHERE provider_id = ?', providerId);
    if (!row) return undefined;
    if (row.type === 'oauth') {
      const parsed = row.secret ? (JSON.parse(row.secret) as Record<string, unknown>) : {};
      return { ...parsed, type: 'oauth' } as Credential;
    }
    const credential: ApiKeyCredential = { type: 'api_key' };
    if (row.secret !== null) credential.key = row.secret;
    if (row.env) credential.env = JSON.parse(row.env) as Record<string, string>;
    return credential;
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const rows = this.db.all<Pick<CredRow, 'provider_id' | 'type'>>(
      'SELECT provider_id, type FROM provider_cred ORDER BY provider_id',
    );
    return rows.map((row) => ({
      providerId: row.provider_id,
      type: row.type === 'oauth' ? ('oauth' as const) : ('api_key' as const),
    }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    const current = await this.read(providerId);
    const next = await fn(current);
    if (next === undefined) return undefined;
    this.#write(providerId, next);
    return next;
  }

  async delete(providerId: string): Promise<void> {
    this.db.run('DELETE FROM provider_cred WHERE provider_id = ?', providerId);
  }

  #write(providerId: string, credential: Credential): void {
    const now = Date.now();
    const existing = this.db.get<CredRow>(
      'SELECT created_at FROM provider_cred WHERE provider_id = ?',
      providerId,
    );
    const createdAt = existing?.created_at ?? now;
    if (credential.type === 'oauth') {
      const { type: _type, ...rest } = credential;
      this.db.run(
        `INSERT INTO provider_cred (provider_id, type, secret, env, created_at, updated_at)
         VALUES (?, 'oauth', ?, NULL, ?, ?)
         ON CONFLICT (provider_id) DO UPDATE SET type = 'oauth', secret = excluded.secret,
           env = NULL, updated_at = excluded.updated_at`,
        providerId,
        JSON.stringify(rest),
        createdAt,
        now,
      );
      return;
    }
    this.db.run(
      `INSERT INTO provider_cred (provider_id, type, secret, env, created_at, updated_at)
       VALUES (?, 'api_key', ?, ?, ?, ?)
       ON CONFLICT (provider_id) DO UPDATE SET type = 'api_key', secret = excluded.secret,
         env = excluded.env, updated_at = excluded.updated_at`,
      providerId,
      credential.key ?? null,
      credential.env ? JSON.stringify(credential.env) : null,
      createdAt,
      now,
    );
  }
}
