import { useEffect, useState, type ReactNode } from 'react';
import type {ClientServices, CustomProviderRecord, ProviderInfo} from '@moonan/plugin-sdk';
import { useReplicatedValue } from '../services.js';

/** 提供商管理面板：选择 provider、配置 API Key、添加自定义 provider。 */
export function ProviderPanel({ services }: { services: ClientServices }): ReactNode {
  const published = useReplicatedValue(services.providers.state);
  const [providers, setProviders] = useState<readonly ProviderInfo[]>([]);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [keyDraft, setKeyDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [showCustom, setShowCustom] = useState(false);

  useEffect(() => {
    void services.providers
      .list()
      .then((list) => {
        setProviders(list);
        setSelected((current) => current ?? list[0]?.id);
      })
      .catch((cause: unknown) => setError(String(cause)));
  }, [services]);

  useEffect(() => {
    if (published?.providers) setProviders(published.providers);
  }, [published]);

  const current = providers.find((provider) => provider.id === selected);

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid-2">
      <div>
        <div className="row" style={{ marginBottom: 'var(--space-3)' }}>
          <button className="btn" type="button" onClick={() => setShowCustom((value) => !value)}>
            {showCustom ? '取消新增' : '自定义 provider'}
          </button>
          <span className="mono" style={{ color: 'var(--ink-3)' }}>
            共 {providers.length} 个
          </span>
        </div>
        <div className="list">
          {providers.map((provider) => (
            <button
              key={provider.id}
              className="list__row"
              type="button"
              aria-selected={provider.id === selected}
              onClick={() => {
                setSelected(provider.id);
                setKeyDraft('');
                setShowCustom(false);
              }}
            >
              <strong>{provider.name}</strong>
              <span>
                {provider.id} · {provider.modelCount} 模型
                {provider.kind === 'custom' ? ' · 自定义' : ''}
              </span>
              <span>
                <span className={`tag ${provider.configured ? 'tag--ok' : 'tag--muted'}`}>
                  {provider.configured ? '已配置' : '未配置'}
                </span>{' '}
                {provider.supportsOAuth && <span className="tag tag--muted">OAuth</span>}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div>
        {error && <div className="notice notice--error">{error}</div>}
        {showCustom ? (
          <CustomProviderForm
            busy={busy}
            onSubmit={(record) =>
              run(async () => {
                await services.providers.setCustom({ record });
                setShowCustom(false);
              })
            }
          />
        ) : !current ? (
          <div className="empty">选择一个 provider</div>
        ) : (
          <>
            <div className="panel">
              <p className="panel__title">状态</p>
              <table className="data">
                <tbody>
                  <tr>
                    <th>id</th>
                    <td className="mono">{current.id}</td>
                  </tr>
                  <tr>
                    <th>类型</th>
                    <td>{current.kind === 'custom' ? '用户自定义' : 'pi-ai 内置'}</td>
                  </tr>
                  <tr>
                    <th>凭据来源</th>
                    <td>
                      {current.configured ? (
                        <span className="tag tag--ok">{current.source ?? '已配置'}</span>
                      ) : (
                        <span className="tag tag--muted">未配置</span>
                      )}
                    </td>
                  </tr>
                  <tr>
                    <th>模型数</th>
                    <td>{current.modelCount}</td>
                  </tr>
                  {current.apiKind && (
                    <tr>
                      <th>wire API</th>
                      <td className="mono">{current.apiKind}</td>
                    </tr>
                  )}
                  {current.baseUrl && (
                    <tr>
                      <th>baseUrl</th>
                      <td className="mono">{current.baseUrl}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="panel">
              <p className="panel__title">API Key</p>
              <div className="field">
                <label htmlFor="provider-key">明文保存到本地数据库</label>
                <input
                  id="provider-key"
                  type="password"
                  value={keyDraft}
                  placeholder="sk-…"
                  onChange={(event) => setKeyDraft(event.target.value)}
                />
                <small>保存后立刻生效，不需要重启；同一 provider 只保留一份凭据。</small>
              </div>
              <div className="row">
                <button
                  className="btn btn--primary"
                  type="button"
                  disabled={busy || keyDraft.trim().length === 0}
                  onClick={() =>
                    run(async () => {
                      await services.providers.setKey({ providerId: current.id, key: keyDraft.trim() });
                      setKeyDraft('');
                    })
                  }
                >
                  保存 Key
                </button>
                <button
                  className="btn"
                  type="button"
                  disabled={busy || !current.configured}
                  onClick={() => run(async () => services.providers.clearKey({ providerId: current.id }))}
                >
                  清除
                </button>
                <button className="btn" type="button" disabled title="rc1 未实现 OAuth 登录">
                  {current.supportsOAuth ? 'OAuth 登录（尚未实现）' : '不支持 OAuth'}
                </button>
                {current.kind === 'custom' && (
                  <button
                    className="btn"
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        await services.providers.removeCustom({ providerId: current.id });
                        setSelected(undefined);
                      })
                    }
                  >
                    删除自定义 provider
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function CustomProviderForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (record: CustomProviderRecord) => void;
}): ReactNode {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [api, setApi] = useState('openai-completions');
  const [modelId, setModelId] = useState('');
  const [modelName, setModelName] = useState('');

  return (
    <div className="panel">
      <p className="panel__title">新增自定义 provider</p>
      <div className="field">
        <label htmlFor="cp-id">id（小写字母/数字/连字符）</label>
        <input id="cp-id" type="text" value={id} onChange={(event) => setId(event.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="cp-name">显示名</label>
        <input id="cp-name" type="text" value={name} onChange={(event) => setName(event.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="cp-url">baseUrl</label>
        <input
          id="cp-url"
          type="text"
          placeholder="http://127.0.0.1:11434/v1"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="cp-api">wire API</label>
        <select id="cp-api" value={api} onChange={(event) => setApi(event.target.value)}>
          <option value="openai-completions">openai-completions（OpenAI 兼容）</option>
          <option value="openai-responses">openai-responses</option>
          <option value="anthropic-messages">anthropic-messages</option>
          <option value="google-generative-ai">google-generative-ai</option>
          <option value="mistral-conversations">mistral-conversations</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="cp-model">模型 id</label>
        <input id="cp-model" type="text" value={modelId} onChange={(event) => setModelId(event.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="cp-modelname">模型显示名</label>
        <input
          id="cp-modelname"
          type="text"
          value={modelName}
          onChange={(event) => setModelName(event.target.value)}
        />
      </div>
      <button
        className="btn btn--primary"
        type="button"
        disabled={busy || !id || !name || !modelId}
        onClick={() =>
          onSubmit({
            id,
            name,
            ...(baseUrl ? { baseUrl } : {}),
            api,
            models: [{ id: modelId, name: modelName || modelId }],
          })
        }
      >
        创建
      </button>
    </div>
  );
}
