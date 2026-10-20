import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type TSchema } from 'typebox';
import type { ActionApi, ActionInfo, MoonanContext, PluginTool } from '@moonan/plugin-sdk';
import { renderActBlock } from './actblock.js';

/** `act` 工具名。 */
export const ACT_TOOL_NAME = 'act';

/**
 * 在运行时把已注册的 actions 重建为 `act` 的 TypeBox schema 与描述。
 *
 * actions 集合变化时不重建工具表，重建的是 `act` 本身的参数与描述（见 docs/adr/0004）。
 */
export function buildActTool(
  agentId: string,
  actions: readonly ActionInfo[],
  invoke: (
    actionId: string,
    args: Record<string, unknown>,
    api: ActionApi,
    context: MoonanContext,
  ) => Promise<Awaited<ReturnType<PluginTool['execute']>>>,
  api: ActionApi,
): AgentTool {
  /**
   * 参数是**扁平**的：`action` 加上该 action 自己的参数。
   *
   * 刻意不用嵌套的 `{ action, args }`：嵌套对象对模型更难写对，且实测会被参数校验拒绝。
   */
  const properties: Record<string, TSchema> = {};
  const variants: TSchema[] = [];
  for (const action of actions) {
    if (!/^[A-Za-z0-9_.:-]+$/.test(action.id)) {
      // action id 会进 schema；非法字符会被 provider 拒绝，这里直接跳过并告警。
      continue;
    }
    properties[action.id] = Type.Object(
      {
        action: Type.Literal(action.id),
        ...((action.parameters as { properties?: Record<string, TSchema> } | undefined)?.properties ?? {}),
      },
      {
        required: (action.parameters as { required?: string[] } | undefined)?.required ?? [],
        description: `${action.title}：${action.description}`,
        ...((action.parameters as { additionalProperties?: boolean } | undefined)?.additionalProperties === undefined
          ? {}
          : { additionalProperties: (action.parameters as { additionalProperties: boolean }).additionalProperties }),
      },
    );
    variants.push(properties[action.id]!);
  }

  const parameters: TSchema =
    variants.length === 0
      ? Type.Object({ action: Type.String() }, { description: '当前没有可用的 action' })
      : Type.Union(variants);

  const lines = ['执行一个 action，用于控制角色与场景。一次只执行一个 action。'];
  if (actions.length === 0) {
    lines.push('当前没有可用的 action。');
  } else {
    lines.push('');
    for (const action of actions) {
      lines.push(`- ${action.id}（${action.title}）：${action.description}`);
    }
    lines.push('', '调用时把 action 的参数与 action 字段放在同一层，例如：');
    lines.push('{"action":"<action id>", ...该 action 的参数}');
    lines.push('', renderActBlock(actions));
  }

  return {
    name: ACT_TOOL_NAME,
    label: 'Act',
    description: lines.join('\n'),
    parameters,
    execute: async (_toolCallId, params: unknown, signal) => {
      const payload = (params ?? {}) as Record<string, unknown>;
      const actionId = String(payload['action'] ?? '');
      const known = actions.some((action) => action.id === actionId);
      if (!known) {
        const available = actions.map((action) => action.id).join(', ') || '（无）';
        return {
          content: [
            {
              type: 'text' as const,
              text: `未知或当前不可用的 action：${actionId}。当前可用的 actions：${available}。`,
            },
          ],
          details: {},
          isError: true,
        };
      }
      const { action: _action, ...args } = payload;
      const result = await invoke(actionId, args, api, { signal });
      return {
        content: [{ type: 'text' as const, text: result.text }],
        details: { agentId, actionId, ok: result.ok },
        ...(result.ok ? {} : { isError: true }),
        ...(result.terminate ? { terminate: true } : {}),
      };
    },
  };
}

/** 把插件注册的 `PluginTool` 包成 pi-agent-core 的 `AgentTool`。 */
export function buildPluginTool(
  tool: PluginTool,
  api: ActionApi,
): AgentTool {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    execute: async (_toolCallId, params: unknown, signal) => {
      const pluginContext: MoonanContext = { signal };
      const result = await tool.execute((params ?? {}) as Record<string, unknown>, api, pluginContext);
      return {
        content: [{ type: 'text' as const, text: result.text }],
        details: { tool: tool.name, ok: result.ok },
        ...(result.ok ? {} : { isError: true }),
        ...(result.terminate ? { terminate: true } : {}),
      };
    },
  };
}
