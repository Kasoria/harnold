import { randomUUID } from "node:crypto";
import type { PermissionMode } from "../backends/types.ts";
import { database } from "../db.ts";
import { decryptSecret, encryptSecret } from "../secrets.ts";
import { channelFieldDefinitions, type ChannelType } from "./types.ts";

database.exec(`
  CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    project_id TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    permission_mode TEXT NOT NULL DEFAULT 'default',
    allowed_senders TEXT NOT NULL DEFAULT '[]',
    settings TEXT NOT NULL DEFAULT '{}',
    secrets TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS channel_conversations (
    channel_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (channel_id, chat_id)
  );
`);

// Migration: spoken replies setting (added after the first release of channels).
try {
  database.exec("ALTER TABLE channels ADD COLUMN voice_replies TEXT NOT NULL DEFAULT 'voice'");
} catch {
  /* column exists */
}

// Migration: access scope (one project or the whole Harnold instance).
try {
  database.exec("ALTER TABLE channels ADD COLUMN scope TEXT NOT NULL DEFAULT 'project'");
} catch {
  /* column exists */
}

/** "project": every conversation runs in projectId. "workspace": starts in Quick Chats and may switch to any project. */
export type ChannelScope = "project" | "workspace";

export type VoiceReplyMode = "off" | "voice" | "always";

export type Channel = {
  id: string;
  type: ChannelType;
  name: string;
  scope: ChannelScope;
  /** Fixed project (scope "project") or where new conversations start (scope "workspace": Quick Chats). */
  projectId: string;
  enabled: boolean;
  permissionMode: PermissionMode;
  allowedSenders: string[];
  voiceReplies: VoiceReplyMode;
  settings: Record<string, string>;
  secrets: Record<string, string>;
  createdAt: number;
};

/** Client-facing shape: secrets replaced by "is set" flags. */
export type PublicChannel = Omit<Channel, "secrets"> & { secretsSet: Record<string, boolean> };

export type ChannelInput = Omit<Channel, "id" | "createdAt" | "secrets"> & { secrets: Record<string, string | undefined> };

type Row = Record<string, unknown>;

const mapChannel = (row: Row): Channel => ({
  id: String(row.id),
  type: String(row.type) as ChannelType,
  name: String(row.name),
  scope: (row.scope ? String(row.scope) : "project") as ChannelScope,
  projectId: String(row.project_id),
  enabled: Boolean(row.enabled),
  permissionMode: String(row.permission_mode) as PermissionMode,
  allowedSenders: JSON.parse(String(row.allowed_senders)),
  voiceReplies: (row.voice_replies ? String(row.voice_replies) : "voice") as VoiceReplyMode,
  settings: JSON.parse(String(row.settings)),
  secrets: row.secrets ? JSON.parse(decryptSecret(String(row.secrets))) : {},
  createdAt: Number(row.created_at),
});

export function toPublicChannel(channel: Channel): PublicChannel {
  const { secrets, ...rest } = channel;
  return {
    ...rest,
    secretsSet: Object.fromEntries(channelFieldDefinitions[channel.type].secrets.map((secretName) => [secretName, Boolean(secrets[secretName])])),
  };
}

export const channelStore = {
  list(): Channel[] {
    return database.prepare("SELECT * FROM channels ORDER BY created_at").all().map(mapChannel);
  },
  get(channelId: string): Channel | undefined {
    const row = database.prepare("SELECT * FROM channels WHERE id = ?").get(channelId);
    return row ? mapChannel(row) : undefined;
  },
  /** Empty/undefined secret values keep the stored value (clients never see secrets). */
  save(channelInput: ChannelInput, channelId?: string): Channel {
    const existing = channelId ? channelStore.get(channelId) : undefined;
    const fieldDefinition = channelFieldDefinitions[channelInput.type];
    const mergedSecrets: Record<string, string> = {};
    for (const secretName of fieldDefinition.secrets) {
      const submittedValue = channelInput.secrets[secretName]?.trim();
      const value = submittedValue || existing?.secrets[secretName];
      if (value) mergedSecrets[secretName] = value;
    }
    const settings = Object.fromEntries(fieldDefinition.settings.map((settingName) => [settingName, channelInput.settings[settingName]?.trim() ?? ""]));
    const channel: Channel = {
      ...channelInput,
      settings,
      secrets: mergedSecrets,
      allowedSenders: channelInput.allowedSenders.map((sender) => sender.trim()).filter(Boolean),
      id: existing?.id ?? randomUUID(),
      createdAt: existing?.createdAt ?? Date.now(),
    };
    database
      .prepare(
        `INSERT INTO channels (id, type, name, scope, project_id, enabled, permission_mode, allowed_senders, voice_replies, settings, secrets, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET type = excluded.type, name = excluded.name, scope = excluded.scope, project_id = excluded.project_id, enabled = excluded.enabled,
           permission_mode = excluded.permission_mode, allowed_senders = excluded.allowed_senders, voice_replies = excluded.voice_replies,
           settings = excluded.settings, secrets = excluded.secrets`,
      )
      .run(
        channel.id, channel.type, channel.name, channel.scope, channel.projectId, channel.enabled ? 1 : 0, channel.permissionMode,
        JSON.stringify(channel.allowedSenders), channel.voiceReplies, JSON.stringify(channel.settings), encryptSecret(JSON.stringify(channel.secrets)), channel.createdAt,
      );
    return channel;
  },
  remove(channelId: string): void {
    database.prepare("DELETE FROM channel_conversations WHERE channel_id = ?").run(channelId);
    database.prepare("DELETE FROM channels WHERE id = ?").run(channelId);
  },
};

export const conversationStore = {
  sessionFor(channelId: string, chatId: string): string | undefined {
    const row = database.prepare("SELECT session_id FROM channel_conversations WHERE channel_id = ? AND chat_id = ?").get(channelId, chatId);
    return row ? String(row.session_id) : undefined;
  },
  link(channelId: string, chatId: string, sessionId: string): void {
    database
      .prepare(
        `INSERT INTO channel_conversations (channel_id, chat_id, session_id, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(channel_id, chat_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at`,
      )
      .run(channelId, chatId, sessionId, Date.now());
  },
  findBySession(sessionId: string): { channelId: string; chatId: string } | undefined {
    const row = database.prepare("SELECT channel_id, chat_id FROM channel_conversations WHERE session_id = ?").get(sessionId);
    return row ? { channelId: String(row.channel_id), chatId: String(row.chat_id) } : undefined;
  },
};
