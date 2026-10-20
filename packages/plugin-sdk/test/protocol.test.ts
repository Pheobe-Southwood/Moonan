import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACT_BLOCK_FOOTER,
  ACT_BLOCK_MARKER,
  ClientAgentsToken,
  ClientStateToken,
  REMOTE_SERVICE_IDS,
  SYSTEM_EVENT_BUFFER,
  TRANSCRIPT_EVENT_BUFFER,
  DEFAULT_PORT,
  MOONAN_SUBPROTOCOL,
} from '../src/index.js';

describe('插件契约常量', () => {
  it('WebUI 端口是 21315', () => {
    assert.equal(DEFAULT_PORT, 21315);
  });

  it('ActBlock 标记与尾句稳定（渲染与摘除都依赖它们）', () => {
    assert.ok(ACT_BLOCK_MARKER.startsWith('<!--'));
    assert.equal(ACT_BLOCK_FOOTER, 'act以外的工具不受限制，均可调用');
  });

  it('客户端 token 与 node 侧共用 id', () => {
    assert.equal(ClientStateToken.id, 'moonan.host-state');
    assert.equal(ClientAgentsToken.id, 'moonan.agents');
  });

  it('远端服务清单包含全部跨 wire 的服务', () => {
    assert.deepEqual([...REMOTE_SERVICE_IDS].sort(), [
      'moonan.actions',
      'moonan.agents',
      'moonan.events',
      'moonan.host-state',
      'moonan.providers',
      'moonan.transcripts',
      'moonan.ui',
    ]);
  });

  it('缓冲区上限是正数', () => {
    assert.ok(TRANSCRIPT_EVENT_BUFFER > 0);
    assert.ok(SYSTEM_EVENT_BUFFER > 0);
    assert.equal(MOONAN_SUBPROTOCOL, 'moonan.v1');
  });
});
