import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { PhoneAppRegistry, type PhoneAppContext } from "../domain/app.js";
import {
  formatAvailableActions,
  formatHomeScreen,
  formatTopNotification,
  listAvailableActions,
  validateDuration,
} from "../domain/behavior.js";
import type { PhoneState, QQSubstate } from "../domain/types.js";
import type { MediaView } from "../media/render.js";
import { QQApp } from "../phone/qq-app.js";
import type { ChatPlatformAdapter } from "../platforms/types.js";
import type { MoonanDatabase } from "../storage/database.js";

function result(text: string, details: Record<string, unknown> = {}, terminate = false): AgentToolResult<Record<string, unknown>> {
  return { content: [{ type: "text", text }], details, ...(terminate ? { terminate: true } : {}) };
}

function blocks(content: Array<TextContent | ImageContent>, details: Record<string, unknown> = {}, terminate = false): AgentToolResult<Record<string, unknown>> {
  return { content, details, ...(terminate ? { terminate: true } : {}) };
}

const actionSchema = Type.Object({
  action: Type.Union([
    Type.Literal("idle"), Type.Literal("sleep"), Type.Literal("set_contact_importance"), Type.Literal("open_phone"),
    Type.Literal("open_app"), Type.Literal("exit_app"), Type.Literal("view_contacts"), Type.Literal("open_chat"),
    Type.Literal("load_history"), Type.Literal("send_messages"), Type.Literal("wait_messages"), Type.Literal("close_phone"),
  ]),
  app: Type.Optional(Type.String({ minLength: 1 })),
  durationMinutes: Type.Optional(Type.Number()),
  durationSeconds: Type.Optional(Type.Number()),
  messageCount: Type.Optional(Type.Integer({ minimum: 1 })),
  activity: Type.Optional(Type.String({ maxLength: 2_000 })),
  contactId: Type.Optional(Type.String({ minLength: 1 })),
  importance: Type.Optional(Type.Union([
    Type.Literal("priority_plus"), Type.Literal("priority"), Type.Literal("normal"),
    Type.Literal("do_not_disturb"), Type.Literal("no_push"),
  ])),
  kind: Type.Optional(Type.Union([Type.Literal("private"), Type.Literal("group")])),
  targetId: Type.Optional(Type.String({ minLength: 1 })),
  count: Type.Optional(Type.Integer({ minimum: 1 })),
  messages: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
}, { additionalProperties: false });

export function buildSimulationTools(
  db: MoonanDatabase,
  platform: ChatPlatformAdapter,
  media: MediaView,
  registry: PhoneAppRegistry = createDefaultAppRegistry(),
): AgentTool[] {
  const actionsFooter = (): string => formatAvailableActions(listAvailableActions(db.getRuntime(), registry));
  const footerText = (): string => `\n\n${actionsFooter()}`;

  const makeContext = (): PhoneAppContext => ({
    db,
    runtime: db.getRuntime(),
    media,
    platform,
    settings: db.getSettings().value,
    profile: db.getProfile(),
  });

  const performTool: AgentTool<typeof actionSchema> = {
    name: "perform_action",
    label: "执行角色动作",
    description: "让角色执行一个经过状态校验的具体动作。每条结果（含错误）都会附上接下来可用的动作。只有 send_messages 会向外部聊天发送文字。",
    parameters: actionSchema,
    executionMode: "sequential",
    replay: "never",
    execute: async (_toolCallId, params, signal) => {
      try {
        const settings = db.getSettings().value;
        let runtime = db.getRuntime();
        const profile = db.getProfile();

        // Normalize any legacy phone states if present
        let currentPhone = runtime.phone as PhoneState | { kind: "contacts" } | { kind: "chat"; target: any; cursor?: any };
        if (currentPhone.kind === "contacts") {
          currentPhone = { kind: "app", appId: "qq", substate: { view: "contacts" } };
          runtime = db.setRuntime({ phone: currentPhone });
        } else if (currentPhone.kind === "chat") {
          currentPhone = { kind: "app", appId: "qq", substate: { view: "chat", target: (currentPhone as any).target, cursor: (currentPhone as any).cursor } };
          runtime = db.setRuntime({ phone: currentPhone });
        }

        const allowed = new Set(listAvailableActions(runtime, registry).map((item) => item.id));
        if (!allowed.has(params.action)) throw new Error(`当前状态不能执行 ${params.action}`);
        const withFooter = (text: string): string => `${text}\n\n${actionsFooter()}`;

        if (params.action === "idle") {
          if (params.durationMinutes === undefined) throw new Error("idle 需要 durationMinutes");
          validateDuration("idle", params.durationMinutes, settings);
          db.cancelPendingTimers();
          const dueAt = Date.now() + params.durationMinutes * 60_000;
          db.createTimer("idle", dueAt, { activity: params.activity ?? "自娱自乐" });
          runtime = db.setRuntime({ mode: "entertaining", phone: { kind: "closed" }, nextWakeAt: dueAt });
          db.addEvent("action_completed", `${profile.name}${params.activity ?? "自娱自乐"}，预计 ${params.durationMinutes} 分钟后结束。`, { action: "idle", dueAt });
          return result(withFooter(`${profile.name}收起手机开始${params.activity ?? "自娱自乐"}，将在设定时间结束后继续行动。`), { runtime }, true);
        }

        if (params.action === "sleep") {
          if (params.durationMinutes === undefined) throw new Error("sleep 需要 durationMinutes");
          validateDuration("sleep", params.durationMinutes, settings);
          db.cancelPendingTimers();
          const dueAt = Date.now() + params.durationMinutes * 60_000;
          db.createTimer("alarm", dueAt);
          runtime = db.setRuntime({ mode: "sleeping", phone: { kind: "closed" }, nextWakeAt: dueAt });
          db.addEvent("action_completed", `${profile.name}睡觉并设置了 ${params.durationMinutes} 分钟后的闹钟。`, { action: "sleep", dueAt });
          return result(withFooter(`${profile.name}收起手机睡着了，闹钟已经设置。`), { runtime }, true);
        }

        if (params.action === "close_phone") {
          runtime = db.setRuntime({ phone: { kind: "closed" } });
          db.addEvent("action_completed", `${profile.name}关闭了手机。`, { action: "close_phone" });
          return result(withFooter(`${profile.name}关闭了手机。`), { runtime });
        }

        if (params.action === "open_phone") {
          runtime = db.setRuntime({ phone: { kind: "home" } });
          db.addEvent("action_completed", `${profile.name}打开了手机。`, { action: params.action });
          const homeScreen = formatHomeScreen(profile, runtime, registry, makeContext());
          return result(withFooter(homeScreen), { runtime });
        }

        if (params.action === "open_app") {
          const appId = params.app;
          if (!appId) throw new Error("open_app 需要指定 app 参数");
          const app = registry.get(appId);
          if (!app) throw new Error(`未安装或未知的应用：${appId}`);

          const context = makeContext();
          const enterResult = await app.onEnter(context);
          runtime = db.setRuntime({
            phone: {
              kind: "app",
              appId: app.id,
              substate: (enterResult.nextSubstate ?? {}) as QQSubstate,
            },
          });

          const topHeader = formatTopNotification(runtime.topNotification);
          const fullText = `${topHeader}\n\n${enterResult.text}`;

          if (enterResult.images && enterResult.images.length > 0) {
            return blocks([
              { type: "text", text: `${topHeader}\n\n` },
              ...enterResult.images,
              { type: "text", text: `\n${enterResult.text}${footerText()}` },
            ], { runtime, ...enterResult.details }, enterResult.terminate ?? false);
          }

          return result(withFooter(fullText), { runtime, ...enterResult.details }, enterResult.terminate ?? false);
        }

        if (params.action === "exit_app") {
          if (runtime.phone.kind !== "app") throw new Error("当前未在任何应用内");
          const app = registry.get(runtime.phone.appId);
          if (app) {
            await app.executeAction("exit_app", params, runtime.phone.substate, makeContext(), signal);
          }
          runtime = db.setRuntime({ phone: { kind: "home" } });
          const homeScreen = formatHomeScreen(profile, runtime, registry, makeContext());
          return result(withFooter(`${profile.name}退出了应用，返回了手机主页。\n\n${homeScreen}`), { runtime });
        }

        // Delegate to active app
        if (runtime.phone.kind === "app") {
          const app = registry.get(runtime.phone.appId);
          if (!app) throw new Error(`应用 ${runtime.phone.appId} 不存在`);

          const context = makeContext();
          const actionResult = await app.executeAction(params.action, params, runtime.phone.substate, context, signal);

          if (actionResult.exitToHome) {
            runtime = db.setRuntime({ phone: { kind: "home" } });
            const homeScreen = formatHomeScreen(profile, runtime, registry, makeContext());
            return result(withFooter(`${actionResult.text}\n\n${homeScreen}`), { runtime, ...actionResult.details });
          }

          if (actionResult.nextSubstate) {
            runtime = db.setRuntime({
              phone: {
                kind: "app",
                appId: runtime.phone.appId,
                substate: actionResult.nextSubstate as QQSubstate,
              },
            });
          }

          const topHeader = formatTopNotification(runtime.topNotification);
          const fullText = `${topHeader}\n\n${actionResult.text}`;

          if (actionResult.images && actionResult.images.length > 0) {
            return blocks([
              { type: "text", text: `${topHeader}\n\n` },
              ...actionResult.images,
              { type: "text", text: `\n${actionResult.text}${footerText()}` },
            ], { runtime, ...actionResult.details }, actionResult.terminate ?? false);
          }

          return result(withFooter(fullText), { runtime, ...actionResult.details }, actionResult.terminate ?? false);
        }

        throw new Error(`当前状态不能执行 ${params.action}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${message}\n\n${actionsFooter()}`);
      }
    },
  };
  return [performTool];
}

export function createDefaultAppRegistry(qqApp = new QQApp()): PhoneAppRegistry {
  const registry = new PhoneAppRegistry();
  registry.register(qqApp);
  return registry;
}
