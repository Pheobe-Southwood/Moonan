import type { AgentDefinition } from '@moonan/plugin-sdk';
import type { CustomProviderRecord } from '@moonan/plugin-sdk';
import type { MoonanDatabase, SqlRow } from './db.js';

interface AgentRow extends SqlRow {
  id: string;
  def: string;
  created_at: number;
  updated_at: number;
}

/** Agent 定义表。 */
export class AgentsRepo {
  constructor(private readonly db: MoonanDatabase) {}

  all(): AgentDefinition[] {
    const rows = this.db.all<AgentRow>('SELECT def FROM agent_meta ORDER BY id');
    return rows.map((row) => JSON.parse(row.def) as AgentDefinition);
  }

  get(id: string): AgentDefinition | undefined {
    const row = this.db.get<AgentRow>('SELECT def FROM agent_meta WHERE id = ?', id);
    return row ? (JSON.parse(row.def) as AgentDefinition) : undefined;
  }

  put(definition: AgentDefinition, now = Date.now()): void {
    this.db.run(
      `INSERT INTO agent_meta (id, def, created_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET def = excluded.def, updated_at = excluded.updated_at`,
      definition.id,
      JSON.stringify(definition),
      now,
      now,
    );
  }

  delete(id: string): void {
    this.db.run('DELETE FROM agent_meta WHERE id = ?', id);
  }
}

interface CustomProviderRow extends SqlRow {
  id: string;
  record: string;
}

/** 用户自定义 provider 表。 */
export class CustomProvidersRepo {
  constructor(private readonly db: MoonanDatabase) {}

  all(): CustomProviderRecord[] {
    const rows = this.db.all<CustomProviderRow>('SELECT record FROM custom_provider ORDER BY id');
    return rows.map((row) => JSON.parse(row.record) as CustomProviderRecord);
  }

  get(id: string): CustomProviderRecord | undefined {
    const row = this.db.get<CustomProviderRow>(
      'SELECT record FROM custom_provider WHERE id = ?',
      id,
    );
    return row ? (JSON.parse(row.record) as CustomProviderRecord) : undefined;
  }

  put(record: CustomProviderRecord, now = Date.now()): void {
    this.db.run(
      `INSERT INTO custom_provider (id, record, created_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET record = excluded.record, updated_at = excluded.updated_at`,
      record.id,
      JSON.stringify(record),
      now,
      now,
    );
  }

  delete(id: string): void {
    this.db.run('DELETE FROM custom_provider WHERE id = ?', id);
  }
}
