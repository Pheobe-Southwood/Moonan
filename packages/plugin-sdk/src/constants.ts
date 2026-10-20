/** 纯数据常量。单独成文件，保证 UI 侧 import 时不会带上 node 侧的东西。 */

/** 会被 WebUI 绑定的服务 id 列表。 */
export const REMOTE_SERVICE_IDS = [
  'moonan.host-state',
  'moonan.actions',
  'moonan.agents',
  'moonan.transcripts',
  'moonan.providers',
  'moonan.ui',
  'moonan.events',
] as const;

/** ActBlock 的尾部标记；渲染与摘除都依赖它。 */
export const ACT_BLOCK_MARKER = '<!--moonan:act-block-->';

/** ActBlock 中的固定尾句。 */
export const ACT_BLOCK_FOOTER = 'act以外的工具不受限制，均可调用';

/** `moonan.transcripts.events` 保留的实况事件条数。 */
export const TRANSCRIPT_EVENT_BUFFER = 200;

/** `moonan.events.state` 保留的最近系统事件条数。 */
export const SYSTEM_EVENT_BUFFER = 100;

/** 客户端的子协议名。 */
export const MOONAN_SUBPROTOCOL = 'moonan.v1';

/** WebSocket 路径。 */
export const MOONAN_WS_PATH = '/api/ws';

/** WebUI 默认端口（要求：使用 21315）。 */
export const DEFAULT_PORT = 21315;

/** 数据目录名（相对 HOME）。 */
export const MOONAN_HOME_DIR = '.moonan';
