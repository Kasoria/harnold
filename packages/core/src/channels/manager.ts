import { projectStore, sessionStore } from "../db.ts";
import { agentRuntime } from "../agent.ts";
import { eventHub } from "../events.ts";
import { setTaskRunNotifier } from "../tasks.ts";
import { synthesize, toOggOpus, transcribe, voiceConfig } from "../voice.ts";
import { channelStore, conversationStore, type Channel } from "./store.ts";
import type { ChannelAdapter, ChannelAdapterContext, ChannelType, InboundMessage } from "./types.ts";
import { createTelegramAdapter } from "./telegram.ts";
import { createDiscordAdapter } from "./discord.ts";
import { createSlackAdapter } from "./slack.ts";
import { createEmailAdapter } from "./email.ts";

export type ChannelStatus = { state: "connected" | "connecting" | "error" | "stopped"; error?: string };

const adapterFactories: Record<ChannelType, (context: ChannelAdapterContext) => ChannelAdapter> = {
  telegram: createTelegramAdapter,
  discord: createDiscordAdapter,
  slack: createSlackAdapter,
  email: createEmailAdapter,
};

const channelTypeLabels: Record<ChannelType, string> = { telegram: "Telegram", discord: "Discord", slack: "Slack", email: "E-Mail" };

const activeAdapters = new Map<string, ChannelAdapter>();
const channelStatuses = new Map<string, ChannelStatus>();
/** Open permission request per conversation, for "ja"/"nein" text answers. */
const pendingPermissionByConversation = new Map<string, string>();

const conversationKey = (channelId: string, chatId: string) => `${channelId}::${chatId}`;

function setStatus(channelId: string, status: ChannelStatus): void {
  channelStatuses.set(channelId, status);
  eventHub.publish({ type: "channels_changed" });
}

function describeToolInput(toolName: string, input: unknown): string {
  const inputRecord = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const primaryValue = inputRecord.command ?? inputRecord.file_path ?? inputRecord.path ?? inputRecord.url ?? inputRecord.pattern;
  return `${toolName}${typeof primaryValue === "string" ? `: ${primaryValue}` : ""}`;
}

function sessionForConversation(channel: Channel, inboundMessage: InboundMessage, forceNew = false): string {
  const existingSessionId = conversationStore.sessionFor(channel.id, inboundMessage.chatId);
  if (existingSessionId && !forceNew && sessionStore.get(existingSessionId)) return existingSessionId;
  const session = sessionStore.create(channel.projectId, `${channelTypeLabels[channel.type]} · ${inboundMessage.senderName}`);
  conversationStore.link(channel.id, inboundMessage.chatId, session.id);
  eventHub.publish({ type: "sessions_changed", projectId: channel.projectId });
  return session.id;
}

async function handleInbound(channelId: string, inboundMessage: InboundMessage): Promise<void> {
  const channel = channelStore.get(channelId);
  const adapter = activeAdapters.get(channelId);
  if (!channel || !adapter) return;
  const reply = (text: string) => adapter.sendMessage(inboundMessage.chatId, text).catch((sendError) => console.error(`[channels] reply failed:`, sendError));

  if (!channel.allowedSenders.includes(inboundMessage.senderId)) {
    // Never answer unknown e-mail senders (spam); chat platforms get their ID so the owner can allow it.
    if (channel.type !== "email") await reply(`Nicht freigeschaltet. Deine ID: ${inboundMessage.senderId}`);
    return;
  }
  if (!projectStore.get(channel.projectId)) {
    await reply("Das verknüpfte Projekt existiert nicht mehr.");
    return;
  }

  let trimmedText = inboundMessage.text.trim();
  const receivedVoice = Boolean(inboundMessage.audio);
  if (inboundMessage.audio) {
    try {
      const transcript = await transcribe(inboundMessage.audio);
      if (!transcript) {
        await reply("Ich konnte in der Sprachnachricht nichts verstehen.");
        return;
      }
      await reply(`🎙 „${transcript}“`);
      trimmedText = [trimmedText, transcript].filter(Boolean).join("\n\n");
    } catch (transcriptionError) {
      await reply(`⚠️ Sprachnachricht nicht verarbeitet: ${transcriptionError instanceof Error ? transcriptionError.message : String(transcriptionError)}`);
      return;
    }
  }
  if (/^\/(neu|new)\b/i.test(trimmedText)) {
    sessionForConversation(channel, inboundMessage, true);
    await reply("Neue Session gestartet.");
    return;
  }
  if (/^\/start\b/i.test(trimmedText)) {
    await reply("Hallo! Schreib mir einfach. /neu startet eine neue Session.");
    return;
  }

  const pendingRequestId = pendingPermissionByConversation.get(conversationKey(channel.id, inboundMessage.chatId));
  if (pendingRequestId) {
    if (/^(ja|yes|ok|erlauben)\b/i.test(trimmedText)) return void agentRuntime.resolvePermission(pendingRequestId, true);
    if (/^(nein|no|ablehnen)\b/i.test(trimmedText)) return void agentRuntime.resolvePermission(pendingRequestId, false);
  }

  const sessionId = sessionForConversation(channel, inboundMessage);
  if (agentRuntime.isRunning(sessionId)) {
    await reply("Ich arbeite noch an der letzten Nachricht …");
    return;
  }

  void adapter.indicateTyping?.(inboundMessage.chatId);
  const typingInterval = setInterval(() => void adapter.indicateTyping?.(inboundMessage.chatId), 4500);
  try {
    const turnOutcome = await agentRuntime.runTurn({ sessionId, text: trimmedText, permissionMode: channel.permissionMode });
    const replyText = turnOutcome.success ? turnOutcome.finalText || "Erledigt." : `⚠️ ${turnOutcome.errorText || "Fehlgeschlagen"}`;
    await reply(replyText);

    const wantsSpokenReply = channel.voiceReplies === "always" || (channel.voiceReplies === "voice" && receivedVoice);
    if (turnOutcome.success && wantsSpokenReply && adapter.sendVoice && voiceConfig.present().ttsReady) {
      try {
        const spokenReply = await synthesize(replyText);
        const voiceClip = await toOggOpus(spokenReply).catch(() => spokenReply);
        await adapter.sendVoice(inboundMessage.chatId, voiceClip);
      } catch (speechError) {
        console.error("[channels] spoken reply failed:", speechError);
      }
    }
  } finally {
    clearInterval(typingInterval);
  }
}

export const channelManager = {
  statusOf(channelId: string): ChannelStatus {
    return channelStatuses.get(channelId) ?? { state: "stopped" };
  },

  async stop(channelId: string): Promise<void> {
    const adapter = activeAdapters.get(channelId);
    activeAdapters.delete(channelId);
    if (adapter) await adapter.stop().catch((stopError) => console.error("[channels] stop failed:", stopError));
    setStatus(channelId, { state: "stopped" });
  },

  async start(channelId: string): Promise<void> {
    await channelManager.stop(channelId);
    const channel = channelStore.get(channelId);
    if (!channel || !channel.enabled) return;
    setStatus(channelId, { state: "connecting" });
    try {
      const adapter = adapterFactories[channel.type]({
        settings: channel.settings,
        secrets: channel.secrets,
        onInbound: (inboundMessage) => void handleInbound(channelId, inboundMessage).catch((inboundError) => console.error("[channels] inbound failed:", inboundError)),
        onPermissionAnswer: (requestId, allow) => void agentRuntime.resolvePermission(requestId, allow),
      });
      activeAdapters.set(channelId, adapter);
      await adapter.start();
      setStatus(channelId, { state: "connected" });
    } catch (startError) {
      activeAdapters.delete(channelId);
      setStatus(channelId, { state: "error", error: startError instanceof Error ? startError.message : String(startError) });
    }
  },

  async sendTo(channelId: string, chatId: string, text: string): Promise<void> {
    const adapter = activeAdapters.get(channelId);
    if (!adapter) throw new Error("Channel ist nicht verbunden");
    await adapter.sendMessage(chatId, text);
  },

  startAll(): void {
    for (const channel of channelStore.list()) void channelManager.start(channel.id);

    // Forward tool approvals of channel sessions into the channel.
    eventHub.subscribe((serverEvent) => {
      if (serverEvent.type === "permission_request") {
        const conversation = conversationStore.findBySession(serverEvent.sessionId);
        const adapter = conversation && activeAdapters.get(conversation.channelId);
        if (!conversation || !adapter) return;
        pendingPermissionByConversation.set(conversationKey(conversation.channelId, conversation.chatId), serverEvent.requestId);
        void adapter
          .sendPermissionRequest(conversation.chatId, serverEvent.requestId, describeToolInput(serverEvent.toolName, serverEvent.input))
          .catch((sendError) => console.error("[channels] permission request failed:", sendError));
      } else if (serverEvent.type === "permission_resolved") {
        for (const [key, requestId] of pendingPermissionByConversation) {
          if (requestId === serverEvent.requestId) pendingPermissionByConversation.delete(key);
        }
      }
    });

    setTaskRunNotifier(async (task, message) => {
      if (task.notifyChannelId && task.notifyChatId) await channelManager.sendTo(task.notifyChannelId, task.notifyChatId, message);
    });
  },
};
