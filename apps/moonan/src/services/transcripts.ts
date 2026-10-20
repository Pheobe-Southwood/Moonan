import type { Context, FacetEnvironment, MutableReplicatedState } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import {
  TRANSCRIPT_EVENT_BUFFER,
  type AgentId,
  type TranscriptEvent,
  type TranscriptMessage,
  type TranscriptsService,
} from '@moonan/plugin-sdk';
import { toPlainJson, type AgentManager } from '../runtime/agent-manager.js';
import type { Store } from '../store/index.js';

interface TranscriptsState {
  recent: TranscriptEvent[];
}

/** 上下文历史与实况事件。日志窗唯一的数据源。 */
export class TranscriptsServiceImpl implements TranscriptsService {
  readonly #state: MutableReplicatedState<TranscriptsState>;
  #store: Store;
  #manager: AgentManager;
  readonly #active: MutableReplicatedState<{ active: string[] }>;

  constructor(
    env: FacetEnvironment,
    store: Store,
    manager: AgentManager,
  ) {
    this.#store = store;
    this.#manager = manager;
    this.#state = env.replicatedState<TranscriptsState>({ recent: [] });
    this.#active = env.replicatedState<{ active: string[] }>({ active: [] });
  }

  get events() {
    return this.#state;
  }

  get state() {
    return this.#state;
  }

  async page(
    input: {
      readonly agentId: AgentId;
      readonly before?: number;
      readonly limit: number;
    },
    _context?: Context,
  ): Promise<{ items: TranscriptMessage[]; before?: number }> {
    const limit = Math.min(Math.max(input.limit, 1), 500);
    const result = this.#store.transcripts.page(input.agentId, limit, input.before);
    return result.before === undefined ? { items: result.items } : { items: result.items, before: result.before };
  }

  async delta(
    input: {
      readonly agentId: AgentId;
      readonly after?: number;
    },
    _context?: Context,
  ): Promise<{ items: TranscriptMessage[]; hasMore: boolean }> {
    return this.#store.transcripts.delta(input.agentId, input.after ?? 0);
  }

  async active(_context?: Context): Promise<readonly AgentId[]> {
    return this.#active.value.active;
  }

  /** 收到一条实况事件：进环形缓冲并发布。 */
  emit(event: TranscriptEvent): void {
    const recent = [...this.#state.value.recent, toPlainJson<TranscriptEvent>(event)];
    if (recent.length > TRANSCRIPT_EVENT_BUFFER) {
      recent.splice(0, recent.length - TRANSCRIPT_EVENT_BUFFER);
    }
    this.#state.change(BACKGROUND_CONTEXT, (draft) => {
      draft.recent = recent;
    });
  }

  publishActive(): void {
    const active = this.#manager
      .definitions()
      .map((definition) => definition.id)
      .filter((id) => {
        try {
          return this.#store.transcripts.conversation(id) !== undefined;
        } catch {
          return false;
        }
      });
    this.#active.change(BACKGROUND_CONTEXT, (draft) => {
      draft.active = active;
    });
  }
}
