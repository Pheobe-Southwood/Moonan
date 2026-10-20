/**
 * 官方内置插件的装载清单。
 *
 * 这里刻意保留「清单」这一层：插件是独立的 workspace 包，宿主只按 id 引用它们；
 * 将来安装第三方插件时，替换的就是这一份清单（见 README 的插件开发一节）。
 */
import { actPlugin } from '@moonan/plugin-act';
import { agentManagerPlugin } from '@moonan/plugin-agent-manager';
import { conversationPlugin } from '@moonan/plugin-conversation';
import { logWindowPlugin } from '@moonan/plugin-log-window';
import { providerPanelPlugin } from '@moonan/plugin-provider-panel';
import type { MoonanPluginNode } from '@moonan/plugin-sdk';

export const BUILTIN_PLUGINS: readonly MoonanPluginNode[] = [
  providerPanelPlugin,
  agentManagerPlugin,
  actPlugin,
  conversationPlugin,
  logWindowPlugin,
];
