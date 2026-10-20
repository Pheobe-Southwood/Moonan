import { describe, expect, it } from "vitest";
import { buildSimulationTools } from "../src/agents/simulation-tools.js";
import { PhoneAppRegistry, type PhoneApp, type PhoneAppContext, type PhoneActionResult } from "../src/domain/app.js";
import { formatHomeScreen, formatTopNotification, listAvailableActions } from "../src/domain/behavior.js";
import { defaultRuntime } from "../src/domain/defaults.js";
import type { ChatPlatformAdapter } from "../src/platforms/types.js";
import { stubMediaView, testDatabase, textOf } from "./helpers.js";

function platform(connected = true): ChatPlatformAdapter {
  return {
    id: "fake",
    status: () => ({ connected, selfId: "bot", roles: ["universal"] }),
    sendText: async () => {
      if (!connected) throw new Error("not connected");
      return { platformMessageId: "sent-1" };
    },
    syncRoster: async () => ({ groupsAdded: 0, groupsRemoved: 0, contactsUpdated: 0 }),
    close: async () => undefined,
  };
}

async function execute(tool: any, params: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
  return await tool.execute("call", params, signal);
}

class MockVideoApp implements PhoneApp {
  readonly id = "video";
  readonly name = "视频播放器";
  readonly description = "观看与管理视频的应用";

  getStatus(_context: PhoneAppContext) {
    return { available: true, statusText: "空闲" };
  }

  getHomeNotification(_context: PhoneAppContext) {
    return { summary: "有 1 个新推荐视频", unreadCount: 1 };
  }

  listActions(substate: Record<string, unknown> | undefined) {
    if (substate?.view === "playing") {
      return [
        { id: "pause_video", description: "暂停当前播放的视频。", parameters: {} },
        { id: "exit_app", description: "退出视频播放器，返回手机主页。", parameters: {} },
      ];
    }
    return [
      { id: "play_video", description: "播放推荐视频。", parameters: { videoId: "string" } },
      { id: "exit_app", description: "退出视频播放器，返回手机主页。", parameters: {} },
    ];
  }

  async onEnter(_context: PhoneAppContext): Promise<PhoneActionResult> {
    return {
      text: "当前手机状态：视频播放器（主界面）\n这里有精选推荐视频。",
      nextSubstate: { view: "main" },
    };
  }

  async executeAction(action: string, params: Record<string, unknown>): Promise<PhoneActionResult> {
    if (action === "play_video") {
      return {
        text: `正在播放视频 ${params.videoId}。`,
        nextSubstate: { view: "playing", videoId: params.videoId },
      };
    }
    if (action === "pause_video") {
      return {
        text: "已暂停播放视频。",
        nextSubstate: { view: "main" },
      };
    }
    if (action === "exit_app") {
      return {
        text: "退出了视频播放器。",
        exitToHome: true,
      };
    }
    throw new Error(`未知动作：${action}`);
  }
}

describe("phone app standard and registry", () => {
  it("allows registering third-party apps alongside QQ", () => {
    const registry = new PhoneAppRegistry();
    const video = new MockVideoApp();
    registry.register(video);
    expect(registry.get("video")).toBe(video);
    expect(registry.list().map((a) => a.id)).toEqual(["video"]);

    const inVideoRuntime = {
      ...defaultRuntime(),
      phone: { kind: "app" as const, appId: "video", substate: { view: "main" } },
    };
    const actions = listAvailableActions(inVideoRuntime, registry).map((a) => a.id);
    expect(actions).toContain("play_video");
    expect(actions).toContain("exit_app");
  });

  it("formats home screen with Top Notification, Notification Area, and App Area", () => {
    const fixture = testDatabase();
    try {
      const registry = new PhoneAppRegistry();
      registry.register(new MockVideoApp());
      const runtime = defaultRuntime();
      runtime.topNotification = { source: "系统", content: "电池电量充足", occurredAt: Date.now() };

      const context: PhoneAppContext = {
        db: fixture.db,
        runtime,
        media: stubMediaView(fixture.db),
        platform: platform(true),
        settings: fixture.db.getSettings().value,
        profile: fixture.db.getProfile(),
      };

      const home = formatHomeScreen(fixture.db.getProfile(), runtime, registry, context);
      expect(home).toContain("【顶部通知】[系统] 电池电量充足");
      expect(home).toContain("【通知区】");
      expect(home).toContain("- 视频播放器：有 1 个新推荐视频");
      expect(home).toContain("【App区】");
      expect(home).toContain("- video：视频播放器（观看与管理视频的应用） [空闲]");
    } finally {
      fixture.cleanup();
    }
  });

  it("navigates into a registered app, executes app-specific actions, and exits back to home", async () => {
    const fixture = testDatabase();
    try {
      const registry = new PhoneAppRegistry();
      registry.register(new MockVideoApp());
      const [perform] = buildSimulationTools(fixture.db, platform(), stubMediaView(fixture.db), registry);

      // Open phone -> home
      await execute(perform!, { action: "open_phone" });
      expect(fixture.db.getRuntime().phone.kind).toBe("home");

      // Cannot execute video app actions from home
      await expect(execute(perform!, { action: "play_video", videoId: "v1" })).rejects.toThrow(/当前状态不能执行 play_video/);

      // Open video app
      const entered = textOf(await execute(perform!, { action: "open_app", app: "video" }));
      expect(entered).toContain("视频播放器（主界面）");
      expect(fixture.db.getRuntime().phone).toMatchObject({
        kind: "app",
        appId: "video",
        substate: { view: "main" },
      });

      // Execute app action
      const played = textOf(await execute(perform!, { action: "play_video", videoId: "v1" }));
      expect(played).toContain("正在播放视频 v1");
      expect(fixture.db.getRuntime().phone).toMatchObject({
        kind: "app",
        appId: "video",
        substate: { view: "playing", videoId: "v1" },
      });

      // Exit app -> returns to home
      const exited = textOf(await execute(perform!, { action: "exit_app" }));
      expect(exited).toContain("退出了应用，返回了手机主页");
      expect(fixture.db.getRuntime().phone.kind).toBe("home");
    } finally {
      fixture.cleanup();
    }
  });

  it("handles QQ offline gracefully without crashing the bot", async () => {
    const fixture = testDatabase();
    try {
      const offlinePlatform = platform(false);
      const [perform] = buildSimulationTools(fixture.db, offlinePlatform, stubMediaView(fixture.db));

      // Open phone -> home shows QQ offline
      const home = textOf(await execute(perform!, { action: "open_phone" }));
      expect(home).toContain("qq：QQ");
      expect(home).toContain("[未连接]");

      // Opening QQ still works to view offline list
      const qq = textOf(await execute(perform!, { action: "open_app", app: "qq" }));
      expect(qq).toContain("当前手机状态：QQ（好友和群聊列表）");

      // Creating a contact and trying to send in offline state throws safe in-app error
      fixture.db.upsertContact({ platform: "onebot", id: "user1", name: "User1", aliases: [], summary: "", importance: "normal", isFriend: true });
      await execute(perform!, { action: "open_chat", kind: "private", targetId: "user1" });
      await expect(execute(perform!, { action: "send_messages", messages: ["hello"] })).rejects.toThrow(/QQ 未连接网络/);
    } finally {
      fixture.cleanup();
    }
  });

  it("always formats top notification properly", () => {
    expect(formatTopNotification(null)).toBe("【顶部通知】无");
    expect(formatTopNotification({ source: "QQ", content: "新消息", occurredAt: 12345 })).toBe("【顶部通知】[QQ] 新消息");
  });
});
