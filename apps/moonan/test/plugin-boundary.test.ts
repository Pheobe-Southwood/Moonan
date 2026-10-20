import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFacetHost, createStaticFacetLoader, combineFacetLoaders } from '@earendil-works/chord';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import type { MoonanPluginNode } from '@moonan/plugin-sdk';
import { createHostBundle } from '../src/services/index.js';
import { createLogger } from '../src/runtime/logger.js';
import { createStore } from '../src/store/index.js';

/** 按文件路径加载插件包的编译产物，模拟"这个包不存在"。 */
async function loadPlugin(name: string): Promise<MoonanPluginNode | undefined> {
  const entry = resolve(import.meta.dirname, `../../../packages/plugins/${name}/dist/index.js`);
  try {
    const module_ = (await import(pathToFileURL(entry).href)) as Record<string, unknown>;
    const value = Object.values(module_).find(
      (candidate) =>
        typeof candidate === 'object' &&
        candidate !== null &&
        'setup' in candidate &&
        'id' in candidate,
    );
    return value as MoonanPluginNode | undefined;
  } catch {
    return undefined;
  }
}

const ALL = ['provider-panel', 'agent-manager', 'act', 'conversation', 'log-window'];

async function bootWith(pluginNames: readonly string[]): Promise<{
  plugins: string[];
  actions: string[];
  close(): Promise<void>;
}> {
  const home = mkdtempSync(join(tmpdir(), 'moonan-boundary-'));
  const log = createLogger({ namespace: 'boundary', level: 'error' });
  const store = createStore(join(home, 'moonan.db'));
  const models = builtinModels({ credentials: store.credentials });
  const plugins: MoonanPluginNode[] = [];
  for (const name of pluginNames) {
    const plugin = await loadPlugin(name);
    assert.ok(plugin, `应能加载插件 ${name}`);
    plugins.push(plugin);
  }
  const holder: { services?: import('../src/services/index.js').HostServices } = {};
  const bundle = createHostBundle({ store, models, log, plugins, holder });
  const loader = combineFacetLoaders([createStaticFacetLoader([...bundle.facets])]);
  const loaded = await loader.load();
  const host = await createFacetHost({ facets: loaded.facets, onError: (error) => log.warn('chord', error.message) });
  const services = holder.services;
  assert.ok(services, '宿主服务应就绪');
  await bundle.initialize(services);
  return {
    plugins: bundle.entries.map((entry) => entry.id),
    actions: services.manager.listAvailableActions('main').map((action) => action.id),
    close: async () => {
      await services.manager.disposeAll();
      await host.dispose();
      store.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

describe('插件边界', () => {
  it('装齐五个官方插件时，登记齐全且 act 可用', async () => {
    const result = await bootWith(ALL);
    try {
      for (const id of [
        '@moonan/plugin-provider-panel',
        '@moonan/plugin-agent-manager',
        '@moonan/plugin-act',
        '@moonan/plugin-conversation',
        '@moonan/plugin-log-window',
      ]) {
        assert.ok(result.plugins.includes(id), `应登记 ${id}`);
      }
      assert.ok(result.actions.includes('conversation.send_message'), '对话 action 应可用');
    } finally {
      await result.close();
    }
  });

  it('删掉对话窗插件后仍能启动，只是少了那个 action', async () => {
    const result = await bootWith(ALL.filter((name) => name !== 'conversation'));
    try {
      assert.ok(!result.plugins.includes('@moonan/plugin-conversation'));
      assert.ok(result.plugins.includes('@moonan/plugin-act'), '其它插件照常');
      assert.ok(
        !result.actions.includes('conversation.send_message'),
        '该插件的 action 应随之消失',
      );
    } finally {
      await result.close();
    }
  });

  it('只装一个插件也能启动（说明宿主不依赖任何单个插件）', async () => {
    const result = await bootWith(['act']);
    try {
      assert.deepEqual(result.plugins, ['moonan.host', '@moonan/plugin-act']);
      assert.deepEqual(result.actions, []);
    } finally {
      await result.close();
    }
  });
});

after(() => undefined);
