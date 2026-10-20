import type { Context, FacetEnvironment, MutableReplicatedState } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { DEFAULT_TAB, type HostState, type HostStateService, type TabId } from '@moonan/plugin-sdk';

const DEFAULT_STATE: HostState = {
  openDialog: null,
  activeTab: DEFAULT_TAB,
  nickname: '你',
  dialogOpenedAt: 0,
};

/** 宿主根状态：所有插件共享的一份 replicated state。 */
export class HostStateServiceImpl implements HostStateService {
  readonly #state: MutableReplicatedState<HostState>;
  readonly #listeners = new Set<(state: HostState) => void>();

  constructor(env: FacetEnvironment, private readonly onChange?: (state: HostState) => void) {
    this.#state = env.replicatedState<HostState>({ ...DEFAULT_STATE });
  }

  get state() {
    return this.#state;
  }

  snapshot(): HostState {
    return this.#state.value;
  }

  async get(_context?: Context): Promise<HostState> {
    return this.#state.value;
  }

  async set(input: { readonly patch: Partial<HostState> }, _context?: Context): Promise<HostState> {
    this.#state.change(BACKGROUND_CONTEXT, (draft) => {
      for (const [key, value] of Object.entries(input.patch) as [keyof HostState, never][]) {
        if (value === undefined) continue;
        draft[key] = value;
      }
    });
    const next = this.#state.value;
    for (const listener of this.#listeners) listener(next);
    this.onChange?.(next);
    return next;
  }

  subscribeLocal(listener: (state: HostState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

export const TAB_IDS: readonly TabId[] = ['providers', 'agents', 'conversation', 'logs'];
