import type { Context, FacetEnvironment, MutableReplicatedState } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type {
  ActionInfo,
  ActionsService,
  AgentId,
  ConversationSidebar,
} from '@moonan/plugin-sdk';
import type { AgentManager } from '../runtime/agent-manager.js';

interface ActionsState {
  actions: ActionInfo[];
  byAgent: Record<string, ActionInfo[]>;
  sidebars: Record<string, ConversationSidebar[]>;
}

/** 已注册 action 的对外视图（含前置条件求值结果）。 */
export class ActionsServiceImpl implements ActionsService {
  readonly #state: MutableReplicatedState<ActionsState>;
  #manager: AgentManager;

  constructor(
    env: FacetEnvironment,
    manager: AgentManager,
  ) {
    this.#manager = manager;
    this.#state = env.replicatedState<ActionsState>({ actions: [], byAgent: {}, sidebars: {} });
    this.publish();
  }

  get state() {
    return this.#state;
  }

  async list(_context?: Context): Promise<readonly ActionInfo[]> {
    return this.#state.value.actions;
  }

  async invoke(
    input: {
      readonly agentId: AgentId;
      readonly actionId: string;
      readonly args: unknown;
    },
    _context?: Context,
  ): Promise<Awaited<ReturnType<ActionsService['invoke']>>> {
    const result = await this.#manager.invokeAction(input.agentId, input.actionId, input.args, undefined);
    this.publishSidebars();
    return result;
  }

  /** 重新求值每个 Agent 的可用 action 并发布。 */
  publish(): void {
    const byAgent: Record<string, ActionInfo[]> = {};
    const flat = new Map<string, ActionInfo>();
    for (const definition of this.#manager.definitions()) {
      const list = this.#manager.listAvailableActions(definition.id).map((action) => ({
        id: action.id,
        title: action.title,
        description: action.description,
        parameters: action.parameters,
        available: true,
        owner: action.owner,
      }));
      byAgent[definition.id] = list;
      for (const action of list) flat.set(action.id, action);
    }
    const actions = [...flat.values()].sort((left, right) => left.id.localeCompare(right.id));
    this.#state.change(BACKGROUND_CONTEXT, (draft) => {
      draft.actions = actions;
      draft.byAgent = byAgent;
      draft.sidebars = this.#collectSidebars();
    });
  }

  publishSidebars(): void {
    const sidebars = this.#collectSidebars();
    this.#state.change(BACKGROUND_CONTEXT, (draft) => {
      draft.sidebars = sidebars;
    });
  }

  #collectSidebars(): Record<string, ConversationSidebar[]> {
    const sidebars: Record<string, ConversationSidebar[]> = {};
    for (const definition of this.#manager.definitions()) {
      sidebars[definition.id] = [...this.#manager.sidebars(definition.id)];
    }
    return sidebars;
  }
}
