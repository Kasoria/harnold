import { mailAutonomyLabels, mailInboxStore, mailMessageStore, type MailInbox } from "./inbox.ts";
import { createMailTransport, type MailContent } from "./transport.ts";
import { mailToolContext } from "./tools.ts";
import { agentRuntime } from "../agent.ts";
import { database, projectStore, sessionStore } from "../db.ts";
import { quickChatProject } from "../quick-chats.ts";
import { eventHub } from "../events.ts";

/** Polling loop handing new mails to the bound agent, one turn per mail. */
const pollIntervalMs = 60_000;

export type MailboxStatus = { state: "connected" | "connecting" | "error" | "stopped"; error?: string };

const statuses = new Map<string, MailboxStatus>();
const timers = new Map<string, NodeJS.Timeout>();

function setStatus(inboxId: string, status: MailboxStatus): void {
  statuses.set(inboxId, status);
  eventHub.publish({ type: "mail_changed" });
}

function projectFor(inbox: MailInbox): string {
  return inbox.scope === "global" ? quickChatProject().id : inbox.projectId;
}

function autonomyInstruction(inbox: MailInbox): string {
  switch (inbox.autonomy) {
    case "readonly":
      return "Nur lesen und zusammenfassen (mail_record). Keine Änderungen, keine Entwürfe, kein Senden.";
    case "drafts":
      return "Antwort-Entwürfe anlegen (mail_draft_reply) und sortieren/markieren (mail_move, mail_flag). Nicht senden.";
    case "approve":
      return "Antwort-Entwürfe zur Freigabe erstellen (mail_draft_reply). Nicht direkt senden.";
    case "auto":
      return "Vollautonom: darf auch direkt senden (mail_send).";
  }
}

function buildPrompt(inbox: MailInbox, mail: MailContent): string {
  const body = (mail.text || (typeof mail.html === "string" ? mail.html : "")).slice(0, 15_000);
  return [
    `Neue E-Mail im Postfach „${inbox.name}“ (Ordner ${mail.folder}, UID ${mail.uid}).`,
    `Von: ${mail.fromName} <${mail.fromAddress}>`,
    mail.toAddresses.length ? `An: ${mail.toAddresses.join(", ")}` : "",
    `Betreff: ${mail.subject || "(ohne Betreff)"}`,
    mail.date ? `Datum: ${mail.date.toISOString()}` : "",
    mail.messageId ? `Message-ID: ${mail.messageId}` : "",
    "",
    body,
    "",
    `[Harnold: Du bearbeitest dieses Postfach im Namen des Users. Autonomie-Stufe: ${mailAutonomyLabels[inbox.autonomy]} – ${autonomyInstruction(inbox)} Fasse die Mail zusammen, beantworte oder sortiere sie passend. Nutze dafür die mail_*-Tools (mail_read_message, mail_record, mail_draft_reply, mail_move, mail_flag, mail_send).]`,
  ]
    .filter(Boolean)
    .join("\n");
}

async function processMail(inbox: MailInbox, mail: MailContent): Promise<void> {
  const projectId = projectFor(inbox);
  if (!projectStore.get(projectId)) return;
  const session = sessionStore.create(projectId, `Mail: ${mail.subject.slice(0, 60) || "Ohne Betreff"}`, undefined, inbox.agentId);
  database.prepare("UPDATE sessions SET mail_inbox_id = ? WHERE id = ?").run(inbox.id, session.id);
  eventHub.publish({ type: "sessions_changed", projectId });
  mailMessageStore.upsert({
    inboxId: inbox.id,
    uid: mail.uid,
    folder: mail.folder,
    subject: mail.subject,
    fromAddress: mail.fromAddress,
    fromName: mail.fromName,
    snippet: (mail.text || "").slice(0, 200),
    status: "new",
    sessionId: session.id,
  });
  mailToolContext.set(session.id, { inboxId: inbox.id });
  try {
    const outcome = await agentRuntime.runTurn({ sessionId: session.id, text: buildPrompt(inbox, mail), permissionMode: "acceptEdits" });
    mailMessageStore.upsert({
      inboxId: inbox.id,
      uid: mail.uid,
      folder: mail.folder,
      status: outcome.success ? "processed" : "ignored",
      action: (outcome.finalText || outcome.errorText || "").slice(0, 200),
      sessionId: session.id,
    });
  } catch (turnError) {
    mailMessageStore.upsert({
      inboxId: inbox.id,
      uid: mail.uid,
      folder: mail.folder,
      status: "ignored",
      action: turnError instanceof Error ? turnError.message : String(turnError),
    });
  } finally {
    mailToolContext.clear(session.id);
  }
}

async function pollInbox(inboxId: string): Promise<void> {
  const inbox = mailInboxStore.get(inboxId);
  if (!inbox || !inbox.enabled) return;
  const transport = createMailTransport(inbox);
  try {
    await transport.verify();
  } catch (verifyError) {
    setStatus(inboxId, { state: "error", error: verifyError instanceof Error ? verifyError.message : String(verifyError) });
    return;
  }
  try {
    const unseen = await transport.fetchUnseen("INBOX");
    setStatus(inboxId, { state: "connected" });
    for (const mail of unseen) {
      if (mailMessageStore.byUid(inboxId, mail.folder, mail.uid)) continue;
      await transport.markSeen(mail.folder, mail.uid);
      await processMail(inbox, mail).catch((processError) => console.error("[mail] process failed:", processError));
    }
  } catch (pollError) {
    setStatus(inboxId, { state: "error", error: pollError instanceof Error ? pollError.message : String(pollError) });
  }
}

export const mailManager = {
  statusOf(inboxId: string): MailboxStatus {
    return statuses.get(inboxId) ?? { state: "stopped" };
  },

  async stop(inboxId: string): Promise<void> {
    const timer = timers.get(inboxId);
    if (timer) clearInterval(timer);
    timers.delete(inboxId);
    setStatus(inboxId, { state: "stopped" });
  },

  async start(inboxId: string): Promise<void> {
    await mailManager.stop(inboxId);
    const inbox = mailInboxStore.get(inboxId);
    if (!inbox || !inbox.enabled) return;
    setStatus(inboxId, { state: "connecting" });
    await pollInbox(inboxId);
    timers.set(inboxId, setInterval(() => void pollInbox(inboxId).catch((pollError) => console.error("[mail] poll failed:", pollError)), pollIntervalMs));
  },

  startAll(): void {
    for (const inbox of mailInboxStore.list()) void mailManager.start(inbox.id);
  },
};
