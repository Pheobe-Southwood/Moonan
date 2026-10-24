import type { Messages } from "@moonan_ai/web-api";

/** Strings this panel owns; the shell never has to know they exist. */
export const messages: Messages = {
	zh: {
		""chat.open_agents"": "Agent",
		"chat.empty.title": "还没有开始",
		"chat.empty.body": "在下面输入第一句话。短时间内连续发送的消息会合并成一批。",
		"chat.placeholder": "说点什么…",
		"chat.send": "发送",
		"chat.hint": "Enter 发送 · Shift+Enter 换行",
		"chat.thinking": "思考中",
		"chat.streaming": "生成中",
		"chat.model_missing": "还没有选择模型",
		"chat.model_missing.body": "去 Agent 页面选一个模型，然后就可以开始了。",
		"chat.tools": "工具",
	},
	en: {
		""chat.open_agents"": "Agents",
		"chat.empty.title": "Nothing yet",
		"chat.empty.body": "Type the first line below. Messages sent within a moment are batched together.",
		"chat.placeholder": "Say something…",
		"chat.send": "Send",
		"chat.hint": "Enter to send · Shift+Enter for a new line",
		"chat.thinking": "Thinking",
		"chat.streaming": "Streaming",
		"chat.model_missing": "No model selected",
		"chat.model_missing.body": "Pick a model on the Agents page to start.",
		"chat.tools": "Tools",
	},
};
