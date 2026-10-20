import { MoonanDatabase, openDatabase, LATEST_SCHEMA_VERSION } from './db.js';
import { AgentsRepo, CustomProvidersRepo } from './agents.js';
import { SettingsRepo, SqliteCredentialStore } from './settings.js';
import { TranscriptRepo } from './transcripts.js';

export { MoonanDatabase, openDatabase, LATEST_SCHEMA_VERSION };
export type { SqlRow, SqlValue } from './db.js';
export { AgentsRepo, CustomProvidersRepo } from './agents.js';
export { SettingsRepo, SqliteCredentialStore } from './settings.js';
export { TranscriptRepo } from './transcripts.js';
export type { ConversationRecord, AppendMessageInput, QueueKind, QueuedItem } from './transcripts.js';

/** 全部仓储的聚合句柄。 */
export interface Store {
  readonly db: MoonanDatabase;
  readonly settings: SettingsRepo;
  readonly credentials: SqliteCredentialStore;
  readonly agents: AgentsRepo;
  readonly customProviders: CustomProvidersRepo;
  readonly transcripts: TranscriptRepo;
  close(): void;
}

export function createStore(file: string): Store {
  const db = openDatabase(file);
  return {
    db,
    settings: new SettingsRepo(db),
    credentials: new SqliteCredentialStore(db),
    agents: new AgentsRepo(db),
    customProviders: new CustomProvidersRepo(db),
    transcripts: new TranscriptRepo(db),
    close: () => db.close(),
  };
}
