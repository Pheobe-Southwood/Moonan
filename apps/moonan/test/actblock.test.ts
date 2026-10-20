import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Type } from 'typebox';
import { ACT_BLOCK_MARKER } from '@moonan/plugin-sdk';
import {
  applyActBlock,
  hasActBlock,
  renderActBlock,
  renderParameters,
  renderPrompt,
  stripActBlock,
} from '../src/runtime/actblock.js';
import { toPlainJson } from '../src/runtime/agent-manager.js';

// 与真实渲染一致：标记是第一行
const BLOCK = ACT_BLOCK_MARKER + '\nX1\nX2';

describe('ActBlock 渲染与摘挂', () => {
  it('渲染包含标记、参数与固定尾句', () => {
    const text = renderActBlock([
      {
        id: 'conversation.send_message',
        title: '发送对话消息',
        description: '把消息发到对话框',
        parameters: Type.Object({ text: Type.String() }),
        available: true,
      },
    ]);
    assert.match(text, /conversation\.send_message/);
    assert.match(text, /text: string/);
    assert.match(text, /act以外的工具不受限制，均可调用/);
  });

  it('渲染 TypeBox 的联合/枚举/数组参数', () => {
    const rendered = renderParameters(
      Type.Object({
        mode: Type.Union([Type.Literal('a'), Type.Literal('b')]),
        tags: Type.Array(Type.String()),
        note: Type.Optional(Type.String()),
      }),
    );
    assert.match(rendered, /mode: "a" \| "b"/);
    assert.match(rendered, /tags: string\[\]/);
    assert.match(rendered, /note\?: string/);
  });

  it('先摘后挂是幂等的：任意调用次数只留一份', () => {
    const once = applyActBlock([{ type: 'text', text: 'hello' }], BLOCK) as unknown[];
    const twice = applyActBlock(once, BLOCK) as unknown[];
    const thrice = applyActBlock(twice, BLOCK) as unknown[];
    const count = (value: unknown[]): number =>
      value.filter(
        (part) =>
          typeof part === 'object' &&
          part !== null &&
          'text' in part &&
          String((part as { text: string }).text).includes(ACT_BLOCK_MARKER),
      ).length;
    assert.equal(count(thrice), 1);
    assert.equal(hasActBlock(thrice), true);
  });

  it('字符串内容也支持摘挂，并保留原文', () => {
    const attached = applyActBlock('原文', BLOCK) as string;
    assert.match(attached, /原文/);
    assert.equal(hasActBlock(attached), true);
    assert.equal(stripActBlock(attached), '原文');
  });

  it('不含块的内容摘除后是同一个引用（避免无谓复制）', () => {
    const original = [{ type: 'text', text: 'no block' }];
    assert.equal(stripActBlock(original), original);
  });
});

describe('SYSTEM PROMPT 渲染', () => {
  it('替换变量并对大小写不敏感', () => {
    const result = renderPrompt('main', '主角是{{botname}}，人设：{{ SOUL }}', {
      botname: '小雨',
      soul: '安静',
    });
    assert.equal(result.text, '主角是小雨，人设：安静');
    assert.deepEqual(result.missingVariables, []);
  });

  it('缺失变量替换为空串并报告', () => {
    const result = renderPrompt('main', 'A{{missing}}B', {});
    assert.equal(result.text, 'AB');
    assert.deepEqual(result.missingVariables, ['missing']);
  });
});

describe('replicated state 的净化', () => {
  it('净化会丢掉 symbol key 与原型（chord 的严格 JSON 校验只接受纯对象）', () => {
    const symbol = Symbol('typebox-marker');
    const withSymbol: Record<string | symbol, unknown> = { type: 'object' };
    withSymbol[symbol] = true;
    assert.equal(Object.getOwnPropertySymbols(withSymbol).length, 1);

    const plain = toPlainJson(withSymbol) as object;
    assert.equal(Object.getOwnPropertySymbols(plain).length, 0);
    assert.equal(Object.getPrototypeOf(plain), Object.prototype);

    const schema = Type.Object({ text: Type.String() });
    assert.deepEqual(toPlainJson(schema), {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    });
  });
});
