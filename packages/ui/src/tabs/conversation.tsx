import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {AgentDefinition, AgentId, AgentInfo, ClientServices, HostState, MessageRole, TranscriptMessage} from '@moonan/plugin-sdk';
import type { Route } from '../shell.js';
import { useReplicatedValue } from '../services.js';

const BATCH_WINDOW_MS = 2000;

interface PendingMessage {
  readonly text: string;
  readonly at: number;
}

/**
 * 对话窗。
 *
 * - 每个 Agent 一个入口（`ui.dialog` 为 false 的 Agent 不出现在这里）。
 * - 进入某个 Agent 的对话窗 → 排队等级的通知（steer），等当前输出/tool 调用结束才注入。
 * - 用户消息：2 秒静默合并，期间再发不会延长时间；合并后作为**一条** steer 消息发出，
 *   每条附上时间戳。
 */
export function Conversation({
  services,
  route,
  nickname,
}: {
  services: ClientServices;
  route: Route;
  nickname: string;
}): ReactNode {
  const published = useReplicatedValue(services.agents.state);
  const hostState = useReplicatedValue(services.state.state) as HostState | undefined;
  const [agents, setAgents] = useState<readonly AgentInfo[]>([]);
  const [transcript, setTranscript] = useState<TranscriptMessage[]>([]);
  const [streaming, setStreaming] = useState<string>('');
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const timerRef = useRef<number | undefined>(undefined);
  const streamRef = useRef<HTMLDivElement | null>(null);

  const dialogs = useMemo(() => agents.filter((agent) => agent.ui.dialog), [agents]);
  const activeId = route.param ?? dialogs[0]?.id;

  useEffect(() => {
    void services.agents
      .list()
      .then(setAgents)
      .catch(() => undefined);
  }, [services]);

  useEffect(() => {
    if (published?.agents) setAgents(published.agents);
  }, [published]);

  // 切换 Agent：拉取历史 + 记录「打开了对话窗口」（排队等级，不打断当前输出）。
  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    void services.transcripts
      .page({ agentId: activeId, limit: 200 })
      .then((page) => {
        if (!cancelled) setTranscript([...page.items]);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [services, activeId]);

  const notifiedRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!activeId) return;
    if (notifiedRef.current === activeId) return;
    notifiedRef.current = activeId;
    void services.state
      .set({ patch: { openDialog: activeId, dialogOpenedAt: Date.now() } })
      .then(() =>
        services.agents.send({
          agentId: activeId,
          kind: 'steer',
          text: `「${nickname}」通过 webui 打开了和你的对话窗口`,
        }),
      )
      .catch(() => undefined);
  }, [services, activeId, nickname]);

  // 实况流：追加落库消息、显示流式输出。
  const events = useReplicatedValue(services.transcripts.events);
  useEffect(() => {
    const latest = events?.recent?.at(-1);
    if (!latest || latest.agentId !== activeId) return;
    if (latest.kind === 'append' && latest.appended) {
      setTranscript((current) =>
        current.some((message) => message.id === latest.appended?.id)
          ? current
          : [...current, latest.appended as TranscriptMessage],
      );
      setStreaming('');
      return;
    }
    if (latest.kind === 'update') {
      const text = latest.streaming?.parts.map((part) => part.text).join('') ?? '';
      setStreaming(text);
    }
  }, [events, activeId]);

  useEffect(() => {
    streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight });
  }, [transcript.length, streaming]);

  // 2 秒静默合并。
  useEffect(() => {
    if (pending.length === 0) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      const batch = pending;
      setPending([]);
      if (!activeId || batch.length === 0) return;
      const lines = batch
        .map((item) => `[${formatTime(item.at)}] ${item.text}`)
        .join('\n');
      void services.agents
        .send({
          agentId: activeId,
          kind: 'steer',
          text: `「${nickname}」通过 webui 给你发送了 ${batch.length} 条消息：\n${lines}`,
        })
        .catch(() => undefined);
    }, BATCH_WINDOW_MS);
    return () => window.clearTimeout(timerRef.current);
  }, [pending, activeId, services, nickname]);

  const submit = (): void => {
    const text = draft.trim();
    if (text.length === 0) return;
    setDraft('');
    // 只有「第一批」才开启计时窗口：后续消息不延长时间（2 秒内合并完毕）。
    setPending((current) => [...current, { text, at: Date.now() }]);
  };

  if (dialogs.length === 0) {
    return <div className="empty">还没有可对话的 Agent。先在「Agent」Tab 里创建一个。</div>;
  }

  return (
    <div className="chat">
      <div className="chat__agents">
        {dialogs.map((agent) => (
          <button
            key={agent.id}
            className="chat__agent"
            type="button"
            aria-selected={agent.id === activeId}
            onClick={() => {
              window.location.hash = `#/conversation/${agent.id}`;
            }}
          >
            <span>{agent.ui.icon ?? '◆'}</span>
            <span>{agent.name}</span>
            {published?.runtime?.[agent.id]?.phase !== undefined &&
              published.runtime[agent.id]?.phase !== 'idle' && (
                <span className="tag tag--accent">{phaseLabel(published.runtime[agent.id]?.phase ?? 'idle')}</span>
              )}
          </button>
        ))}
      </div>

      <div className="chat__stream" ref={streamRef}>
        {transcript.length === 0 && !streaming && <div className="empty">还没有消息</div>}
        {transcript.map((message) => {
          const kind = classify(message);
          if (kind === 'hidden') return null;
          return (
            <div key={message.id} className={`bubble bubble--${kind}`}>
              <div className="bubble__meta">
                {kind === 'right' ? nickname : (kind === 'system' ? '系统' : '角色')} ·{' '}
                {formatTime(message.createdAt)}
              </div>
              {renderText(message)}
            </div>
          );
        })}
        {streaming.length > 0 && (
          <div className="bubble bubble--left">
            <div className="bubble__meta">角色 · 正在生成</div>
            {streaming}
          </div>
        )}
        {pending.length > 0 && (
          <div className="bubble bubble--right" style={{ opacity: 0.6 }}>
            <div className="bubble__meta">{nickname} · 待发送（{pending.length}）</div>
            {pending.map((item) => item.text).join('\n')}
          </div>
        )}
      </div>

      <div className="chat__compose">
        <textarea
          value={draft}
          placeholder="输入消息，2 秒内的连续消息会合并成一条"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <button className="btn btn--primary" type="button" onClick={submit} disabled={draft.trim().length === 0}>
          发送
        </button>
      </div>
    </div>
  );
}

function classify(message: TranscriptMessage): 'left' | 'right' | 'system' | 'hidden' {
  const role: MessageRole = message.role;
  const text = extractText(message);
  if (role === 'system') return 'hidden';
  if (role === 'tool') return 'hidden';
  if (role === 'user') {
    if (text.startsWith('[character]')) return 'left';
    if (text.startsWith('[system]')) return 'system';
    return 'right';
  }
  return 'left';
}

function renderText(message: TranscriptMessage): string {
  const text = extractText(message);
  if (text.startsWith('[character]')) return text.replace('[character]', '').trim();
  if (text.startsWith('[system]')) return text.replace('[system]', '').trim();
  // 模型视图里的 ActBlock 不显示在对话里。
  return text.replace(/<!--moonan:act-block-->[\s\S]*$/, '').trim();
}

function extractText(message: TranscriptMessage): string {
  const content = (message.content as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && 'text' in part) return String((part as { text: unknown }).text);
      if (part && typeof part === 'object' && 'thinking' in part) return '';
      return '';
    })
    .join('');
}

function formatTime(value: number): string {
  const date = new Date(value);
  const pad = (input: number): string => String(input).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case 'streaming':
      return '生成中';
    case 'tool':
      return '工具中';
    case 'error':
      return '错误';
    default:
      return '空闲';
  }
}

export type { AgentDefinition, AgentId };
