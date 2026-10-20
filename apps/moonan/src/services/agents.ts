import type { Context, FacetEnvironment, MutableReplicatedState } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type {
  AgentDefinition,
  AgentDefinitionInput,
  AgentId,
  AgentInfo,
  AgentRuntimeInfo,
  AgentsService,
} from '@moonan/plugin-sdk';
import type { AgentManager } from '../runtime/agent-manager.js';
import { renderPrompt } from '../runtime/actblock.js';

interface AgentsState {
  agents: AgentInfo[];
  runtime: Record<string, AgentRuntimeInfo>;
}

/** Agent 注册表与实时状态的对外视图。 */
export class AgentsServiceImpl implements AgentsService {
  readonly #state: MutableReplicatedState<AgentsState>;
  #manager: AgentManager;

  constructor(
    env: FacetEnvironment,
    manager: AgentManager,
  ) {
    this.#manager = manager;
    this.#state = env.replicatedState<AgentsState>({ agents: [], runtime: {} });
    this.publish();
  }

  get state() {
    return this.#state;
  }

  async list(_context?: Context): Promise<readonly AgentInfo[]> {
    return this.#state.value.agents;
  }

  async get(input: { readonly agentId: AgentId }, _context?: Context): Promise<AgentDefinition> {
    return this.#manager.definition(input.agentId);
  }

  async update(
    input: {
      readonly agentId: AgentId;
      readonly patch: Partial<AgentDefinition>;
    },
    _context?: Context,
  ): Promise<AgentDefinition> {
    const definition = this.#manager.updateAgent(input.agentId, input.patch);
    this.publish();
    return definition;
  }

  async spawn(input: { readonly definition: AgentDefinitionInput }, _context?: Context): Promise<AgentId> {
    const definition = this.#manager.normalizeDefinition(input.definition);
    if (this.#manager.has(definition.id)) {
      throw new Error(`Agent id 已存在：${definition.id}`);
    }
    this.#manager.registerAgent(definition);
    this.publish();
    return definition.id;
  }

  async kill(input: { readonly agentId: AgentId }, _context?: Context): Promise<void> {
    this.#manager.removeAgent(input.agentId);
    this.publish();
  }

  async send(
    input: {
      readonly agentId: AgentId;
      readonly kind: 'steer' | 'followUp' | 'write';
      readonly text: string;
    },
    _context?: Context,
  ): Promise<void> {
    this.#manager.send(input.agentId, input.kind, input.text);
    this.publishRuntime();
  }

  async renderPrompt(
    input: { readonly agentId: AgentId },
    _context?: Context,
  ): Promise<Awaited<ReturnType<AgentsService['renderPrompt']>>> {
    const definition = this.#manager.definition(input.agentId);
    const rendered = renderPrompt(definition.id, definition.systemPrompt, definition.variables);
    return {
      agentId: rendered.agentId,
      text: rendered.text,
      missingVariables: rendered.missingVariables,
    };
  }

  publish(): void {
    const agents: AgentInfo[] = this.#manager.definitions().map((definition) => ({
      id: definition.id,
      name: definition.name,
      description: definition.description,
      scope: definition.scope,
      ui: definition.ui,
      subjectCount: 0,
      ...(definition.owner ? { owner: definition.owner } : {}),
      ...(definition.model ? { model: definition.model } : {}),
      ...(definition.thinkingLevel ? { thinkingLevel: definition.thinkingLevel } : {}),
    }));
    const runtime: Record<string, AgentRuntimeInfo> = {};
    for (const info of this.#manager.runtimeInfos()) runtime[info.agentId] = info;
    this.#state.change(BACKGROUND_CONTEXT, (draft) => {
      draft.agents = agents;
      draft.runtime = runtime;
    });
  }

  publishRuntime(): void {
    const runtime: Record<string, AgentRuntimeInfo> = {};
    for (const info of this.#manager.runtimeInfos()) runtime[info.agentId] = info;
    this.#state.change(BACKGROUND_CONTEXT, (draft) => {
      draft.runtime = runtime;
    });
  }
}
