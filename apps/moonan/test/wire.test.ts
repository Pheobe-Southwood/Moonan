import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, Type } from '@earendil-works/pi-ai';
import {
  PROTOCOL_VERSION,
  ServerMessageDecoder,
  encodeClientMessage,
  type ClientMessage,
  type ServerMessage,
} from '@earendil-works/pi-protocol';
import {
  createServiceSubscribeCall,
  createServiceStateDecoder,
  parseServiceSubscriptionSnapshot,
  type JsonValue,
  type ServiceCall,
} from '@earendil-works/chord';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, type App } from '../src/app.js';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** 最小 WebSocket 客户端：只做本测试需要的掩码二进制帧。 */
class TestWebSocket {
  #socket: Socket;
  #buffer = new Uint8Array(0);
  #decoder = new ServerMessageDecoder();
  readonly messages: ServerMessage[] = [];
  #waiters: { predicate: (message: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];
  readonly ready: Promise<void>;

  constructor(port: number) {
    this.#socket = connect(port, '127.0.0.1');
    const key = randomBytes(16).toString('base64');
    this.ready = new Promise((resolve, reject) => {
      this.#socket.once('error', reject);
      this.#socket.once('connect', () => {
        this.#socket.write(
          [
            'GET /api/ws HTTP/1.1',
            `Host: 127.0.0.1:${port}`,
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Key: ${key}`,
            'Sec-WebSocket-Version: 13',
            'Sec-WebSocket-Protocol: moonan.v1',
            'Origin: http://127.0.0.1:21315',
            '',
            '',
          ].join('\r\n'),
        );
      });
      this.#socket.on('data', (chunk: Buffer) => {
        const text = chunk.toString('latin1');
        if (text.startsWith('HTTP/1.1')) {
          const expected = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
          if (!text.includes(expected)) {
            reject(new Error(`握手响应不正确：${text.slice(0, 200)}`));
            return;
          }
          const headerEnd = chunk.indexOf('\r\n\r\n');
          const rest = chunk.subarray(headerEnd + 4);
          if (rest.length > 0) this.#onFrameBytes(new Uint8Array(rest));
          resolve();
          return;
        }
        this.#onFrameBytes(new Uint8Array(chunk));
      });
    });
  }

  #onFrameBytes(bytes: Uint8Array): void {
    const merged = new Uint8Array(this.#buffer.length + bytes.length);
    merged.set(this.#buffer, 0);
    merged.set(bytes, this.#buffer.length);
    this.#buffer = merged;
    for (;;) {
      const frame = this.#takeFrame();
      if (!frame) return;
      if (frame.opcode !== 0x2) continue;
      for (const message of this.#decoder.push(frame.payload)) {
        this.messages.push(message);
        for (const waiter of [...this.#waiters]) {
          if (waiter.predicate(message)) {
            this.#waiters = this.#waiters.filter((item) => item !== waiter);
            waiter.resolve(message);
          }
        }
      }
    }
  }

  #takeFrame(): { opcode: number; payload: Uint8Array } | undefined {
    const buffer = this.#buffer;
    if (buffer.length < 2) return undefined;
    const opcode = (buffer[0] ?? 0) & 0x0f;
    let length = (buffer[1] ?? 0) & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < 4) return undefined;
      length = ((buffer[2] ?? 0) << 8) | (buffer[3] ?? 0);
      offset = 4;
    } else if (length === 127) {
      if (buffer.length < 10) return undefined;
      let big = 0n;
      for (let index = 0; index < 8; index += 1) big = (big << 8n) | BigInt(buffer[2 + index] ?? 0);
      length = Number(big);
      offset = 10;
    }
    if (buffer.length < offset + length) return undefined;
    const payload = buffer.subarray(offset, offset + length);
    this.#buffer = buffer.subarray(offset + length);
    return { opcode, payload: new Uint8Array(payload) };
  }

  send(message: ClientMessage): void {
    const frame = encodeClientMessage(message);
    const mask = randomBytes(4);
    const header = new Uint8Array(2 + 4);
    header[0] = 0x82;
    if (frame.length < 126) {
      header[1] = 0x80 | frame.length;
      header[2] = mask[0] ?? 0;
      header[3] = mask[1] ?? 0;
      header[4] = mask[2] ?? 0;
      header[5] = mask[3] ?? 0;
      this.#write(header, frame, mask);
      return;
    }
    const extended = new Uint8Array(4 + 4);
    extended[0] = 0x82;
    extended[1] = 0x80 | 126;
    extended[2] = (frame.length >> 8) & 0xff;
    extended[3] = frame.length & 0xff;
    extended.set(mask, 4);
    this.#write(extended, frame, mask);
  }

  #write(header: Uint8Array, payload: Uint8Array, mask: Uint8Array): void {
    const masked = new Uint8Array(payload.length);
    for (let index = 0; index < payload.length; index += 1) {
      masked[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
    }
    const out = new Uint8Array(header.length + masked.length);
    out.set(header, 0);
    out.set(masked, header.length);
    this.#socket.write(out);
  }

  next(predicate: (message: ServerMessage) => boolean, timeoutMs = 5000): Promise<ServerMessage> {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待消息超时')), timeoutMs);
      this.#waiters.push({
        predicate,
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      });
    });
  }

  close(): void {
    this.#socket.destroy();
  }
}

async function requestService(
  client: TestWebSocket,
  serverId: string,
  call: ServiceCall,
  id = randomUUID(),
): Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }> {
  client.send({ type: 'request', id, target: { serverId }, call: call as unknown as JsonValue });
  const response = await client.next(
    (message) => message.type === 'response' && message.id === id,
  );
  if (response.type !== 'response') throw new Error('不是 response 帧');
  return response.ok
    ? { ok: true, value: response.result }
    : { ok: false, error: response.error };
}

describe('WebSocket → pi-server → chord 服务', () => {
  let app: App | undefined;
  let home: string | undefined;
  let client: TestWebSocket | undefined;

  before(async () => {
    home = mkdtempSync(join(tmpdir(), 'moonan-wire-'));
    app = await createApp({ home, port: 0, logLevel: 'warn' });
    const port = Number(new URL(app.url).port);
    client = new TestWebSocket(port);
    await client.ready;
  });

  after(async () => {
    client?.close();
    await app?.close();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it('完成握手并拿到 serverId', async () => {
    if (!client) throw new Error('客户端未就绪');
    client.send({ type: 'hello', version: PROTOCOL_VERSION });
    const hello = await client.next((message) => message.type === 'hello' || message.type === 'hello_error');
    assert.equal(hello.type, 'hello', `握手应成功，实际：${JSON.stringify(hello)}`);
    if (hello.type === 'hello') {
      assert.equal(hello.version, PROTOCOL_VERSION);
      assert.ok(hello.serverId.length > 0);
    }
  });

  it('通过 chord 服务调用拿到 Agent 与 provider 列表', async () => {
    if (!client || !app) throw new Error('未就绪');
    const serverId = app.store.settings.get('host.serverId');
    assert.ok(serverId, '应有 serverId');

    const agents = await requestService(client, serverId, {
      serviceId: 'moonan.agents',
      member: 'list',
      args: [],
    });
    assert.equal(agents.ok, true, `agents.list 应成功：${JSON.stringify(agents.error)}`);
    const list = agents.value as { id: string; name: string }[];
    assert.ok(list.some((agent) => agent.id === 'main'), '应能看到主 Agent');

    const providers = await requestService(client, serverId, {
      serviceId: 'moonan.providers',
      member: 'list',
      args: [],
    });
    assert.equal(providers.ok, true);
    assert.ok((providers.value as unknown[]).length > 10, '应能列出内置 provider');
  });

  it('订阅 replicated state 并在变化后收到增量更新', async () => {
    if (!client || !app) throw new Error('未就绪');
    const serverId = app.store.settings.get('host.serverId');
    if (!serverId) throw new Error('缺少 serverId');

    const subscriptionId = 'sub-1';
    const subscribed = await requestService(
      client,
      serverId,
      createServiceSubscribeCall(subscriptionId, 'moonan.agents', 'singleton'),
    );
    assert.equal(subscribed.ok, true, `订阅应成功：${JSON.stringify(subscribed.error ?? subscribed.value)}`);

    const decoder = createServiceStateDecoder();
    const snapshot = decoder.decodeSnapshot(
      parseServiceSubscriptionSnapshot(subscribed.value) as never,
    );
    const agentsState = snapshot.instances
      .flatMap((instance) => instance.members)
      .find((member) => member.name === 'state');
    assert.ok(agentsState, '订阅快照里应有 state 成员');

    // 触发一次状态变化（发送一条只写历史的消息不会触发生成，但会改变 sidebars）。
    await app.services.agents.update(
      { agentId: 'main', patch: { description: '订阅测试' } },
      undefined,
    );

    const update = await client.next(
      (message) => message.type === 'service_update' && message.subscriptionId === subscriptionId,
    );
    assert.equal(update.type, 'service_update');
  });

  it('未知服务返回可读错误', async () => {
    if (!client || !app) throw new Error('未就绪');
    const serverId = app.store.settings.get('host.serverId');
    if (!serverId) throw new Error('缺少 serverId');
    const result = await requestService(client, serverId, {
      serviceId: 'moonan.nope',
      member: 'list',
      args: [],
    });
    assert.equal(result.ok, false);
    assert.ok(result.error, '应有错误信息');
    assert.ok(
      result.error.message.length > 0 || result.error.code.length > 0,
      '错误应可读',
    );
  });
});

describe('端到端：faux 模型驱动一轮 act 调用', () => {
  it('历史里只保留一份 ActBlock，且侧栏收到角色消息', async () => {
    const home = mkdtempSync(join(tmpdir(), 'moonan-e2e-'));
    const app = await createApp({ home, port: 0, logLevel: 'warn' });
    try {
      const faux = fauxProvider({ provider: 'faux-e2e' });
      app.models.setProvider(faux.provider);
      faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall('act', { action: 'conversation.send_message', text: '（她抬头看了看天）' })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage([fauxText('收到')]),
      ]);

      await app.services.agents.update(
        { agentId: 'main', patch: { model: { provider: 'faux-e2e', modelId: 'faux-1' } } },
        undefined,
      );
      await app.services.agents.send(
        { agentId: 'main', kind: 'followUp', text: '开始吧' },
        undefined,
      );
      await app.services.manager.waitForIdle('main');

      const transcript = app.services.transcripts;
      const page = await transcript.page({ agentId: 'main', limit: 100 }, undefined);
      const dump = JSON.stringify(page.items.map((item) => item.content));
      if (page.items.length === 0) {
        throw new Error(`会话里没有任何消息；sidebars=${JSON.stringify(app.services.manager.sidebars('main'))}`);
      }
      assert.match(dump, /抬头看了看天/, '角色消息应写进历史');
      assert.doesNotMatch(dump, /moonan:act-block/, '历史里不应出现 ActBlock');

      const sidebars = app.services.manager.sidebars('main');
      assert.equal(sidebars.length, 1);
      assert.equal(sidebars[0]?.kind, 'character');
    } finally {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

export { TestWebSocket };
