import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type {AgentDefinition, AgentInfo, ClientServices, ModelRef, ProviderInfo} from '@moonan/plugin-sdk';
import type { Route } from '../shell.js';
import { useReplicatedValue } from '../services.js';

const MAIN_AGENT_ID = 'main';

/** Agent 管理：列表 + 基本 + 人设（含变量与高级提示词）+ 模型。 */
export function AgentManager({
  services,
  route,
  navigate,
}: {
  services: ClientServices;
  route: Route;
  navigate: (hash: string) => void;
}): ReactNode {
  const published = useReplicatedValue(services.agents.state);
  const [agents, setAgents] = useState<readonly AgentInfo[]>([]);
  const [providers, setProviders] = useState<readonly ProviderInfo[]>([]);
  const [definition, setDefinition] = useState<AgentDefinition | undefined>(undefined);
  const [draft, setDraft] = useState<AgentDefinition | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [advanced, setAdvanced] = useState(false);

  const selectedId = route.param ?? agents.find((agent) => agent.id === MAIN_AGENT_ID)?.id ?? agents[0]?.id;

  useEffect(() => {
    void services.agents
      .list()
      .then(setAgents)
      .catch(() => undefined);
    void services.providers
      .list()
      .then((list) => setProviders(list.filter((provider) => provider.modelCount > 0)))
      .catch(() => undefined);
  }, [services]);

  useEffect(() => {
    if (published?.agents) setAgents(published.agents);
  }, [published]);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    void services.agents
      .get({ agentId: selectedId })
      .then((value) => {
        if (cancelled) return;
        setDefinition(value);
        setDraft({ ...value, variables: { ...value.variables } });
        setAdvanced(false);
      })
      .catch((cause: unknown) => setMessage(String(cause)));
    return () => {
      cancelled = true;
    };
  }, [services, selectedId]);

  const dirty = useMemo(
    () => JSON.stringify(definition) !== JSON.stringify(draft),
    [definition, draft],
  );

  const patch = (next: Partial<AgentDefinition>): void => {
    setDraft((current) => (current ? { ...current, ...next } : current));
  };

  const setVariable = (key: string, value: string): void => {
    setDraft((current) =>
      current ? { ...current, variables: { ...current.variables, [key]: value } } : current,
    );
  };

  const save = async (): Promise<void> => {
    if (!draft) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const saved = await services.agents.update({
        agentId: draft.id,
        patch: {
          name: draft.name,
          description: draft.description,
          systemPrompt: draft.systemPrompt,
          variables: draft.variables,
          ...(draft.model ? { model: draft.model } : {}),
          ...(draft.thinkingLevel ? { thinkingLevel: draft.thinkingLevel } : {}),
        },
      });
      setDefinition(saved);
      setDraft({ ...saved, variables: { ...saved.variables } });
      setMessage('已保存');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid-2">
      <div>
        <div className="row" style={{ marginBottom: 'var(--space-3)' }}>
          <button
            className="btn"
            type="button"
            onClick={async () => {
              const suffix = Math.random().toString(36).slice(2, 6);
              const id = `agent-${suffix}`;
              await services.agents.spawn({
                definition: {
                  id,
                  name: '新角色',
                  description: '在这里配置角色的人设',
                  systemPrompt: '你是{{botname}}，人设：{{soul}}',
                  variables: { botname: '新角色', soul: '' },
                  scope: 'persisted',
                  ui: { dialog: true, icon: '◇' },
                  tools: { pluginTools: true, act: true },
                  owner: 'user',
                },
              });
              navigate(`#/agents/${id}`);
            }}
          >
            新建 Agent
          </button>
        </div>
        <div className="list">
          {agents.map((agent) => (
            <button
              key={agent.id}
              className="list__row"
              type="button"
              aria-selected={agent.id === selectedId}
              onClick={() => navigate(`#/agents/${agent.id}`)}
            >
              <strong>{agent.name || agent.id}</strong>
              <span>
                {agent.id}
                {agent.id === MAIN_AGENT_ID ? ' · 内置主 Agent' : ''}
                {agent.ui.dialog ? '' : ' · 不在对话窗'}
              </span>
              <span>{agent.model ? `${agent.model.provider}/${agent.model.modelId}` : '未选择模型'}</span>
            </button>
          ))}
        </div>
      </div>

      <div>
        {message && <div className="notice">{message}</div>}
        {!draft ? (
          <div className="empty">选择一个 Agent</div>
        ) : (
          <>
            <div className="panel">
              <p className="panel__title">基本</p>
              <div className="field">
                <label htmlFor="agent-name">名字</label>
                <input
                  id="agent-name"
                  type="text"
                  value={draft.name}
                  onChange={(event) => patch({ name: event.target.value })}
                />
                <small>
                  支持变量：名字里写 <span className="mono">{'{{botname}}'}</span> 会随变量变化。
                </small>
              </div>
              <div className="field">
                <label htmlFor="agent-desc">说明</label>
                <input
                  id="agent-desc"
                  type="text"
                  value={draft.description}
                  onChange={(event) => patch({ description: event.target.value })}
                />
              </div>
            </div>

            <div className="panel">
              <p className="panel__title">人设与变量</p>
              <div className="field">
                <label htmlFor="var-botname">Bot 名字（{'{{botname}}'}）</label>
                <input
                  id="var-botname"
                  type="text"
                  value={draft.variables['botname'] ?? ''}
                  onChange={(event) => setVariable('botname', event.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="var-soul">角色人设（{'{{soul}}'}）</label>
                <textarea
                  id="var-soul"
                  rows={8}
                  value={draft.variables['soul'] ?? ''}
                  placeholder="安静、观察力强……"
                  onChange={(event) => setVariable('soul', event.target.value)}
                />
              </div>
              <button className="btn" type="button" onClick={() => setAdvanced((value) => !value)}>
                {advanced ? '收起高级选项' : '展开高级选项（SYSTEM PROMPT）'}
              </button>
              {advanced && (
                <div className="field" style={{ marginTop: 'var(--space-3)' }}>
                  <label htmlFor="agent-prompt">SYSTEM PROMPT 模板</label>
                  <textarea
                    id="agent-prompt"
                    rows={20}
                    value={draft.systemPrompt}
                    onChange={(event) => patch({ systemPrompt: event.target.value })}
                  />
                  <small>
                    变量在每次请求前替换；未定义的变量会替换成空串并在日志里体现。
                  </small>
                </div>
              )}
            </div>

            <div className="panel">
              <p className="panel__title">模型</p>
              <ModelPicker
                providers={providers}
                services={services}
                value={draft.model}
                onChange={(model) => patch({ model })}
              />
              <div className="field">
                <label htmlFor="agent-thinking">思考等级</label>
                <select
                  id="agent-thinking"
                  value={draft.thinkingLevel ?? 'off'}
                  onChange={(event) => patch({ thinkingLevel: event.target.value as AgentDefinition['thinkingLevel'] })}
                >
                  {['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((level) => (
                    <option key={level} value={level}>
                      {level}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="row">
              <button className="btn btn--primary" type="button" disabled={busy || !dirty} onClick={() => void save()}>
                保存
              </button>
              {draft.id === MAIN_AGENT_ID ? (
                <span className="mono" style={{ color: 'var(--ink-3)' }}>
                  主 Agent 不可删除
                </span>
              ) : (
                <button
                  className="btn"
                  type="button"
                  disabled={busy}
                  onClick={async () => {
                    await services.agents.kill({ agentId: draft.id });
                    navigate('#/agents');
                  }}
                >
                  删除
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ModelPicker({
  services,
  providers,
  value,
  onChange,
}: {
  services: ClientServices;
  providers: readonly ProviderInfo[];
  value: ModelRef | undefined;
  onChange: (model: ModelRef) => void;
}): ReactNode {
  const [models, setModels] = useState<readonly { id: string; name: string }[]>([]);
  const providerId = value?.provider ?? providers[0]?.id;

  useEffect(() => {
    if (!providerId) return;
    let cancelled = false;
    void services.providers
      .models({ providerId })
      .then((list) => {
        if (!cancelled) setModels(list);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [services, providerId]);

  return (
    <>
      <div className="field">
        <label htmlFor="agent-provider">provider</label>
        <select
          id="agent-provider"
          value={providerId ?? ''}
          onChange={(event) => onChange({ provider: event.target.value, modelId: '' })}
        >
          {providers.length === 0 && <option value="">（还没有已配置的 provider）</option>}
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.name}（{provider.configured ? '已配置' : '未配置'}）
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="agent-model">模型</label>
        <select
          id="agent-model"
          value={value?.modelId ?? ''}
          onChange={(event) => providerId && onChange({ provider: providerId, modelId: event.target.value })}
        >
          <option value="">（选择模型）</option>
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name} — {model.id}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}
