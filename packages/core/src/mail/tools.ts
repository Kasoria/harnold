import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { mailActionStore, mailInboxStore, mailAutonomyLabels, withSignature, type MailAutonomy, type MailActionStatus } from "./inbox.ts";
import { createMailTransport } from "./transport.ts";
import { teamStore } from "../agents.ts";
import { t } from "../i18n.ts";

/**
 * Mail tools for an agent that is bound to a mailbox (the "KI im Postfach" integration). The active mailbox is
 * resolved from the running session, so these tools only work while the mailbox manager runs a turn.
 */

export type MailToolContext = { inboxId: string };

const contextBySession = new Map<string, MailToolContext>();

export const mailToolContext = {
  set(sessionId: string, context: MailToolContext): void {
    contextBySession.set(sessionId, context);
  },
  clear(sessionId: string): void {
    contextBySession.delete(sessionId);
  },
  forSession(sessionId: string): MailToolContext | undefined {
    return contextBySession.get(sessionId);
  },
};

const autonomyRank: Record<MailAutonomy, number> = { readonly: 0, drafts: 1, approve: 2, auto: 3 };

const textResult = (text: string) => ({ content: [{ type: "text" as const, text }] });
const errorResult = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

function requireInbox(sessionId: string) {
  const context = mailToolContext.forSession(sessionId);
  if (!context) throw new Error(t("Kein Postfach in dieser Session gebunden – die Mail-Tools gelten nur, wenn Harnold ein Postfach bearbeitet."));
  const inbox = mailInboxStore.get(context.inboxId);
  if (!inbox) throw new Error(t("Postfach nicht gefunden"));
  return inbox;
}

function requireLevel(inbox: ReturnType<typeof requireInbox>, level: MailAutonomy): void {
  if (autonomyRank[inbox.autonomy] < autonomyRank[level]) {
    throw new Error(t("Nicht erlaubt: dieses Postfach ist auf „{0}“ gestellt (nötig: {1}).", mailAutonomyLabels[inbox.autonomy], mailAutonomyLabels[level]));
  }
}

/** Tools for the agent running in `sessionId`; harmless when no mailbox is bound. */
export function createMailTools(sessionId: string) {
  return [
    tool(
      "mail_list_inboxes",
      "Listet die eingerichteten E-Mail-Postfächer (Integration „KI im Postfach“) mit Agent, Scope und Autonomie-Stufe.",
      {},
      async () => {
        try {
          const lines = mailInboxStore.list().map((inbox) => {
            const agentName = inbox.agentId ? (teamStore.get(inbox.agentId)?.name ?? "?") : "Standard-Agent";
            return `${inbox.name} – id ${inbox.id} – Agent ${agentName} – ${inbox.scope === "global" ? "global" : "Projekt"} – ${mailAutonomyLabels[inbox.autonomy]} – ${inbox.enabled ? "aktiv" : "pausiert"}`;
          });
          return textResult(lines.join("\n") || "Keine Postfächer eingerichtet (Screen Postfach).");
        } catch (toolError) {
          return errorResult(toolError instanceof Error ? toolError.message : String(toolError));
        }
      },
      { annotations: { readOnlyHint: true } },
    ),
    tool(
      "mail_list_folders",
      "Listet die Ordner des aktuell gebundenen Postfachs.",
      {},
      async () => {
        try {
          const inbox = requireInbox(sessionId);
          const folders = await createMailTransport(inbox).listFolders();
          return textResult(folders.map((folder) => `${folder.path}${folder.specialUse ? ` (${folder.specialUse})` : ""}`).join("\n") || "Keine Ordner.");
        } catch (toolError) {
          return errorResult(toolError instanceof Error ? toolError.message : String(toolError));
        }
      },
      { annotations: { readOnlyHint: true } },
    ),
    tool(
      "mail_read_message",
      "Liest eine Mail des gebundenen Postfachs vollständig (folder + IMAP-UID).",
      { folder: z.string().default("INBOX"), uid: z.string().min(1) },
      async ({ folder, uid }) => {
        try {
          const inbox = requireInbox(sessionId);
          const message = await createMailTransport(inbox).readMessage(folder, uid);
          if (!message) return errorResult("Mail nicht gefunden.");
          return textResult(
            `Von: ${message.fromName} <${message.fromAddress}>\nBetreff: ${message.subject}\nDatum: ${message.date ? message.date.toISOString() : "–"}\n\n${message.text || message.html || "(leer)"}`,
          );
        } catch (toolError) {
          return errorResult(toolError instanceof Error ? toolError.message : String(toolError));
        }
      },
      { annotations: { readOnlyHint: true } },
    ),
    tool(
      "mail_record",
      "Hält eine Zusammenfassung oder einen Digest im Postfach-Log fest (erscheint im Postfach-Screen). Ändert nichts im Postfach.",
      {
        kind: z.enum(["summary", "digest"]).describe("summary = Zusammenfassung einer Mail, digest = gebündelte Übersicht mehrerer Mails"),
        description: z.string().min(1),
        messageId: z.string().optional().describe("Id der zugehörigen Mail, falls vorhanden"),
      },
      async ({ kind, description, messageId }) => {
        try {
          const inbox = requireInbox(sessionId);
          const action = mailActionStore.add({ inboxId: inbox.id, messageId: messageId ?? null, kind, description });
          return textResult(`Gespeichert (${action.kind}).`);
        } catch (toolError) {
          return errorResult(toolError instanceof Error ? toolError.message : String(toolError));
        }
      },
    ),
    tool(
      "mail_draft_reply",
      "Erstellt einen Antwort-Entwurf auf eine Mail. Bei Autonomie „Mit Freigabe“ wird er im Postfach-Screen zur Freigabe vorgelegt; bei „Entwürfe“ wird er direkt als Entwurf im Postfach gespeichert. Die Signatur des Postfachs wird automatisch ergänzt.",
      {
        to: z.string().describe("Empfängeradresse"),
        subject: z.string(),
        text: z.string().min(1),
        messageId: z.string().optional().describe("Message-ID der Mail, auf die geantwortet wird (für Threading)"),
      },
      async ({ to, subject, text, messageId }) => {
        try {
          const inbox = requireInbox(sessionId);
          requireLevel(inbox, "drafts");
          const signedText = withSignature(text, inbox);
          if (inbox.autonomy === "approve") {
            const action = mailActionStore.add({
              inboxId: inbox.id,
              messageId: messageId ?? null,
              kind: "draft",
              description: `Entwurf an ${to}: ${subject}`,
              payload: { to, subject, text: signedText, inReplyTo: messageId ?? "" },
              status: "pending",
            });
            return textResult(`Entwurf zur Freigabe vorgemerkt (id ${action.id}). Der Nutzer gibt ihn im Postfach-Screen frei.`);
          }
          await createMailTransport(inbox).saveDraft(subject, to, signedText, messageId);
          mailActionStore.add({ inboxId: inbox.id, messageId: messageId ?? null, kind: "draft", description: `Entwurf an ${to}: ${subject}` });
          return textResult("Entwurf im Postfach gespeichert.");
        } catch (toolError) {
          return errorResult(toolError instanceof Error ? toolError.message : String(toolError));
        }
      },
    ),
    tool(
      "mail_send",
      "Sendet eine Antwort direkt ab. Nur bei Autonomie „Vollautonom“ erlaubt.",
      {
        to: z.string().describe("Empfängeradresse"),
        subject: z.string(),
        text: z.string().min(1),
        messageId: z.string().optional().describe("Message-ID der Mail, auf die geantwortet wird (für Threading)"),
      },
      async ({ to, subject, text, messageId }) => {
        try {
          const inbox = requireInbox(sessionId);
          requireLevel(inbox, "auto");
          await createMailTransport(inbox).sendMail(to, subject, withSignature(text, inbox), { inReplyTo: messageId, messageId, references: messageId });
          mailActionStore.add({ inboxId: inbox.id, messageId: messageId ?? null, kind: "sent", description: `Gesendet an ${to}: ${subject}` });
          return textResult(`Gesendet an ${to}.`);
        } catch (toolError) {
          return errorResult(toolError instanceof Error ? toolError.message : String(toolError));
        }
      },
    ),
    tool(
      "mail_move",
      "Verschiebt eine Mail in einen anderen Ordner (z. B. Archive, Trash).",
      { folder: z.string().default("INBOX"), uid: z.string().min(1), destination: z.string().min(1) },
      async ({ folder, uid, destination }) => {
        try {
          const inbox = requireInbox(sessionId);
          requireLevel(inbox, "drafts");
          await createMailTransport(inbox).move(folder, uid, destination);
          mailActionStore.add({ inboxId: inbox.id, messageId: uid, kind: "moved", description: `Verschoben nach ${destination}` });
          return textResult(`Verschoben nach ${destination}.`);
        } catch (toolError) {
          return errorResult(toolError instanceof Error ? toolError.message : String(toolError));
        }
      },
    ),
    tool(
      "mail_flag",
      "Setzt Flags auf einer Mail (z. B. \\Flagged, \\Seen).",
      { folder: z.string().default("INBOX"), uid: z.string().min(1), flags: z.array(z.string()).min(1) },
      async ({ folder, uid, flags }) => {
        try {
          const inbox = requireInbox(sessionId);
          requireLevel(inbox, "drafts");
          await createMailTransport(inbox).setFlag(folder, uid, flags);
          mailActionStore.add({ inboxId: inbox.id, messageId: uid, kind: "flagged", description: `Flags: ${flags.join(", ")}` });
          return textResult(`Flags gesetzt: ${flags.join(", ")}.`);
        } catch (toolError) {
          return errorResult(toolError instanceof Error ? toolError.message : String(toolError));
        }
      },
    ),
  ];
}

/** Names the user may approve without being asked are none: mail tools go through the normal permission flow. */
export const mailToolNames = ["mail_list_inboxes", "mail_list_folders", "mail_read_message", "mail_record", "mail_draft_reply", "mail_send", "mail_move", "mail_flag"];

/** Resolve a pending draft approval: send it (allow) or reject it. */
export async function resolveDraft(inboxId: string, actionId: string, allow: boolean): Promise<MailActionStatus> {
  const action = mailActionStore.get(actionId);
  if (!action || action.inboxId !== inboxId || action.status !== "pending") throw new Error(t("Entwurf nicht gefunden oder nicht mehr offen"));
  const inbox = mailInboxStore.get(inboxId);
  if (!inbox) throw new Error(t("Postfach nicht gefunden"));
  if (!allow) {
    mailActionStore.setStatus(actionId, "rejected");
    return "rejected";
  }
  const payload = action.payload as { to?: string; subject?: string; text?: string; inReplyTo?: string };
  if (!payload.to || !payload.subject || !payload.text) throw new Error(t("Entwurf unvollständig"));
  await createMailTransport(inbox).sendMail(payload.to, payload.subject, payload.text, { inReplyTo: payload.inReplyTo || undefined });
  mailActionStore.setStatus(actionId, "sent");
  return "sent";
}
