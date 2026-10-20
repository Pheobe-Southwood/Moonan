import type { ActionInfo, RenderedPrompt } from '@moonan/plugin-sdk';
import { ACT_BLOCK_FOOTER, ACT_BLOCK_MARKER } from '@moonan/plugin-sdk';

/**
 * ActBlock：追加在本轮最后一条消息末尾的「下一步可用 actions」。
 *
 * 三条不变式（见 docs/adr/0004）：
 *  1. 任意时刻，模型视图里最多只有一份 ActBlock；
 *  2. 只挂在「本轮最后一条 tool result」，没有 tool result 时挂最后一条 user 消息；
 *  3. 持久化的是消息**原文**，ActBlock 只存在于模型视图。
 */
export function renderActBlock(actions: readonly ActionInfo[]): string {
  // 不变式：块的第一行就是标记。摘除按标记切分，任何前置内容都会破坏幂等性。
  const lines: string[] = [ACT_BLOCK_MARKER, '## 下一步可用的 actions'];
  if (actions.length === 0) {
    lines.push('（当前没有可用的 action）');
  }
  for (const action of actions) {
    const params = renderParameters(action.parameters);
    lines.push(`- \`${action.id}\`（${action.title}）：${action.description}`);
    lines.push(`  参数：${params}`);
    if (action.unavailableReason) {
      lines.push(`  注意：${action.unavailableReason}`);
    }
  }
  lines.push('', ACT_BLOCK_FOOTER);
  return lines.join('\n');
}

/** 把 TypeBox/JSON Schema 对象渲染成紧凑的参数说明。 */
export function renderParameters(schema: unknown): string {
  if (!isPlainObject(schema)) return '（无参数）';
  const properties = isPlainObject(schema.properties) ? schema.properties : undefined;
  if (!properties) return '（无参数）';
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  const parts: string[] = [];
  for (const [name, raw] of Object.entries(properties)) {
    const type = describeSchema(raw);
    parts.push(`${name}${required.has(name) ? '' : '?'}: ${type}`);
  }
  return parts.length === 0 ? '（无参数）' : parts.join(', ');
}

function describeSchema(raw: unknown): string {
  if (!isPlainObject(raw)) return 'unknown';
  // TypeBox 1.x 的字符串字面量用 `{ type: 'string', const: 'x' }` 表示。
  if (typeof raw.const === 'string') return JSON.stringify(raw.const);
  if (Array.isArray(raw.anyOf)) return raw.anyOf.map(describeSchema).join(' | ');
  if (Array.isArray(raw.enum)) return raw.enum.map((v) => JSON.stringify(v)).join(' | ');
  if (Array.isArray(raw.oneOf) && raw.oneOf.length > 0) {
    return raw.oneOf.map(describeSchema).join(' | ');
  }
  const type = raw.type;
  if (type === 'object') return renderParameters(raw);
  if (type === 'array') return `${describeSchema(raw.items)}[]`;
  if (typeof raw.description === 'string') return `${String(type ?? 'unknown')}（${raw.description}）`;
  return String(type ?? 'unknown');
}

/**
 * 该内容里是否挂着 ActBlock。
 *
 * 正常情况下块总在末尾（`applyActBlock` 就是这么挂的），这里仍检查全部分片，
 * 以便对历史里出现过的其它形态也给出正确判断。
 */
export function hasActBlock(content: unknown): boolean {
  return contentParts(content).some((part) =>
    typeof part === 'string' ? part.includes(ACT_BLOCK_MARKER) : isTextPartWithMarker(part),
  );
}

/**
 * 摘掉消息末尾的 ActBlock，返回消息**原文**的等价内容。
 * 对不含 ActBlock 的消息返回原值（同一个引用）。
 */
export function stripActBlock(content: unknown): unknown {
  if (typeof content === 'string') {
    const index = content.indexOf(ACT_BLOCK_MARKER);
    return index === -1 ? content : content.slice(0, index).trimEnd();
  }
  if (!Array.isArray(content)) return content;
  const parts = content.filter((part) => !isTextPartWithMarker(part));
  return parts.length === content.length ? content : parts;
}

/**
 * 把 ActBlock 挂到消息末尾。
 *
 * 先摘后挂，因此对同一消息重复调用是幂等的，最终形态只取决于 `block`。
 */
export function applyActBlock(content: unknown, block: string): unknown {
  const stripped = stripActBlock(content);
  // 标记必须在块的第一行：摘除时按标记截断即可精确还原原文。
  const text = block.startsWith(ACT_BLOCK_MARKER) ? block : `${ACT_BLOCK_MARKER}\n${block}`;
  if (typeof stripped === 'string') {
    return stripped.length === 0 ? text : `${stripped}\n\n${text}`;
  }
  if (Array.isArray(stripped)) {
    return [...stripped, { type: 'text', text: `\n\n${text}` }];
  }
  // 非文本内容（理论上不该出现）：原样返回，避免破坏历史。
  return stripped;
}

function contentParts(content: unknown): unknown[] {
  if (typeof content === 'string') return [content];
  if (Array.isArray(content)) return content;
  return [];
}

function isTextPartWithMarker(part: unknown): boolean {
  if (!isPlainObject(part)) return false;
  return part.type === 'text' && typeof part.text === 'string' && part.text.includes(ACT_BLOCK_MARKER);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// SYSTEM PROMPT 渲染
// ---------------------------------------------------------------------------

const VARIABLE_PATTERN = /\{\{\s*([A-Za-z0-9_\u4e00-\u9fa5]+)\s*\}\}/g;

/**
 * 把 `{{变量}}` 替换成 `variables` 中的值；缺失的变量替换为空串并记入 `missingVariables`。
 *
 * 变量名大小写不敏感（内置变量写作 `botname` / `soul`，用户写成 `{{Bot名字}}` 也能对上）。
 */
export function renderPrompt(
  agentId: string,
  template: string,
  variables: Readonly<Record<string, string>>,
): RenderedPrompt {
  const lookup = new Map<string, string>();
  for (const [key, value] of Object.entries(variables)) lookup.set(key.toLowerCase(), value);
  const missing = new Set<string>();
  const text = template.replace(VARIABLE_PATTERN, (_match, rawName: string) => {
    const value = lookup.get(rawName.toLowerCase());
    if (value === undefined) {
      missing.add(rawName);
      return '';
    }
    return value;
  });
  return { agentId, text, missingVariables: [...missing] };
}
