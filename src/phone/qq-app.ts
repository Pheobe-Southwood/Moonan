import { randomUUID } from "node:crypto";
import type {
  AppHomeNotification,
  AppStatus,
  AvailableAction,
  PhoneApp,
  PhoneAppContext,
  PhoneActionResult,
} from "../domain/app.js";
import { validateWait } from "../domain/behavior.js";
import type {
  ConversationTarget,
  Importance,
  NotificationDecision,
  QQSubstate,
  StoredMessage,
  TargetKind,
} from "../domain/types.js";

function localTime(locale: string, timezone: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "long", timeZone: timezone }).format(new Date());
}

function truncate(text: string, max: number): string {
  const characters = [...text.replace(/\s+/gu, " ").trim()];
  return characters.length > max ? `${characters.slice(0, max).join("")}…` : characters.join("");
}

async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => { clearTimeout(timer); reject(new Error("发送已中止")); };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

export class QQApp implements PhoneApp {
  readonly id = "qq";
  readonly name = "QQ";
  readonly description = "即时通讯软件，可查看好友/群聊与收发消息";

  getStatus(context: PhoneAppContext): AppStatus {
    const connected = context.platform?.status().connected ?? false;
    return {
      available: true,
      statusText: connected ? "在线" : "未连接",
    };
  }

  getHomeNotification(context: PhoneAppContext): AppHomeNotification | null {
    const unread = context.db.unreadSummary(false);
    const count = unread.reduce((sum, item) => sum + item.count, 0);
    if (count <= 0) return null;
    return {
      summary: `有 ${count} 条未读消息`,
      unreadCount: count,
    };
  }

  listActions(substateRaw: Record<string, unknown> | undefined): AvailableAction[] {
    const substate = substateRaw as QQSubstate | undefined;
    const actions: AvailableAction[] = [];

    if (!substate || substate.view === "contacts") {
      actions.push(
        { id: "open_chat", description: "进入好友或群聊的聊天窗口。", parameters: { kind: "private|group", targetId: "string" } },
        { id: "set_contact_importance", description: "更改任意一个好友的消息重要程度。", parameters: { contactId: "string", importance: "importance" } },
        { id: "exit_app", description: "退出 QQ，返回手机主页。", parameters: {} },
      );
      return actions;
    }

    if (substate.view === "chat") {
      actions.push(
        { id: "send_messages", description: "向当前聊天逐条发送文本。", parameters: { messages: "string[]" } },
        { id: "load_history", description: "从读取游标继续向上查看当前聊天的本地历史。", parameters: { count: "number?" } },
        { id: "wait_messages", description: "盯着当前聊天窗口等待新消息并结束本轮：durationSeconds 与 messageCount 二选一。", parameters: { durationSeconds: "number?", messageCount: "number?" } },
        { id: "view_contacts", description: "返回 QQ 好友和群聊列表。", parameters: {} },
      );
      if (substate.target.kind === "private") {
        actions.push({ id: "set_contact_importance", description: "更改当前聊天好友的消息重要程度。", parameters: { contactId: "string", importance: "importance" } });
      }
      actions.push({ id: "exit_app", description: "退出 QQ，返回手机主页。", parameters: {} });
    }

    return actions;
  }

  async onEnter(context: PhoneAppContext): Promise<PhoneActionResult> {
    return this.renderContactList(context);
  }

  private renderContactList(context: PhoneAppContext): PhoneActionResult {
    const { db, profile, settings, media } = context;
    const unread = db.unreadSummary(false);
    const unreadByKey = new Map(unread.map((item) => [`${item.target.kind}:${item.target.id}`, item.count]));
    interface Entry { kind: "private" | "group"; id: string; name: string; unread: number; latest: StoredMessage | null }
    const entries: Entry[] = [];
    for (const contact of db.listContacts()) {
      const target: ConversationTarget = { platform: "onebot", kind: "private", id: contact.id, name: contact.name };
      entries.push({ kind: "private", id: contact.id, name: contact.name, unread: unreadByKey.get(`private:${contact.id}`) ?? 0, latest: db.listMessages(target, 1).at(-1) ?? null });
    }
    for (const group of db.listGroups()) {
      const target: ConversationTarget = { platform: "onebot", kind: "group", id: group.id, name: group.name };
      entries.push({ kind: "group", id: group.id, name: group.name, unread: unreadByKey.get(`group:${group.id}`) ?? 0, latest: db.listMessages(target, 1).at(-1) ?? null });
    }
    entries.sort((left, right) => (right.latest?.occurredAt ?? 0) - (left.latest?.occurredAt ?? 0));
    const limit = settings.simulation.contactListMaxEntries;
    let shown = entries;
    let folded = 0;
    if (entries.length > limit) {
      const withUnread = entries.filter((entry) => entry.unread > 0);
      const withoutUnread = entries.filter((entry) => entry.unread === 0);
      shown = [...withUnread, ...withoutUnread.slice(0, Math.max(0, limit - withUnread.length))];
      folded = entries.length - shown.length;
    }
    const lines = shown.map((entry) => {
      const label = entry.kind === "group" ? "群聊" : "好友";
      const unreadText = entry.unread > 0 ? `有${entry.unread}条未读消息` : "没有未读消息";
      const latestText = entry.latest
        ? `[${new Date(entry.latest.occurredAt).toISOString()}] ${entry.latest.senderName}: ${truncate(media.preview(entry.latest), 50)}`
        : "无消息记录";
      return `（${label}）${entry.name}（${entry.id}）（${unreadText}）（最近一条：${latestText}）`;
    });
    if (folded > 0) lines.push(`（另有 ${folded} 个无未读消息的好友/群聊未显示）`);
    db.addEvent("action_completed", `${profile.name}查看了 QQ 好友和群聊列表。`, { action: "open_app", app: "qq" });
    const text = [
      `${profile.name}打开了 QQ。`,
      "当前手机状态：QQ（好友和群聊列表）",
      `当前时间：${localTime(profile.locale, profile.timezone)}`,
      `以下为${profile.name}的 QQ 好友/群聊列表：`,
      ...(lines.length ? lines : ["（列表为空）"]),
    ].join("\n");

    const nextSubstate: QQSubstate = { view: "contacts" };
    return {
      text,
      nextSubstate: nextSubstate as unknown as Record<string, unknown>,
      details: { shown: shown.length, folded },
    };
  }

  async executeAction(
    action: string,
    params: Record<string, unknown>,
    substateRaw: Record<string, unknown> | undefined,
    context: PhoneAppContext,
    signal?: AbortSignal,
  ): Promise<PhoneActionResult> {
    const substate = substateRaw as QQSubstate | undefined;
    const { db, profile, settings, media, platform, runtime } = context;

    if (action === "exit_app") {
      db.addEvent("action_completed", `${profile.name}退出了 QQ，返回手机主页。`, { action: "exit_app", app: "qq" });
      return {
        text: `${profile.name}退出了 QQ，返回了手机主页。`,
        exitToHome: true,
      };
    }

    if (action === "view_contacts") {
      return this.renderContactList(context);
    }

    if (action === "set_contact_importance") {
      const contactId = params.contactId as string | undefined;
      const importance = params.importance as Importance | undefined;
      if (!contactId || !importance) throw new Error("需要 contactId 和 importance");
      if (substate?.view === "chat" && contactId !== substate.target.id) {
        throw new Error("在当前聊天窗口只能设置该好友的消息重要度");
      }
      let contact;
      try {
        contact = db.setContactImportance(contactId, importance);
      } catch {
        throw new Error(`未知联系人：${contactId}`);
      }
      db.addEvent("action_completed", `${profile.name}将${contact.name}的消息重要度设为 ${contact.importance}。`, { action, contactId: contact.id });
      return {
        text: `已将 ${contact.name} 的消息重要度设为 ${contact.importance}。`,
        details: { contact },
      };
    }

    if (action === "open_chat") {
      const kind = params.kind as TargetKind | undefined;
      const targetId = params.targetId as string | undefined;
      if (!kind || !targetId) throw new Error("需要 kind 和 targetId");
      const known = kind === "private"
        ? db.getContact(targetId)
        : db.listGroups().find((item) => item.id === targetId);
      if (!known) throw new Error(`未知联系人或群聊：${targetId}`);
      const target: ConversationTarget = { platform: "onebot", kind, id: targetId, name: known.name };
      const isTarget = (item: { target: ConversationTarget }): boolean => item.target.kind === target.kind && item.target.id === target.id;
      const unreadCount = db.unreadSummary(true).find(isTarget)?.count ?? 0;
      const otherUnread = db.unreadSummary(false).filter((item) => !isTarget(item)).reduce((sum, item) => sum + item.count, 0);
      const messages = db.listMessages(target, settings.simulation.chatPreviewMessages);
      db.markTargetRead(target);
      db.addEvent("action_completed", `${profile.name}打开了${target.name ?? target.id}的聊天窗口。`, { action, target });

      const header = unreadCount > 0
        ? `截止到上次打开，有 ${unreadCount} 条新消息；以下为最新的 ${messages.length} 条（旧→新）：`
        : `没有新消息；以下为最近的 ${messages.length} 条（旧→新）：`;
      const rendered = await media.render(messages, { describeLazily: true });
      const head = [
        `${profile.name}打开了${target.name ?? target.id}的聊天窗口。`,
        `当前手机状态：QQ 聊天窗口（${target.name ?? target.id}）`,
        `当前时间：${localTime(profile.locale, profile.timezone)}`,
        header,
      ].join("\n");
      const tail = [
        "可以使用 load_history 查看更早的消息；使用 view_contacts 可返回好友/群聊列表。",
        `${profile.name}的其他好友/群聊存在 ${otherUnread} 条未读消息。`,
      ].join("\n");

      const nextSubstate: QQSubstate = {
        view: "chat",
        target,
        cursor: messages.length ? messages[0]!.occurredAt : null,
      };

      if (!rendered.images.length) {
        return {
          text: [head, rendered.text, tail].join("\n"),
          nextSubstate: nextSubstate as unknown as Record<string, unknown>,
          details: { messages },
        };
      }

      return {
        text: `${head}\n${tail}`,
        images: rendered.images,
        nextSubstate: nextSubstate as unknown as Record<string, unknown>,
        details: { messages },
      };
    }

    if (action === "load_history") {
      if (substate?.view !== "chat") throw new Error("需要先打开目标聊天窗口");
      const phoneTarget = substate.target;
      const count = Math.min((params.count as number | undefined) ?? settings.simulation.chatPreviewMessages, settings.simulation.historyMaxMessages);
      const messages = db.listMessages(phoneTarget, count, substate.cursor ?? undefined);
      const nextCursor = messages.length ? messages[0]!.occurredAt : substate.cursor;
      const nextSubstate: QQSubstate = { ...substate, cursor: nextCursor };

      const otherUnread = db.unreadSummary(false)
        .filter((item) => !(item.target.kind === phoneTarget.kind && item.target.id === phoneTarget.id))
        .reduce((sum, item) => sum + item.count, 0);
      const rendered = await media.render(messages, { describeLazily: true });
      const head = messages.length
        ? `以下是更早的 ${messages.length} 条本地已观测历史（旧→新）：`
        : "";
      const tail = `${profile.name}的其他好友/群聊存在 ${otherUnread} 条未读消息。`;

      if (!messages.length) {
        return {
          text: `已经到最早的本地已观测消息。\n${tail}`,
          nextSubstate: nextSubstate as unknown as Record<string, unknown>,
          details: { messages, localOnly: true },
        };
      }

      if (!rendered.images.length) {
        return {
          text: `${head}\n${rendered.text}\n${tail}`,
          nextSubstate: nextSubstate as unknown as Record<string, unknown>,
          details: { messages, localOnly: true },
        };
      }

      return {
        text: `${head}\n${tail}`,
        images: rendered.images,
        nextSubstate: nextSubstate as unknown as Record<string, unknown>,
        details: { messages, localOnly: true },
      };
    }

    if (action === "send_messages") {
      if (substate?.view !== "chat") throw new Error("需要先打开目标聊天窗口");
      if (!runtime.outboundEnabled) throw new Error("出站消息总开关已关闭");
      if (!platform || !platform.status().connected) throw new Error("QQ 未连接网络，消息发送失败");

      const phoneTarget = substate.target;
      const messages = (params.messages as string[] | undefined) ?? [];
      if (!messages.length) throw new Error("messages 不能为空");
      if (Buffer.byteLength(JSON.stringify(messages), "utf8") > settings.simulation.maxSendPayloadBytes) throw new Error("消息参数超过 256 KiB 上限");
      if (messages.some((message) => [...message].length > settings.simulation.maxMessageCharacters)) throw new Error(`单条消息不能超过 ${settings.simulation.maxMessageCharacters} 字符`);

      const sent: Array<{ id: string; status: string; platformMessageId: string | null }> = [];
      for (let index = 0; index < messages.length; index += 1) {
        if (signal?.aborted) throw new Error("发送已中止");
        const content = messages[index]!;
        const id = randomUUID();
        db.insertMessage({
          id, platformMessageId: null, target: phoneTarget, senderId: runtime.activeSelfId ?? profile.name,
          senderName: profile.name, direction: "outgoing", content, segments: [{ type: "text", data: { text: content } }],
          occurredAt: Date.now(), observedAt: Date.now(), deliveryStatus: "pending", readAt: Date.now(),
        });
        db.updateMessageDelivery(id, "unknown");
        try {
          const response = await platform.sendText(phoneTarget, content, signal);
          db.updateMessageDelivery(id, "sent", response.platformMessageId ?? undefined);
          sent.push({ id, status: "sent", platformMessageId: response.platformMessageId });
        } catch (error) {
          sent.push({ id, status: "unknown", platformMessageId: null });
          throw new Error(`发送结果未知：${error instanceof Error ? error.message : String(error)}`);
        }
        if (index < messages.length - 1) await pause(settings.simulation.messageIntervalMs, signal);
      }
      db.addEvent("action_completed", `${profile.name}向${phoneTarget.name ?? phoneTarget.id}发送了 ${sent.length} 条消息。`, { action, target: phoneTarget, sent });
      return {
        text: `已按顺序发送 ${sent.length} 条消息。`,
        details: { sent },
      };
    }

    if (action === "wait_messages") {
      if (substate?.view !== "chat") throw new Error("需要先打开目标聊天窗口");
      const phoneTarget = substate.target;
      const plan = validateWait(params as { durationSeconds?: number; messageCount?: number }, settings);
      db.cancelPendingTimers();
      const start = Date.now();
      const since = db.oldestUnreadOccurredAt(phoneTarget) ?? start;
      let dueAt = plan.mode === "seconds" ? start + plan.seconds * 1_000 : start + settings.simulation.waitMessageTimeoutSeconds * 1_000;
      if (plan.mode === "count" && db.listMessagesSince(phoneTarget, since).length >= plan.count) dueAt = start;
      db.createTimer("wait", dueAt, {
        watch: phoneTarget, mode: plan.mode, since,
        ...(plan.mode === "seconds" ? { seconds: plan.seconds } : { count: plan.count }),
      });
      db.setRuntime({ mode: "waiting", nextWakeAt: dueAt });
      const targetName = phoneTarget.name ?? phoneTarget.id;
      db.addEvent("action_completed", `${profile.name}开始在${targetName}的聊天窗口等待新消息。`, { action, target: phoneTarget, plan });
      const text = plan.mode === "seconds"
        ? `${profile.name}盯着${targetName}的聊天窗口，等待 ${plan.seconds} 秒。`
        : `${profile.name}盯着${targetName}的聊天窗口，等待 ${plan.count} 条新消息（最多 ${settings.simulation.waitMessageTimeoutSeconds} 秒）。`;

      return {
        text,
        terminate: true,
      };
    }

    throw new Error(`QQ 不支持动作：${action}`);
  }

  static evaluateNotification(
    targetKind: TargetKind,
    senderName: string,
    content: string,
    importance: Importance,
    sleeping: boolean,
    random: () => number,
    priorityWakeProbability: number,
    mention = false,
  ): NotificationDecision {
    const topNotification = {
      source: "QQ",
      content: `${senderName}: ${truncate(content, 35)}`,
      occurredAt: Date.now(),
    };

    if (importance === "no_push") return { signal: "none", wakes: false, visibleOnPhone: false };
    if (importance === "do_not_disturb") return { signal: "none", wakes: false, visibleOnPhone: true };
    if (targetKind === "group" && !mention) {
      if (importance === "priority_plus") return { signal: "vibration", wakes: !sleeping, visibleOnPhone: true, topNotification };
      return { signal: "none", wakes: false, visibleOnPhone: true };
    }
    if (importance === "priority_plus") return { signal: "special_ring", wakes: true, visibleOnPhone: true, topNotification };
    if (importance === "priority") {
      return { signal: "ring", wakes: !sleeping || random() < priorityWakeProbability, visibleOnPhone: true, topNotification };
    }
    return { signal: "vibration", wakes: !sleeping, visibleOnPhone: true, topNotification };
  }
}
