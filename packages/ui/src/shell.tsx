import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type {ClientServices, HostState, TabId} from '@moonan/plugin-sdk';
import { createWire, type WireClient, type WireStatus } from './transport/wire.js';
import { acquireServices, ServicesContext } from './services.js';
import { ProviderPanel } from './tabs/provider-panel.js';
import { AgentManager } from './tabs/agent-manager.js';
import { Conversation } from './tabs/conversation.js';
import { LogWindow } from './tabs/log-window.js';

const TABS: readonly { id: TabId; label: string; hint: string }[] = [
  { id: 'providers', label: '提供商', hint: 'provider 与 Key' },
  { id: 'agents', label: 'Agent', hint: '人设与模型' },
  { id: 'conversation', label: '对话', hint: '与角色交谈' },
  { id: 'logs', label: '日志', hint: '原始上下文' },
];

export interface Route {
  readonly tab: TabId;
  readonly param?: string;
}

function parseHash(hash: string): Route {
  const clean = hash.replace(/^#\/?/, '');
  const [tabPart, param] = clean.split('/');
  const tab = TABS.find((candidate) => candidate.id === tabPart)?.id ?? 'conversation';
  return param ? { tab, param: decodeURIComponent(param) } : { tab };
}

/** 顶层 shell：导航 + hash 路由 + 与服务器的单一连接。 */
export function Shell(): ReactNode {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  const [notices, setNotices] = useState<string[]>([]);
  const [status, setStatus] = useState<WireStatus>('connecting');
  const [services, setServices] = useState<ClientServices | undefined>(undefined);
  const [hostState, setHostState] = useState<HostState | undefined>(undefined);

  const wire = useMemo<WireClient>(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return createWire({
      url: `${protocol}://${window.location.host}/api/ws`,
      protocols: ['moonan.v1'],
      onStatus: setStatus,
      onNotice: (message) => setNotices((current) => [...current.slice(-4), message]),
    });
  }, []);

  useEffect(() => {
    const onHashChange = (): void => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void wire
      .whenReady()
      .then(() => {
        if (cancelled) return;
        setServices(acquireServices((service) => wire.services.use(service)));
      })
      .catch((error: unknown) => {
        setNotices((current) => [...current, `连接失败：${String(error)}`]);
      });
    return () => {
      cancelled = true;
    };
  }, [wire]);

  useEffect(() => () => wire.close(), [wire]);

  useEffect(() => {
    if (!services) return;
    return services.state.state.subscribe((value: HostState) => setHostState(value));
  }, [services]);

  useEffect(() => {
    if (!services || hostState?.activeTab === route.tab) return;
    void services.state.set({ patch: { activeTab: route.tab } }).catch(() => undefined);
  }, [services, route.tab, hostState?.activeTab]);

  const navigate = (hash: string): void => {
    window.location.hash = hash;
    setRoute(parseHash(hash));
  };

  return (
    <div className="shell">
      <nav className="nav">
        <div className="nav__brand">
          <h1>Moonan</h1>
          <p>
            角色扮演运行时 <span className="mono">rc.1</span>
          </p>
        </div>
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className="nav__item"
            type="button"
            aria-current={route.tab === tab.id}
            onClick={() => navigate(`#/${tab.id}`)}
          >
            <span>{tab.label}</span>
            <small>{tab.hint}</small>
          </button>
        ))}
        <div className="nav__foot">
          <span className="mono">连接：{statusLabel(status)}</span>
          <span className="mono">数据明文存放在 ~/.moonan</span>
        </div>
      </nav>
      <main className="main">
        <header className="topbar">
          <h2>{TABS.find((tab) => tab.id === route.tab)?.label ?? 'Moonan'}</h2>
          <span className="topbar__meta">
            {hostState ? `昵称 ${hostState.nickname}` : '—'}
            {services ? ' · 已订阅' : ' · 连接中'}
          </span>
        </header>
        {notices.length > 0 && (
          <div className="notice notice--error" style={{ margin: 'var(--space-4) var(--space-5) 0' }}>
            {notices.at(-1)}
          </div>
        )}
        <section
          className={
            route.tab === 'conversation' || route.tab === 'logs' ? 'content content--flush' : 'content'
          }
        >
          {!services ? (
            <div className="empty">正在连接服务器…</div>
          ) : (
            <ServicesContext.Provider value={services}>
              {route.tab === 'providers' ? (
                <ProviderPanel services={services} />
              ) : route.tab === 'agents' ? (
                <AgentManager services={services} route={route} navigate={navigate} />
              ) : route.tab === 'conversation' ? (
                <Conversation services={services} route={route} nickname={hostState?.nickname ?? '你'} />
              ) : (
                <LogWindow services={services} route={route} />
              )}
            </ServicesContext.Provider>
          )}
        </section>
      </main>
    </div>
  );
}

function statusLabel(status: WireStatus): string {
  switch (status) {
    case 'connecting':
      return '连接中';
    case 'open':
      return '已连接';
    case 'closed':
      return '已断开';
    default:
      return '错误';
  }
}

export { TABS };
