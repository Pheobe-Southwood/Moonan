import type { Context, FacetEnvironment, MutableReplicatedState } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { MutableModels, Provider } from '@earendil-works/pi-ai';
import {
  SYSTEM_EVENT_BUFFER,
  type BadgeContribution,
  type CustomProviderRecord,
  type EventsService,
  type ProviderInfo,
  type ProvidersService,
  type SystemEvent,
  type TabContribution,
  type UiContributionsService,
} from '@moonan/plugin-sdk';
import type { Store } from '../store/index.js';
import { buildCustomProvider, resolveCustomProviderApi, type AgentManager } from '../runtime/agent-manager.js';

/** provider 列表与 API Key 管理（本插件自带明文凭据存储的对外视图）。 */
export class ProvidersServiceImpl implements ProvidersService {
  readonly #state: MutableReplicatedState<{ providers: ProviderInfo[] }>;
  #store: Store;
  #registry: MutableModels;
  #log: { warn(message: string, detail?: unknown): void };
  readonly #info = new Map<string, ProviderInfo>();

  constructor(
    env: FacetEnvironment,
    store: Store,
    registry: MutableModels,
    log: { warn(message: string, detail?: unknown): void },
  ) {
    this.#store = store;
    this.#registry = registry;
    this.#log = log;
    this.#state = env.replicatedState<{ providers: ProviderInfo[] }>({ providers: [] });
  }

  get state() {
    return this.#state;
  }

  async list(_context?: Context): Promise<readonly ProviderInfo[]> {
    return this.#state.value.providers;
  }

  async models(
    input: { readonly providerId: string },
    _context?: Context,
  ): Promise<Awaited<ReturnType<ProvidersService['models']>>> {
    const provider = this.#registry.getProvider(input.providerId);
    if (!provider) return [];
    return provider.getModels().map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      contextWindow: model.contextWindow,
    }));
  }

  async setKey(
    input: { readonly providerId: string; readonly key: string },
    _context?: Context,
  ): Promise<ProviderInfo> {
    await this.#store.credentials.modify(input.providerId, async () => ({
      type: 'api_key' as const,
      key: input.key,
    }));
    await this.publish();
    return this.#info.get(input.providerId) ?? (await this.#missing(input.providerId));
  }

  async clearKey(input: { readonly providerId: string }, _context?: Context): Promise<ProviderInfo> {
    await this.#store.credentials.delete(input.providerId);
    await this.publish();
    return this.#info.get(input.providerId) ?? (await this.#missing(input.providerId));
  }

  async setCustom(
    input: { readonly record: CustomProviderRecord },
    _context?: Context,
  ): Promise<ProviderInfo> {
    const record = normalizeCustom(input.record);
    this.#store.customProviders.put(record);
    await this.registerCustom(record);
    await this.publish();
    return this.#info.get(record.id) ?? (await this.#missing(record.id));
  }

  async removeCustom(input: { readonly providerId: string }, _context?: Context): Promise<void> {
    this.#store.customProviders.delete(input.providerId);
    this.#registry.deleteProvider(input.providerId);
    await this.publish();
  }

  /** 从存储装载自定义 provider（启动时调用）。 */
  async loadCustomProviders(): Promise<void> {
    for (const record of this.#store.customProviders.all()) {
      try {
        await this.registerCustom(record);
      } catch (error) {
        this.#log.warn(`自定义 provider ${record.id} 装载失败`, error instanceof Error ? error.message : String(error));
      }
    }
  }

  async registerCustom(record: CustomProviderRecord): Promise<Provider> {
    const api = await resolveCustomProviderApi(record.api);
    const auth = {
      apiKey: {
        name: `${record.name} API key`,
        resolve: async ({ credential }: { credential?: { type: string; key?: string } }) =>
          credential?.type === 'api_key' && credential.key
            ? { auth: { apiKey: credential.key }, source: '已保存的 Key' }
            : undefined,
      },
    };
    const provider = buildCustomProvider(record, api, auth as never);
    this.#registry.setProvider(provider);
    return provider;
  }

  async publish(): Promise<readonly ProviderInfo[]> {
    const providers: ProviderInfo[] = [];
    for (const provider of this.#registry.getProviders()) {
      const info = await this.#describe(provider);
      providers.push(info);
    }
    providers.sort((left, right) => left.id.localeCompare(right.id));
    this.#info.clear();
    for (const info of providers) this.#info.set(info.id, info);
    this.#state.change(BACKGROUND_CONTEXT, (draft) => {
      draft.providers = providers;
    });
    return providers;
  }

  async #describe(provider: Provider): Promise<ProviderInfo> {
    const custom = this.#store.customProviders.get(provider.id) !== undefined;
    let configured = false;
    let source: string | undefined;
    try {
      const auth = await this.#registry.getAuth(provider.id);
      configured = auth !== undefined;
      source = auth?.source;
    } catch (error) {
      source = `解析失败：${error instanceof Error ? error.message : String(error)}`;
    }
    const models = provider.getModels();
    const info: ProviderInfo = {
      id: provider.id,
      name: provider.name,
      kind: custom ? 'custom' : 'builtin',
      configured,
      supportsOAuth: provider.auth.oauth !== undefined,
      oauthImplemented: false,
      modelCount: models.length,
      ...(source ? { source } : {}),
      ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
      ...(models[0]?.api ? { apiKind: String(models[0].api) } : {}),
    };
    return info;
  }

  async #missing(providerId: string): Promise<ProviderInfo> {
    return {
      id: providerId,
      name: providerId,
      kind: 'builtin',
      configured: false,
      supportsOAuth: false,
      oauthImplemented: false,
      modelCount: 0,
    };
  }
}

/** 插件 UI 贡献（Tab 内容与徽章）。 */
export class UiContributionsServiceImpl implements UiContributionsService {
  readonly #state: MutableReplicatedState<{ tabs: TabContribution[]; badges: BadgeContribution[] }>;

  constructor(env: FacetEnvironment) {
    this.#state = env.replicatedState({ tabs: [] as TabContribution[], badges: [] as BadgeContribution[] });
  }

  get state() {
    return this.#state;
  }

  async contribute(
    input: { readonly tab?: TabContribution; readonly badge?: BadgeContribution },
    _context?: Context,
  ): Promise<void> {
    this.#state.change(BACKGROUND_CONTEXT, (draft) => {
      if (input.tab && !draft.tabs.some((tab) => tab.tab === input.tab?.tab)) {
        draft.tabs.push(input.tab);
      }
      if (input.badge) {
        const index = draft.badges.findIndex((badge) => badge.tab === input.badge?.tab);
        if (index >= 0) draft.badges[index] = input.badge;
        else draft.badges.push(input.badge);
      }
    });
  }
}

/** 系统事件（对话窗打开、Agent 增删等）。 */
export class EventsServiceImpl implements EventsService {
  readonly #state: MutableReplicatedState<{ recent: SystemEvent[] }>;
  readonly #listeners = new Set<(event: SystemEvent) => void>();

  constructor(env: FacetEnvironment) {
    this.#state = env.replicatedState({ recent: [] as SystemEvent[] });
  }

  get state() {
    return this.#state;
  }

  async emit(input: SystemEvent, _context?: Context): Promise<void> {
    const recent = [...this.#state.value.recent, input];
    if (recent.length > SYSTEM_EVENT_BUFFER) recent.splice(0, recent.length - SYSTEM_EVENT_BUFFER);
    this.#state.change(BACKGROUND_CONTEXT, (draft) => {
      draft.recent = recent;
    });
    for (const listener of this.#listeners) {
      try {
        listener(input);
      } catch {
        // 监听器错误不影响发布
      }
    }
  }

  subscribe(listener: (event: SystemEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

function normalizeCustom(record: CustomProviderRecord): CustomProviderRecord {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(record.id)) {
    throw new Error('自定义 provider 的 id 只允许小写字母、数字与连字符');
  }
  if (record.models.length === 0) {
    throw new Error('自定义 provider 至少需要一个模型');
  }
  return {
    ...record,
    models: record.models.map((model) => ({ ...model, name: model.name || model.id })),
  };
}

export type { AgentManager };
