import type { AgentId, MessageRole, TranscriptMessage } from '@moonan/plugin-sdk';
import type { MoonanDatabase, SqlRow } from './db.js';

interface ConversationRow extends SqlRow {
  id: string;
  agent_id: string;
  title: string | null;
  created_at: number;
  updated_at: number;
  last_seq: number;
}

interface TranscriptRow extends SqlRow {
  id: number;
  conversation_id: string;
  seq: number;
  role: string;
  content: string;
  model: string | null;
  tool_call_id: string | null;
  is_error: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  created_at: number;
}

interface QueueRow extends SqlRow {
  id: number;
  conversation_id: string;
  kind: string;
  content: string;
  created_at: number;
}

export interface ConversationRecord {
  readonly id: string;
  readonly agentId: AgentId;
  readonly title?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastSeq: number;
}

export interface AppendMessageInput {
  readonly conversationId: string;
  readonly role: MessageRole;
  readonly content: unknown;
  readonly model?: string;
  readonly toolCallId?: string;
  readonly isError?: boolean;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly createdAt?: number;
}

export type QueueKind = 'steer' | 'follow_up' | 'write';

export interface QueuedItem {
  readonly id: number;
  readonly conversationId: string;
  readonly kind: QueueKind;
  readonly content: unknown;
  readonly createdAt: number;
}

/** 会话 + 上下文消息 + 入站队列。 */
export class TranscriptRepo {
  constructor(private readonly db: MoonanDatabase) {}

  // -- conversation -------------------------------------------------------

  ensureConversation(agentId: AgentId, id = agentId, now = Date.now()): ConversationRecord {
    const existing = this.conversation(id);
    if (existing) return existing;
    this.db.run(
      `INSERT INTO conversation (id, agent_id, title, created_at, updated_at, last_seq)
       VALUES (?, ?, NULL, ?, ?, 0)`,
      id,
      agentId,
      now,
      now,
    );
    return { id, agentId, createdAt: now, updatedAt: now, lastSeq: 0 };
  }

  conversation(id: string): ConversationRecord | undefined {
    const row = this.db.get<ConversationRow>('SELECT * FROM conversation WHERE id = ?', id);
    return row ? toConversation(row) : undefined;
  }

  conversationIds(): string[] {
    return this.db
      .all<Pick<ConversationRow, 'id'>>('SELECT id FROM conversation ORDER BY id')
      .map((row) => row.id);
  }

  deleteConversation(id: string): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM transcript WHERE conversation_id = ?', id);
      this.db.run('DELETE FROM queue WHERE conversation_id = ?', id);
      this.db.run('DELETE FROM conversation WHERE id = ?', id);
    });
  }

  // -- transcript ---------------------------------------------------------

  /** 追加一条消息，返回落库后的记录。 */
  append(input: AppendMessageInput): TranscriptMessage {
    const now = input.createdAt ?? Date.now();
    return this.db.transaction(() => {
      const conversation = this.db.get<ConversationRow>(
        'SELECT * FROM conversation WHERE id = ?',
        input.conversationId,
      );
      if (!conversation) {
        throw new Error(`会话不存在：${input.conversationId}`);
      }
      const seq = conversation.last_seq + 1;
      const info = this.db
        .prepare(
          `INSERT INTO transcript (conversation_id, seq, role, content, model, tool_call_id,
             is_error, input_tokens, output_tokens, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.conversationId,
          seq,
          input.role,
          JSON.stringify(input.content ?? null),
          input.model ?? null,
          input.toolCallId ?? null,
          input.isError === undefined ? null : input.isError ? 1 : 0,
          input.inputTokens ?? null,
          input.outputTokens ?? null,
          now,
        );
      this.db.run('UPDATE conversation SET last_seq = ?, updated_at = ? WHERE id = ?', seq, now, input.conversationId);
      return {
        id: Number(info.lastInsertRowid),
        conversationId: input.conversationId,
        seq,
        role: input.role,
        content: input.content,
        model: input.model,
        toolCallId: input.toolCallId,
        isError: input.isError,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        createdAt: now,
      };
    });
  }

  /** 会话内的全部消息，按 seq 升序。用于重建内存上下文。 */
  all(conversationId: string): TranscriptMessage[] {
    const rows = this.db.all<TranscriptRow>(
      'SELECT * FROM transcript WHERE conversation_id = ? ORDER BY seq ASC',
      conversationId,
    );
    return rows.map(toMessage);
  }

  /** 向上翻页：返回 id 小于 `before` 的最近 `limit` 条，按 seq 升序返回。 */
  page(conversationId: string, limit: number, before?: number): { items: TranscriptMessage[]; before?: number } {
    const rows =
      before === undefined
        ? this.db.all<TranscriptRow>(
            'SELECT * FROM transcript WHERE conversation_id = ? ORDER BY id DESC LIMIT ?',
            conversationId,
            limit,
          )
        : this.db.all<TranscriptRow>(
            'SELECT * FROM transcript WHERE conversation_id = ? AND id < ? ORDER BY id DESC LIMIT ?',
            conversationId,
            before,
            limit,
          );
    const items = rows.map(toMessage).reverse();
    const first = items[0];
    return { items, before: first ? first.id : before };
  }

  /** 自 `after`（不含）起的全部消息；`hasMore` 表示一次没取完。 */
  delta(conversationId: string, after: number, limit = 2000): { items: TranscriptMessage[]; hasMore: boolean } {
    const rows = this.db.all<TranscriptRow>(
      'SELECT * FROM transcript WHERE conversation_id = ? AND id > ? ORDER BY id ASC LIMIT ?',
      conversationId,
      after,
      limit + 1,
    );
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(toMessage);
    return { items, hasMore };
  }

  count(conversationId: string): number {
    const row = this.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM transcript WHERE conversation_id = ?',
      conversationId,
    );
    return Number(row?.n ?? 0);
  }

  // -- queue --------------------------------------------------------------

  enqueue(conversationId: string, kind: QueueKind, content: unknown, now = Date.now()): QueuedItem {
    const info = this.db
      .prepare('INSERT INTO queue (conversation_id, kind, content, created_at) VALUES (?, ?, ?, ?)')
      .run(conversationId, kind, JSON.stringify(content ?? null), now);
    return { id: Number(info.lastInsertRowid), conversationId, kind, content, createdAt: now };
  }

  /** 取队首的 `limit` 条并删除（`one-at-a-time` 传 1）。 */
  drain(conversationId: string, kind: QueueKind, limit: number): QueuedItem[] {
    if (limit <= 0) return [];
    return this.db.transaction(() => {
      const rows = this.db.all<QueueRow>(
        'SELECT * FROM queue WHERE conversation_id = ? AND kind = ? ORDER BY id ASC LIMIT ?',
        conversationId,
        kind,
        limit,
      );
      for (const row of rows) {
        this.db.run('DELETE FROM queue WHERE id = ?', row.id);
      }
      return rows.map((row) => ({
        id: row.id,
        conversationId: row.conversation_id,
        kind: row.kind as QueueKind,
        content: JSON.parse(row.content) as unknown,
        createdAt: row.created_at,
      }));
    });
  }

  peek(conversationId: string, kind: QueueKind, limit: number): QueuedItem[] {
    const rows = this.db.all<QueueRow>(
      'SELECT * FROM queue WHERE conversation_id = ? AND kind = ? ORDER BY id ASC LIMIT ?',
      conversationId,
      kind,
      limit,
    );
    return rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      kind: row.kind as QueueKind,
      content: JSON.parse(row.content) as unknown,
      createdAt: row.created_at,
    }));
  }

  queueCount(conversationId: string): number {
    const row = this.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM queue WHERE conversation_id = ?',
      conversationId,
    );
    return Number(row?.n ?? 0);
  }

  clearQueue(conversationId: string, kind?: QueueKind): void {
    if (kind) {
      this.db.run('DELETE FROM queue WHERE conversation_id = ? AND kind = ?', conversationId, kind);
      return;
    }
    this.db.run('DELETE FROM queue WHERE conversation_id = ?', conversationId);
  }
}

function toConversation(row: ConversationRow): ConversationRecord {
  const record: ConversationRecord = {
    id: row.id,
    agentId: row.agent_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeq: row.last_seq,
  };
  return row.title === null ? record : { ...record, title: row.title };
}

function toMessage(row: TranscriptRow): TranscriptMessage {
  const message: TranscriptMessage = {
    id: row.id,
    conversationId: row.conversation_id,
    seq: row.seq,
    role: row.role as MessageRole,
    content: JSON.parse(row.content) as unknown,
    createdAt: row.created_at,
  };
  return {
    ...message,
    ...(row.model === null ? {} : { model: row.model }),
    ...(row.tool_call_id === null ? {} : { toolCallId: row.tool_call_id }),
    ...(row.is_error === null ? {} : { isError: row.is_error === 1 }),
    ...(row.input_tokens === null ? {} : { inputTokens: row.input_tokens }),
    ...(row.output_tokens === null ? {} : { outputTokens: row.output_tokens }),
  };
}
