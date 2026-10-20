import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  Type,
} from '@earendil-works/pi-ai';
import type { ActionInfo, AgentDefinition, MoonanContext, PluginTool } from '@moonan/plugin-sdk';
import { ACT_BLOCK_MARKER } from '@moonan/plugin-sdk';
import { createStore, type Store } from '../src/store/index.js';
import { AgentInstance } from '../src/runtime/agent-instance.js';

const ACTION_ID = 'conversation.send_message';

interface Harness {
  readonly store: Store;
  readonly instance: AgentInstance;
  readonly requests: string[];
  readonly invocations: { actionId: string; args: unknown }[];
  readonly sidebars: string[];
  readonly dir: string;
  dispose(): void;
}

function makeDefinition(): AgentDefinition {
  return {
    id: 'main',
    name: '{{botname}}',
    description: '在这里配置角色的人设',
    systemPrompt: '角色：{{botname}}\n人设：{{soul}}',
    variables: { botname: '小雨', soul: '安静、观察力强' },
    model: { provider: 'faux-spike', modelId: 'faux-1' },
    scope: 'persisted',
    ui: { dialog: true },
    tools: { pluginTools: true, act: true },
  };
}

async function makeHarness(actions: readonly ActionInfo[]): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'moonan-test-'));
  const store = createStore(join(dir, 'moonan.db'));

  const faux = fauxProvider({ provider: 'faux-spike' });
  const models = createModels();
  models.setProvider(faux.provider);

  const requests: string[] = [];
  const invocations: { actionId: string; args: unknown }[] = [];
  const sidebars: string[] = [];

  const pluginTools: PluginTool[] = [
    {
      name: 'lookup_scene',
      label: 'Lookup scene',
      description: '查询当前场景信息',
      parameters: Type.Object({}),
      execute: async () => ({ ok: true, text: '场景：雨夜的天台' }),
    },
  ];

  const instance = new AgentInstance({
    definition: makeDefinition(),
    models,
    store,
    streamOptions: { apiKey: 'faux' },
    onModelView: (_agentId, messages) => {
      // `transformContext` 渲染出的就是真正发给 provider 的上下文。
      requests.push(JSON.stringify(messages));
    },
    callbacks: {
      resolveActions: async () => actions,
      resolvePluginTools: async () => pluginTools,
      invokeAction: async (agentId, actionId, args, _context: MoonanContext) => {
        invocations.push({ actionId, args });
        return { ok: true, text: `已执行 ${actionId}` };
      },
      emitEvent: (event) => {
        if (event.kind === 'append' && event.appended?.role === 'user') {
          const content = event.appended.content as { content?: { text?: string }[] };
          const text = content.content?.[0]?.text ?? '';
          if (text.startsWith('[character]')) sidebars.push(text);
        }
      },
      onPhase: () => undefined,
    },
  });

  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall('act', { action: ACTION_ID, text: '你好呀' })],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage([fauxText('收到')]),
    fauxAssistantMessage([fauxText('第二轮回复')]),
  ]);

  return {
    store,
    instance,
    requests,
    invocations,
    sidebars,
    dir,
    dispose: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const actions = (): ActionInfo[] => [
  {
    id: ACTION_ID,
    title: '发送对话消息',
    description: '向 WebUI 对话框发送一条角色消息',
    parameters: Type.Object({ text: Type.String() }),
    available: true,
  },
];

function countBlocks(haystack: string): number {
  return haystack.split(ACT_BLOCK_MARKER).length - 1;
}

/** ActBlock 还会出现在 `act` 工具的 description 里（那是有意的），这里只数「追加在消息末尾」的块。 */
function countAppendedBlocks(messages: readonly unknown[]): number {
  let total = 0;
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    const parts = Array.isArray(content) ? content : [content];
    const last = parts.at(-1);
    const text =
      typeof last === 'string'
        ? last
        : typeof (last as { text?: unknown } | undefined)?.text === 'string'
          ? ((last as { text: string }).text)
          : '';
    if (text.includes(ACT_BLOCK_MARKER)) total += 1;
  }
  return total;
}

describe('AgentInstance', () => {
  let harness: Harness | undefined;

  beforeEach(() => {
    harness = undefined;
  });

  afterEach(() => {
    harness?.dispose();
  });

  it('变量替换进 system prompt，且历史里不落 ActBlock', async () => {
    harness = await makeHarness(actions());
    harness.instance.refreshSystemPrompt();

    harness.instance.followUp('开始吧');
    await harness.instance.kick();
    await harness.instance.waitForIdle();

    assert.equal(harness.invocations.length, 1, 'act 应该真的执行了一次');
    assert.equal(harness.invocations[0]?.actionId, ACTION_ID);
    assert.deepEqual(harness.invocations[0]?.args, { text: '你好呀' }, 'action 参数应是扁平的同层字段');

    const first = harness.requests[0] ?? '';
    assert.match(first, /小雨/, 'system prompt 里的 {{botname}} 应被替换');
    assert.match(first, /安静、观察力强/, 'system prompt 里的 {{soul}} 应被替换');

    // 每一次发往 provider 的请求里，**追加在消息末尾**的 ActBlock 都恰好只有一份。
    for (const [index, request] of harness.requests.entries()) {
      const messages = JSON.parse(request) as unknown[];
      assert.equal(
        countAppendedBlocks(messages),
        1,
        `第 ${index + 1} 次请求应恰好一份追加的 ActBlock`,
      );
    }

    // 落库的是原文：历史里不含 ActBlock。
    for (const message of harness.store.transcripts.all('main')) {
      assert.equal(countBlocks(JSON.stringify(message.content)), 0, '历史不应含 ActBlock');
    }
  });

  it('steer 不打断进行中的 tool 调用，在回合结束后注入', async () => {
    harness = await makeHarness(actions());
    harness.instance.followUp('开始吧');
    const running = harness.instance.kick();
    // 第一轮还在跑的时候投入一条 steer（模拟「点开对话窗」的通知）。
    harness.instance.steer('「张三」通过 webui 打开了和你的对话窗口');
    await running;
    await harness.instance.waitForIdle();

    const joined = harness.requests.join('\n');
    assert.match(joined, /打开了和你的对话窗口/, 'steer 消息最终应被注入上下文');

    // 排队等级的真正含义：注入点必须在**某个已完成回合的 tool result 之后**，
    // 而不是在运行开始时就插到队首（那会打断进行中的输出）。
    const viewWithSteer = harness.requests.find((request) => request.includes('打开了和你的对话窗口'));
    assert.ok(viewWithSteer, '应有一次请求包含 steer 消息');
    const messages = JSON.parse(viewWithSteer) as { role: string; content?: unknown }[];
    const steerIndex = messages.findIndex((message) => JSON.stringify(message).includes('打开了和你的对话窗口'));
    const toolResultIndex = messages.findIndex((message) => message.role === 'toolResult');
    assert.ok(toolResultIndex >= 0, 'steer 注入前应存在 tool result');
    assert.ok(
      steerIndex > toolResultIndex,
      `steer 必须排在本轮的 tool result 之后（steer=${steerIndex}, toolResult=${toolResultIndex}）`,
    );
    assert.equal(messages[0]?.role, 'system', 'steer 不该插到 system 之前');
    // 且它确实落进了历史。
    const texts = harness.store.transcripts
      .all('main')
      .map((m) => JSON.stringify(m.content))
      .join('\n');
    assert.match(texts, /打开了和你的对话窗口/);
  });

  it('write 只写历史，不触发生成', async () => {
    harness = await makeHarness(actions());
    const before = harness.requests.length;
    harness.instance.write({ kind: 'character', text: '（她抬头看了看天）' });
    await harness.instance.waitForIdle();
    assert.equal(harness.requests.length, before, 'write 不应产生任何 provider 请求');

    const stored = harness.store.transcripts.all('main');
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.role, 'user');
  });

  it('重新 hydrate 后上下文与落库一致', async () => {
    harness = await makeHarness(actions());
    harness.instance.followUp('开始吧');
    await harness.instance.kick();
    await harness.instance.waitForIdle();
    const persisted = harness.store.transcripts.all('main');

    const revived = new AgentInstance({
      definition: makeDefinition(),
      models: createModels(),
      store: harness.store,
      callbacks: {
        resolveActions: async () => [],
        resolvePluginTools: async () => [],
        invokeAction: async () => ({ ok: true, text: '' }),
        emitEvent: () => undefined,
        onPhase: () => undefined,
      },
    });
    revived.hydrate();
    // 首条 system 为即时渲染，其余消息条数应与落库一致。
    assert.equal(revived.messageCount, persisted.length + 1);
  });
});
