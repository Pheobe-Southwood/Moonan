import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {AgentId, AgentInfo, ClientServices, TranscriptMessage} from '@moonan/plugin-sdk';
import type { Route } from '../shell.js';
import { useReplicatedValue } from '../services.js';

const PAGE_SIZE = 50;
const COLLAPSED_HEIGHT = 84;
const EXPANDED_MAX = 1200;
const OVERSCAN = 6;

interface LogRow {
  readonly key: string;
  readonly kind: 'message' | 'streaming' | 'loading';
  readonly message?: TranscriptMessage;
  readonly text?: string;
}

/**
 * 日志窗：任意 Agent 的完整原始上下文。
 *
 * - 历史用 `page()` 分页向上加载，渲染用自研虚拟滚动（固定估算行高 + 窗口切片）；
 * - 实时部分来自 `transcripts.events` 的环形缓冲，跟随流式输出；
 * - 思维链与工具详情默认折叠。
 */
export function LogWindow({ services, route }: { services: ClientServices; route: Route }): ReactNode {
  const published = useReplicatedValue(services.agents.state);
  const events = useReplicatedValue(services.transcripts.events);
  const [agents, setAgents] = useState<readonly AgentInfo[]>([]);
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [before, setBefore] = useState<number | undefined>(undefined);
  const [exhausted, setExhausted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showModelView, setShowModelView] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

  const agentId: AgentId | undefined = route.param ?? agents[0]?.id;

  useEffect(() => {
    void services.agents
      .list()
      .then(setAgents)
      .catch(() => undefined);
  }, [services]);

  useEffect(() => {
    if (published?.agents) setAgents(published.agents);
  }, [published]);

  const loadFirstPage = useCallback(
    async (id: AgentId) => {
      setLoading(true);
      try {
        const page = await services.transcripts.page({ agentId: id, limit: PAGE_SIZE });
        setMessages([...page.items]);
        setBefore(page.before);
        setExhausted(page.items.length < PAGE_SIZE);
      } catch {
        setMessages([]);
      } finally {
        setLoading(false);
      }
    },
    [services],
  );

  useEffect(() => {
    if (!agentId) return;
    setMessages([]);
    setBefore(undefined);
    setExhausted(false);
    setStreamingText('');
    void loadFirstPage(agentId);
  }, [agentId, loadFirstPage]);

  const loadOlder = useCallback(async () => {
    if (loading || exhausted || !agentId || before === undefined) return;
    setLoading(true);
    try {
      const page = await services.transcripts.page({ agentId, before, limit: PAGE_SIZE });
      if (page.items.length === 0) {
        setExhausted(true);
      } else {
        setMessages((current) => [...page.items, ...current]);
        setBefore(page.before);
      }
    } catch {
      setExhausted(true);
    } finally {
      setLoading(false);
    }
  }, [services, agentId, before, loading, exhausted]);

  // 实况：追加落库消息 + 显示流式输出。
  useEffect(() => {
    const latest = events?.recent?.at(-1);
    if (!latest || latest.agentId !== agentId) return;
    if (latest.kind === 'append' && latest.appended) {
      const appended = latest.appended;
      setMessages((current) =>
        current.some((message) => message.id === appended.id) ? current : [...current, appended],
      );
      setStreamingText('');
      return;
    }
    if (latest.kind === 'update') {
      setStreamingText(latest.streaming?.parts.map((part) => part.text).join('') ?? '');
    }
  }, [events, agentId]);

  const rows: LogRow[] = useMemo(() => {
    const list: LogRow[] = messages.map((message) => ({
      key: `m${message.id}`,
      kind: 'message',
      message,
    }));
    if (streamingText) list.push({ key: 'streaming', kind: 'streaming', text: streamingText });
    if (loading) list.push({ key: 'loading', kind: 'loading', text: '加载中…' });
    return list;
  }, [messages, streamingText, loading]);

  // 行高：固定折叠高度，展开后按其估算高度。
  const heights = useMemo(
    () =>
      rows.map((row) => {
        if (row.kind !== 'message') return COLLAPSED_HEIGHT;
        if (!expanded.has(row.key)) return COLLAPSED_HEIGHT;
        const length = JSON.stringify(row.message?.content ?? '').length;
        return Math.min(EXPANDED_MAX, Math.max(COLLAPSED_HEIGHT, 40 + length * 0.55));
      }),
    [rows, expanded],
  );

  const offsets = useMemo(() => {
    const result: number[] = [];
    let total = 0;
    for (const height of heights) {
      result.push(total);
      total += height;
    }
    return { list: result, total };
  }, [heights]);

  const { start, end } = useMemo(() => {
    let startIndex = 0;
    while (startIndex < offsets.list.length && (offsets.list[startIndex] ?? 0) + (heights[startIndex] ?? 0) < scrollTop) {
      startIndex += 1;
    }
    startIndex = Math.max(0, startIndex - OVERSCAN);
    let endIndex = startIndex;
    const limit = scrollTop + viewportHeight;
    while (endIndex < offsets.list.length && (offsets.list[endIndex] ?? 0) < limit) {
      endIndex += 1;
    }
    return { start: startIndex, end: Math.min(offsets.list.length, endIndex + OVERSCAN) };
  }, [offsets, heights, scrollTop, viewportHeight]);

  const onScroll = (): void => {
    const element = viewportRef.current;
    if (!element) return;
    setScrollTop(element.scrollTop);
    stickToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    if (element.scrollTop < 240 && !exhausted) void loadOlder();
  };

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setViewportHeight(element.clientHeight));
    observer.observe(element);
    setViewportHeight(element.clientHeight);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = viewportRef.current;
    if (element && stickToBottomRef.current) element.scrollTop = element.scrollHeight;
  }, [rows.length, streamingText]);

  if (agents.length === 0) {
    return <div className="empty">还没有 Agent</div>;
  }

  return (
    <div className="log">
      <div className="log__bar">
        <label htmlFor="log-agent" className="mono">
          Agent
        </label>
        <select
          id="log-agent"
          style={{ width: 'auto', minWidth: '160px' }}
          value={agentId ?? ''}
          onChange={(event) => {
            window.location.hash = `#/logs/${event.target.value}`;
          }}
        >
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}（{agent.id}）
            </option>
          ))}
        </select>
        <span className="mono" style={{ color: 'var(--ink-3)' }}>
          {messages.length} 条已加载{exhausted ? '（已到头）' : ''}
        </span>
        <label className="mono" style={{ marginLeft: 'auto' }}>
          <input
            type="checkbox"
            checked={showModelView}
            onChange={(event) => setShowModelView(event.target.checked)}
          />{' '}
          模型视图（含 ActBlock）
        </label>
      </div>

      <div className="log__viewport" ref={viewportRef} onScroll={onScroll}>
        <div className="log__inner" style={{ height: `${offsets.total}px` }}>
          {rows.slice(start, end).map((row, index) => {
            const absolute = start + index;
            return (
              <div
                key={row.key}
                className="log__row"
                style={{
                  top: `${offsets.list[absolute] ?? 0}px`,
                  height: `${heights[absolute] ?? COLLAPSED_HEIGHT}px`,
                }}
              >
                <div className={`log__role log__role--${row.message?.role ?? 'assistant'}`}>
                  {row.kind === 'loading' ? '…' : (row.message?.role ?? 'stream')}
                  {row.message && <div className="mono">#{row.message.seq}</div>}
                </div>
                <div className="log__body">
                  {row.kind === 'loading' ? (
                    <span className="mono">{row.text}</span>
                  ) : row.kind === 'streaming' ? (
                    <>
                      <span className="mono log__streaming">正在生成</span>
                      <pre>{row.text}</pre>
                    </>
                  ) : (
                    <MessageBody
                      message={row.message as TranscriptMessage}
                      expanded={expanded.has(row.key)}
                      showModelView={showModelView}
                      onToggle={() =>
                        setExpanded((current) => {
                          const next = new Set(current);
                          if (next.has(row.key)) next.delete(row.key);
                          else next.add(row.key);
                          return next;
                        })
                      }
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function MessageBody({
  message,
  expanded,
  showModelView,
  onToggle,
}: {
  message: TranscriptMessage;
  expanded: boolean;
  showModelView: boolean;
  onToggle: () => void;
}): ReactNode {
  const parts = Array.isArray((message.content as { content?: unknown }).content)
    ? ((message.content as { content: unknown[] }).content as unknown[])
    : [];
  const text = parts
    .map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as { text: unknown }).text) : ''))
    .join('');
  const thinking = parts
    .map((part) =>
      part && typeof part === 'object' && 'thinking' in part ? String((part as { thinking: unknown }).thinking) : '',
    )
    .join('');
  const toolCalls = parts.filter(
    (part) => part && typeof part === 'object' && (part as { type?: string }).type === 'toolCall',
  );

  return (
    <>
      {!showModelView && text && <pre>{expanded ? text : truncate(text, 320)}</pre>}
      {showModelView && <pre>{expanded ? JSON.stringify(message.content, null, 2) : truncate(JSON.stringify(message.content), 320)}</pre>}
      {thinking && (
        <details>
          <summary>思维链（{thinking.length} 字）</summary>
          <pre>{thinking}</pre>
        </details>
      )}
      {toolCalls.length > 0 && (
        <details>
          <summary>工具调用（{toolCalls.length}）</summary>
          <pre>{JSON.stringify(toolCalls, null, 2)}</pre>
        </details>
      )}
      {message.role === 'tool' && (
        <details>
          <summary>工具结果详情{message.isError ? '（错误）' : ''}</summary>
          <pre>{JSON.stringify(message.content, null, 2)}</pre>
        </details>
      )}
      <button
        className="btn"
        type="button"
        style={{ justifySelf: 'start', padding: '0 var(--space-2)' }}
        onClick={onToggle}
      >
        {expanded ? '收起' : '展开完整内容'}
      </button>
    </>
  );
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}
