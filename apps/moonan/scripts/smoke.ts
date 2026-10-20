/**
 * 无 API Key 冒烟：用 pi-ai 的 faux provider 走完「配置 → 变量渲染 → act → 对话窗 → 日志」全流程。
 *
 * 用途：CI 与"我刚 clone 下来能不能跑"。真实模型请用 WebUI（在「提供商」里填 Key）。
 *
 *   npx tsx scripts/smoke.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
} from '@earendil-works/pi-ai';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { ACT_BLOCK_MARKER } from '@moonan/plugin-sdk';
import { createApp } from '../src/app.js';

const home = mkdtempSync(join(tmpdir(), 'moonan-smoke-'));
const app = await createApp({ home, port: 0, logLevel: 'warn' });
const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean): void => {
  checks.push([label, ok]);
  process.stdout.write(`${ok ? '✔' : '✘'} ${label}\n`);
};

try {
  process.stdout.write(`\n数据目录：${home}\n服务器：${app.url}\n\n`);

  // 1. 插件与主 Agent
  const plugins = app.plugins.map((entry) => entry.id);
  check('五个官方插件均已登记', plugins.filter((id) => id.startsWith('@moonan/plugin-')).length === 5);
  check('内置主 Agent 已注册', app.services.manager.definitions().some((agent) => agent.id === 'main'));

  // 2. 一个真实的 provider 列表（pi-ai 内置）
  const providers = await app.services.providers.list(BACKGROUND_CONTEXT);
  check(`内置 provider 可列出（${providers.length} 个）`, providers.length > 10);

  // 3. 换上 faux 模型，并把用户最常编辑的两个变量改掉
  const faux = fauxProvider({ provider: 'faux-smoke' });
  app.models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall('act', { action: 'conversation.send_message', text: '（她抬头看了看天）' })],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage([fauxText('（沉默了一会儿）嗯。')]),
  ]);
  await app.services.agents.update(
    {
      agentId: 'main',
      patch: {
        model: { provider: 'faux-smoke', modelId: 'faux-1' },
        variables: { botname: '小雨', soul: '安静、观察力强，不轻易表露情绪' },
      },
    },
    BACKGROUND_CONTEXT,
  );

  // 4. 捕获每次请求真正发给 provider 的上下文
  const modelViews: string[] = [];
  const instance = app.services.manager.instance('main') as unknown as {
    constructor: unknown;
  };
  void instance;
  const original = app.models.streamSimple.bind(app.models);
  (app.models as unknown as { streamSimple: unknown }).streamSimple = (
    model: Model<never>,
    context: TranscriptContext,
    options: SimpleStreamOptions,
  ) => {
    modelViews.push(JSON.stringify(context.messages));
    return original(model, context, options);
  };

  // 5. 打开对话窗的通知（排队等级）+ 用户消息
  await app.services.agents.send(
    { agentId: 'main', kind: 'steer', text: '「你」通过 webui 打开了和你的对话窗口' },
    BACKGROUND_CONTEXT,
  );
  await app.services.agents.send({ agentId: 'main', kind: 'followUp', text: '开始吧' }, BACKGROUND_CONTEXT);
  await app.services.manager.waitForIdle('main');

  check('模型视图里 system prompt 的 {{botname}} 已替换', (modelViews[0] ?? '').includes('小雨'));
  check('模型视图里 {{soul}} 已替换', (modelViews[0] ?? '').includes('安静、观察力强'));
  // 注意：`act` 工具的 description 里也有一份 ActBlock（那是有意的，给模型看工具说明）。
  // 这里只数「追加在消息末尾」的块，也就是真正被摘挂的那一份。
  check(
    '每次请求恰好一份追加在消息末尾的 ActBlock',
    modelViews.length > 0 &&
      modelViews.every((view) => countAppendedBlocks(view) === 1),
  );

  const sidebars = app.services.manager.sidebars('main');
  check('角色消息进入对话窗侧栏', sidebars.some((item) => item.kind === 'character'));

  const page = await app.services.transcripts.page({ agentId: 'main', limit: 100 }, BACKGROUND_CONTEXT);
  const dump = JSON.stringify(page.items.map((item) => item.content));
  check('历史落库且不含 ActBlock', page.items.length > 0 && !dump.includes(ACT_BLOCK_MARKER));
  check('打开对话窗的通知已进入历史', dump.includes('打开了和你的对话窗口'));

  process.stdout.write(`（共捕获 ${modelViews.length} 次请求的模型视图）\n`);

  // 6. 自定义 provider 的增删
  await app.services.providers.setCustom(
    {
      record: {
        id: 'smoke-local',
        name: 'Smoke 本地模型',
        baseUrl: 'http://127.0.0.1:11434/v1',
        api: 'openai-completions',
        models: [{ id: 'qwen3', name: 'Qwen3' }],
      },
    },
    BACKGROUND_CONTEXT,
  );
  const afterAdd = await app.services.providers.list(BACKGROUND_CONTEXT);
  check('自定义 provider 可新增', afterAdd.some((provider) => provider.id === 'smoke-local'));
  await app.services.providers.removeCustom({ providerId: 'smoke-local' }, BACKGROUND_CONTEXT);
  const afterRemove = await app.services.providers.list(BACKGROUND_CONTEXT);
  check('自定义 provider 可删除', !afterRemove.some((provider) => provider.id === 'smoke-local'));
} finally {
  await app.close();
  rmSync(home, { recursive: true, force: true });
}

const failed = checks.filter(([, ok]) => !ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} 项通过\n`);
process.exit(failed.length === 0 ? 0 : 1);

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** 解析出模型视图的 JSON，数「末尾挂着 ActBlock」的消息条数。 */
function countAppendedBlocks(view: string): number {
  const messages = JSON.parse(view) as { content?: unknown }[];
  let total = 0;
  for (const message of messages) {
    const content = message.content;
    const parts = Array.isArray(content) ? content : [content];
    const last = parts.at(-1);
    const text =
      typeof last === 'string'
        ? last
        : typeof (last as { text?: unknown } | undefined)?.text === 'string'
          ? (last as { text: string }).text
          : '';
    if (text.includes(ACT_BLOCK_MARKER)) total += 1;
  }
  return total;
}
