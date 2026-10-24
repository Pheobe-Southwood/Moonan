import type { Messages } from "@moonan_ai/web-api";

/** Strings this panel owns; the shell never has to know they exist. */
export const messages: Messages = {
	zh: {
		"logs.eyebrow": "日志",
		"logs.empty": "这一轮还没有产生任何记录。",
		"logs.title": "完整记录",
		"status.idle": "空闲",
		"status.queued": "排队",
		"status.streaming": "生成中",
		"status.error": "出错",
		"logs.role.user": "用户",
		"logs.role.assistant": "模型",
		"logs.role.tool": "工具",
		"logs.role.system": "系统",
		"logs.load_more": "加载更早",
		"logs.no_more": "没有更早的记录了",
		"logs.live": "实时",
	},
	en: {
		"logs.eyebrow": "Logs",
		"logs.empty": "Nothing recorded in this conversation yet.",
		"logs.title": "Transcript",
		"status.idle": "Idle",
		"status.queued": "Queued",
		"status.streaming": "Streaming",
		"status.error": "Error",
		"logs.role.user": "User",
		"logs.role.assistant": "Model",
		"logs.role.tool": "Tool",
		"logs.role.system": "System",
		"logs.load_more": "Load earlier",
		"logs.no_more": "No earlier entries",
		"logs.live": "Live",
	},
};
