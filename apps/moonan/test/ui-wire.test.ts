import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createApp, type App } from '../src/app.js';
import {
  ClientAgentsToken,
  ClientStateToken,
  ClientTranscriptsToken,
  type ClientServices,
} from '@moonan/plugin-sdk';
import { createWire } from '../../../packages/ui/src/transport/wire.js';

/**
 * 浏览器侧 wire 的端到端验证。
 *
 * 这里跑的是 UI 真正使用的那份代码（`packages/ui/src/transport/wire.ts`）：
 * 自研 WebSocket 帧 + pi-protocol 信封 + chord 远端服务绑定。
 * 用 Node 的全局 WebSocket 充当浏览器，因此覆盖了真实链路。
 */
describe('WebUI wire（浏览器代码路径）', () => {
  let app: App | undefined;
  let home: string | undefined;

  before(async () => {
    home = mkdtempSync(join(tmpdir(), 'moonan-uiwire-'));
    app = await createApp({ home, port: 0, logLevel: 'warn' });
  });

  after(async () => {
    await app?.close();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it('握手后能通过远端绑定调用服务并订阅状态', async () => {
    if (!app) throw new Error('app 未启动');
    const url = app.url.replace('http://', 'ws://');
    const notices: string[] = [];
    const wire = createWire({ url: `${url}/api/ws`, protocols: ['moonan.v1'], onNotice: (m) => notices.push(m) });

    try {
      await wire.whenReady();
      assert.ok(wire.serverId, '应拿到 serverId');

      const ctx = BACKGROUND_CONTEXT;
      const agents = wire.services.use(ClientAgentsToken) as unknown as ClientServices['agents'];
      const list = await agents.list(ctx);
      assert.ok(list.some((agent) => agent.id === 'main'), '应能列出主 Agent');

      const state = wire.services.use(ClientStateToken) as unknown as ClientServices['state'];
      const current = await state.get(ctx);
      assert.equal(typeof current.nickname, 'string');

      // 订阅：一次真实的服务更新必须到达客户端。
      const seen: unknown[] = [];
      const unsubscribe = state.state.subscribe((value) => seen.push(value));
      await app.services.hostState.set({ patch: { nickname: '订阅测试' } }, ctx);
      const deadline = Date.now() + 4000;
      while (seen.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      unsubscribe();
      assert.ok(seen.length > 0, `订阅应收到更新；notices=${notices.join(' | ')}`);
      assert.equal(notices.length, 0, `不应有协议错误：${notices.join(' | ')}`);
    } finally {
      wire.close();
    }
  });

  it('浏览器客户端能触发一轮生成并从日志流看到 append 事件', async () => {
    if (!app) throw new Error('app 未启动');
    const faux = fauxProvider({ provider: 'faux-ui' });
    app.models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('act', { action: 'conversation.send_message', text: '来自 UI 测试' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('好的')]),
    ]);
    await app.services.agents.update(
      { agentId: 'main', patch: { model: { provider: 'faux-ui', modelId: 'faux-1' } } },
      BACKGROUND_CONTEXT,
    );

    const url = app.url.replace('http://', 'ws://');
    const wire = createWire({ url: `${url}/api/ws`, protocols: ['moonan.v1'] });
    try {
      await wire.whenReady();
      const ctx = BACKGROUND_CONTEXT;
      const transcripts = wire.services.use(ClientTranscriptsToken) as unknown as ClientServices['transcripts'];
      const events: { recent?: { kind: string }[] }[] = [];
      const unsubscribe = transcripts.events.subscribe((value) => events.push(value));

      await app.services.agents.send(
        { agentId: 'main', kind: 'followUp', text: '开始' },
        BACKGROUND_CONTEXT,
      );
      await app.services.manager.waitForIdle('main');

      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const hasAppend = events.some((value) => value.recent?.some((event) => event.kind === 'append'));
        if (hasAppend) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      unsubscribe();
      assert.ok(
        events.some((value) => value.recent?.some((event) => event.kind === 'append')),
        '日志流应看到 append 事件',
      );
    } finally {
      wire.close();
    }
  });
});
