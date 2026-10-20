import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, type App } from '../src/app.js';

let app: App | undefined;
let home: string | undefined;

after(async () => {
  await app?.close();
  if (home) rmSync(home, { recursive: true, force: true });
});

describe('Moonan 进程骨架', () => {
  it('能在空数据目录上启动，并登记全部官方插件', async () => {
    home = mkdtempSync(join(tmpdir(), 'moonan-app-'));
    app = await createApp({ home, port: 0, logLevel: 'warn' });

    const health = await fetch(`${app.url}/api/health`).then((r) => r.json() as Promise<{ ok: boolean }>);
    assert.equal(health.ok, true);

    const meta = (await fetch(`${app.url}/api/meta`).then((r) => r.json())) as {
      plugins: string[];
      agents: string[];
    };
    for (const id of [
      '@moonan/plugin-provider-panel',
      '@moonan/plugin-agent-manager',
      '@moonan/plugin-act',
      '@moonan/plugin-conversation',
      '@moonan/plugin-log-window',
    ]) {
      assert.ok(meta.plugins.includes(id), `应登记插件 ${id}`);
    }
    assert.ok(meta.agents.includes('main'), '主 Agent 应已注册');
  });

  it('内置提供商面板能看到 pi-ai 的内置 provider', async () => {
    if (!app) throw new Error('app 未启动');
    const agents = app.services.manager.definitions();
    const main = agents.find((agent) => agent.id === 'main');
    assert.ok(main, '应有主 Agent');
    assert.match(main.systemPrompt, /\{\{botname\}\}/);
    assert.match(main.systemPrompt, /角色扮演场景的导演/);

    const providers = await app.services.providers.list(undefined);
    assert.ok(providers.length > 10, `应能列出内置 provider，实际 ${providers.length}`);
  });
});
