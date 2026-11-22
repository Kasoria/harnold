import { randomUUID } from "node:crypto";
import { z } from "zod";
import { database, projectStore } from "../db.ts";
import { decryptSecret, encryptSecret } from "../secrets.ts";
import { eventHub } from "../events.ts";
import { t } from "../i18n.ts";

/**
 * E-Mail as an integration ("KI im Postfach"): a mailbox is bound to a team agent that reads, summarizes,
 * sorts and answers the user's mail on their behalf. Not a channel – no user ↔ Harnold conversation.
 */

database.exec(`
  CREATE TABLE IF NOT EXISTS mail_inboxes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'project',
    project_id TEXT NOT NULL DEFAULT '',
    agent_id TEXT,
    autonomy TEXT NOT NULL DEFAULT 'approve',
    enabled INTEGER NOT NULL DEFAULT 1,
    settings TEXT NOT NULL DEFAULT '{}',
    secrets TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mail_messages (
    id TEXT PRIMARY KEY,
    inbox_id TEXT NOT NULL,
    uid TEXT NOT NULL,
    folder TEXT NOT NULL DEFAULT 'INBOX',
    subject TEXT NOT NULL DEFAULT '',
    from_address TEXT NOT NULL DEFAULT '',
    from_name TEXT NOT NULL DEFAULT '',
    snippet TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'new',
    action TEXT NOT NULL DEFAULT '',
    session_id TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(inbox_id, folder, uid)
  );
  CREATE TABLE IF NOT EXISTS mail_actions (
    id TEXT PRIMARY KEY,
    inbox_id TEXT NOT NULL,
    message_id TEXT,
    kind TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    payload TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'done',
    created_at INTEGER NOT NULL
  );
`);

/** How autonomous the bound agent may act. Enforced server-side by the mail tools, not just by the prompt. */
export type MailAutonomy = "readonly" | "drafts" | "approve" | "auto";

export const mailAutonomyLabels: Record<MailAutonomy, string> = {
  readonly: "Nur lesen",
  drafts: "Entwürfe",
  approve: "Mit Freigabe",
  auto: "Vollautonom",
};

export const mailAutonomyOrder: MailAutonomy[] = ["readonly", "drafts", "approve", "auto"];

export type MailScope = "project" | "global";

/** Field definitions per mailbox. Secret fields are stored encrypted and never sent back to clients. */
export const mailInboxFieldDefinitions: { settings: string[]; secrets: string[] } = {
  settings: ["imapHost", "imapPort", "smtpHost", "smtpPort", "username", "fromAddress"],
  secrets: ["password"],
};

export const mailInboxInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  scope: z.enum(["project", "global"]),
  projectId: z.string().default(""),
  agentId: z.string().nullable(),
  autonomy: z.enum(["readonly", "drafts", "approve", "auto"]),
  enabled: z.boolean(),
  settings: z.record(z.string(), z.string()),
  secrets: z.record(z.string(), z.string().optional()),
});
export type MailInboxInput = z.infer<typeof mailInboxInputSchema>;

export type MailInbox = {
  id: string;
  name: string;
  scope: MailScope;
  /** Empty for global mailboxes. */
  projectId: string;
  agentId: string | null;
  autonomy: MailAutonomy;
  enabled: boolean;
  settings: Record<string, string>;
  secrets: Record<string, string>;
  createdAt: number;
};

/** Client-facing shape: secrets replaced by "is set" flags. */
export type PublicMailInbox = Omit<MailInbox, "secrets"> & { secretsSet: Record<string, boolean>; agentName: string | null };

export type MailMessageStatus = "new" | "processed" | "ignored";

export type MailMessage = {
  id: string;
  inboxId: string;
  uid: string;
  folder: string;
  subject: string;
  fromAddress: string;
  fromName: string;
  snippet: string;
  status: MailMessageStatus;
  action: string;
  sessionId: string | null;
  createdAt: number;
};

export type MailActionKind = "summary" | "digest" | "draft" | "moved" | "flagged" | "sent";

/** done = finished; pending = waiting for the user (draft approval); sent/rejected = outcome of a pending draft. */
export type MailActionStatus = "done" | "pending" | "sent" | "rejected";

export type MailAction = {
  id: string;
  inboxId: string;
  messageId: string | null;
  kind: MailActionKind;
  description: string;
  status: MailActionStatus;
  payload: Record<string, unknown>;
  createdAt: number;
};

type Row = Record<string, unknown>;

const mapInbox = (row: Row): MailInbox => ({
  id: String(row.id),
  name: String(row.name),
  scope: String(row.scope) as MailScope,
  projectId: row.project_id ? String(row.project_id) : "",
  agentId: row.agent_id ? String(row.agent_id) : null,
  autonomy: String(row.autonomy) as MailAutonomy,
  enabled: Boolean(row.enabled),
  settings: JSON.parse(String(row.settings)),
  secrets: row.secrets ? JSON.parse(decryptSecret(String(row.secrets))) : {},
  createdAt: Number(row.created_at),
});

export function validateMailInboxInput(input: MailInboxInput): void {
  if (input.scope === "project" && !(input.projectId && projectStore.get(input.projectId))) throw new Error(t("Projekt fehlt"));
}

export const mailInboxStore = {
  list(): MailInbox[] {
    return (database.prepare("SELECT * FROM mail_inboxes ORDER BY created_at").all() as Row[]).map(mapInbox);
  },
  get(inboxId: string): MailInbox | undefined {
    const row = database.prepare("SELECT * FROM mail_inboxes WHERE id = ?").get(inboxId) as Row | undefined;
    return row ? mapInbox(row) : undefined;
  },
  save(input: MailInboxInput, inboxId?: string): MailInbox {
    validateMailInboxInput(input);
    const existing = inboxId ? mailInboxStore.get(inboxId) : undefined;
    if (inboxId && !existing) throw new Error(t("Postfach nicht gefunden"));
    const mergedSecrets: Record<string, string> = {};
    for (const secretName of mailInboxFieldDefinitions.secrets) {
      const submittedValue = input.secrets[secretName]?.trim();
      const value = submittedValue || existing?.secrets[secretName];
      if (value) mergedSecrets[secretName] = value;
    }
    const settings = Object.fromEntries(mailInboxFieldDefinitions.settings.map((settingName) => [settingName, input.settings[settingName]?.trim() ?? ""]));
    const inbox: MailInbox = {
      ...input,
      projectId: input.scope === "global" ? "" : input.projectId,
      settings,
      secrets: mergedSecrets,
      id: existing?.id ?? randomUUID(),
      createdAt: existing?.createdAt ?? Date.now(),
    };
    database
      .prepare(
        `INSERT INTO mail_inboxes (id, name, scope, project_id, agent_id, autonomy, enabled, settings, secrets, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, scope = excluded.scope, project_id = excluded.project_id, agent_id = excluded.agent_id,
           autonomy = excluded.autonomy, enabled = excluded.enabled, settings = excluded.settings, secrets = excluded.secrets`,
      )
      .run(
        inbox.id, inbox.name, inbox.scope, inbox.projectId, inbox.agentId, inbox.autonomy, inbox.enabled ? 1 : 0,
        JSON.stringify(inbox.settings), encryptSecret(JSON.stringify(inbox.secrets)), inbox.createdAt,
      );
    eventHub.publish({ type: "mail_changed" });
    return mailInboxStore.get(inbox.id)!;
  },
  remove(inboxId: string): void {
    database.prepare("DELETE FROM mail_messages WHERE inbox_id = ?").run(inboxId);
    database.prepare("DELETE FROM mail_actions WHERE inbox_id = ?").run(inboxId);
    database.prepare("DELETE FROM mail_inboxes WHERE id = ?").run(inboxId);
    eventHub.publish({ type: "mail_changed" });
  },
  /** Mailboxes an agent in this project may reach: global ones plus those bound to the project. */
  forProject(projectId: string): MailInbox[] {
    return mailInboxStore.list().filter((inbox) => inbox.scope === "global" || inbox.projectId === projectId);
  },
};

const mapMessage = (row: Row): MailMessage => ({
  id: String(row.id),
  inboxId: String(row.inbox_id),
  uid: String(row.uid),
  folder: String(row.folder),
  subject: String(row.subject),
  fromAddress: String(row.from_address),
  fromName: String(row.from_name),
  snippet: String(row.snippet),
  status: String(row.status) as MailMessageStatus,
  action: String(row.action),
  sessionId: row.session_id ? String(row.session_id) : null,
  createdAt: Number(row.created_at),
});

export const mailMessageStore = {
  byUid(inboxId: string, folder: string, uid: string): MailMessage | undefined {
    const row = database.prepare("SELECT * FROM mail_messages WHERE inbox_id = ? AND folder = ? AND uid = ?").get(inboxId, folder, uid) as Row | undefined;
    return row ? mapMessage(row) : undefined;
  },
  listByInbox(inboxId: string, limit = 100): MailMessage[] {
    return (database.prepare("SELECT * FROM mail_messages WHERE inbox_id = ? ORDER BY created_at DESC LIMIT ?").all(inboxId, limit) as Row[]).map(mapMessage);
  },
  upsert(input: {
    inboxId: string;
    uid: string;
    folder?: string;
    subject?: string;
    fromAddress?: string;
    fromName?: string;
    snippet?: string;
    status?: MailMessageStatus;
    action?: string;
    sessionId?: string | null;
  }): MailMessage {
    const existing = mailMessageStore.byUid(input.inboxId, input.folder ?? "INBOX", input.uid);
    const message: MailMessage = {
      id: existing?.id ?? randomUUID(),
      inboxId: input.inboxId,
      uid: input.uid,
      folder: input.folder ?? existing?.folder ?? "INBOX",
      subject: input.subject ?? existing?.subject ?? "",
      fromAddress: input.fromAddress ?? existing?.fromAddress ?? "",
      fromName: input.fromName ?? existing?.fromName ?? "",
      snippet: input.snippet ?? existing?.snippet ?? "",
      status: input.status ?? existing?.status ?? "new",
      action: input.action ?? existing?.action ?? "",
      sessionId: input.sessionId === undefined ? (existing?.sessionId ?? null) : input.sessionId,
      createdAt: existing?.createdAt ?? Date.now(),
    };
    database
      .prepare(
        `INSERT INTO mail_messages (id, inbox_id, uid, folder, subject, from_address, from_name, snippet, status, action, session_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET inbox_id = excluded.inbox_id, uid = excluded.uid, folder = excluded.folder, subject = excluded.subject,
           from_address = excluded.from_address, from_name = excluded.from_name, snippet = excluded.snippet, status = excluded.status,
           action = excluded.action, session_id = excluded.session_id`,
      )
      .run(
        message.id, message.inboxId, message.uid, message.folder, message.subject, message.fromAddress, message.fromName,
        message.snippet, message.status, message.action, message.sessionId, message.createdAt,
      );
    return message;
  },
};

const mapAction = (row: Row): MailAction => ({
  id: String(row.id),
  inboxId: String(row.inbox_id),
  messageId: row.message_id ? String(row.message_id) : null,
  kind: String(row.kind) as MailActionKind,
  description: String(row.description),
  status: String(row.status) as MailActionStatus,
  payload: JSON.parse(String(row.payload)),
  createdAt: Number(row.created_at),
});

export const mailActionStore = {
  get(actionId: string): MailAction | undefined {
    const row = database.prepare("SELECT * FROM mail_actions WHERE id = ?").get(actionId) as Row | undefined;
    return row ? mapAction(row) : undefined;
  },
  listByInbox(inboxId: string, limit = 100): MailAction[] {
    return (database.prepare("SELECT * FROM mail_actions WHERE inbox_id = ? ORDER BY created_at DESC LIMIT ?").all(inboxId, limit) as Row[]).map(mapAction);
  },
  pending(inboxId?: string): MailAction[] {
    const rows = inboxId
      ? (database.prepare("SELECT * FROM mail_actions WHERE status = 'pending' AND inbox_id = ? ORDER BY created_at DESC").all(inboxId) as Row[])
      : (database.prepare("SELECT * FROM mail_actions WHERE status = 'pending' ORDER BY created_at DESC").all() as Row[]);
    return rows.map(mapAction);
  },
  add(input: {
    inboxId: string;
    messageId?: string | null;
    kind: MailActionKind;
    description?: string;
    payload?: Record<string, unknown>;
    status?: MailActionStatus;
  }): MailAction {
    const action: MailAction = {
      id: randomUUID(),
      inboxId: input.inboxId,
      messageId: input.messageId ?? null,
      kind: input.kind,
      description: input.description ?? "",
      payload: input.payload ?? {},
      status: input.status ?? "done",
      createdAt: Date.now(),
    };
    database
      .prepare("INSERT INTO mail_actions (id, inbox_id, message_id, kind, description, payload, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(action.id, action.inboxId, action.messageId, action.kind, action.description, JSON.stringify(action.payload), action.status, action.createdAt);
    eventHub.publish({ type: "mail_changed" });
    return action;
  },
  setStatus(actionId: string, status: MailActionStatus): void {
    database.prepare("UPDATE mail_actions SET status = ? WHERE id = ?").run(status, actionId);
    eventHub.publish({ type: "mail_changed" });
  },
};
