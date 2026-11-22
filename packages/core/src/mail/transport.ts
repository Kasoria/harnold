import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { simpleParser } from "mailparser";
import type { MailInbox } from "./inbox.ts";
import { stripQuotedReply } from "./mail-parse.ts";

/** Normalized content of one mail, as handed to the agent. */
export type MailContent = {
  uid: string;
  folder: string;
  subject: string;
  fromAddress: string;
  fromName: string;
  toAddresses: string[];
  date: Date | null;
  text: string;
  html: string | false;
  messageId: string;
  references: string;
  inReplyTo: string;
};

export type MailFolder = { path: string; specialUse: string };

function imapOptions(inbox: MailInbox) {
  return {
    host: inbox.settings.imapHost,
    port: Number(inbox.settings.imapPort || 993),
    secure: true,
    auth: { user: inbox.settings.username, pass: inbox.secrets.password },
    logger: false as const,
  };
}

function smtpTransporter(inbox: MailInbox) {
  return nodemailer.createTransport({
    host: inbox.settings.smtpHost,
    port: Number(inbox.settings.smtpPort || 465),
    secure: Number(inbox.settings.smtpPort || 465) === 465,
    auth: { user: inbox.settings.username, pass: inbox.secrets.password },
  });
}

/** Runs `fn` on a fresh IMAP connection and always logs out. */
async function withImap<Result>(inbox: MailInbox, fn: (client: ImapFlow) => Promise<Result>): Promise<Result> {
  const client = new ImapFlow(imapOptions(inbox));
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => undefined);
  }
}

async function parsedFromSource(source: Buffer, uid: string, folder: string): Promise<MailContent> {
  const parsed = await simpleParser(source);
  const toObjects = Array.isArray(parsed.to) ? parsed.to : parsed.to ? [parsed.to] : [];
  return {
    uid,
    folder,
    subject: parsed.subject ?? "",
    fromAddress: parsed.from?.value?.[0]?.address ?? "",
    fromName: parsed.from?.value?.[0]?.name ?? "",
    toAddresses: toObjects.flatMap((recipient) => recipient.value ?? []).map((entry) => entry.address).filter((address): address is string => Boolean(address)),
    date: parsed.date ?? null,
    text: parsed.text ?? "",
    html: parsed.html ?? false,
    messageId: parsed.messageId ?? "",
    references: Array.isArray(parsed.references) ? parsed.references.join(" ") : (parsed.references ?? ""),
    inReplyTo: parsed.inReplyTo ?? "",
  };
}

export function createMailTransport(inbox: MailInbox) {
  return {
    async verify(): Promise<void> {
      const transporter = smtpTransporter(inbox);
      try {
        await transporter.verify();
      } finally {
        transporter.close();
      }
    },

    /** All mailboxes of this account, INBOX first. */
    async listFolders(): Promise<MailFolder[]> {
      return withImap(inbox, async (client) => {
        const list = await client.list();
        const folders = list.map((entry) => ({ path: String(entry.path ?? entry.name ?? ""), specialUse: String(entry.specialUse ?? "") })).filter((entry) => entry.path);
        const sorted = folders.sort((a, b) => {
          if (a.path === "INBOX") return -1;
          if (b.path === "INBOX") return 1;
          return a.path.localeCompare(b.path);
        });
        return sorted;
      });
    },

    /** Unseen mails of a folder (INBOX by default), newest first. */
    async fetchUnseen(folder = "INBOX"): Promise<MailContent[]> {
      return withImap(inbox, async (client) => {
        const lock = await client.getMailboxLock(folder);
        try {
          const unseenUids = (await client.search({ seen: false }, { uid: true })) || [];
          const contents: MailContent[] = [];
          for (const uid of unseenUids) {
            const fetched = await client.fetchOne(String(uid), { source: true }, { uid: true });
            if (!fetched || !fetched.source) continue;
            contents.push(await parsedFromSource(fetched.source, String(uid), folder));
          }
          return contents.reverse();
        } finally {
          lock.release();
        }
      });
    },

    async readMessage(folder: string, uid: string): Promise<MailContent | null> {
      return withImap(inbox, async (client) => {
        const lock = await client.getMailboxLock(folder);
        try {
          const fetched = await client.fetchOne(uid, { source: true }, { uid: true });
          if (!fetched || !fetched.source) return null;
          return parsedFromSource(fetched.source, uid, folder);
        } finally {
          lock.release();
        }
      });
    },

    async markSeen(folder: string, uid: string): Promise<void> {
      await withImap(inbox, async (client) => {
        const lock = await client.getMailboxLock(folder);
        try {
          await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
        } finally {
          lock.release();
        }
      });
    },

    async setFlag(folder: string, uid: string, flags: string[]): Promise<void> {
      await withImap(inbox, async (client) => {
        const lock = await client.getMailboxLock(folder);
        try {
          await client.messageFlagsAdd(uid, flags, { uid: true });
        } finally {
          lock.release();
        }
      });
    },

    async move(folder: string, uid: string, destination: string): Promise<void> {
      await withImap(inbox, async (client) => {
        const lock = await client.getMailboxLock(folder);
        try {
          await client.messageMove(uid, destination, { uid: true });
        } finally {
          lock.release();
        }
      });
    },

    /** Stores a draft into the mailbox's Drafts folder. */
    async saveDraft(subject: string, toAddress: string, text: string, inReplyTo?: string): Promise<void> {
      const headers = [
        `From: ${inbox.settings.fromAddress || inbox.settings.username}`,
        `To: ${toAddress}`,
        `Subject: ${subject}`,
        `Date: ${new Date().toUTCString()}`,
        ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
        "MIME-Version: 1.0",
        'Content-Type: text/plain; charset="utf-8"',
      ].join("\r\n");
      const raw = `${headers}\r\n\r\n${text}\r\n`;
      await withImap(inbox, async (client) => {
        const draftFolder = (await client.list()).some((entry) => String(entry.path ?? entry.name).toLowerCase() === "drafts") ? "Drafts" : "INBOX";
        await client.append(draftFolder, Buffer.from(raw, "utf8"), ["\\Draft"]);
      });
    },

    async sendMail(toAddress: string, subject: string, text: string, reply?: { messageId?: string; references?: string; inReplyTo?: string }): Promise<void> {
      const transporter = smtpTransporter(inbox);
      try {
        await transporter.sendMail({
          from: inbox.settings.fromAddress || inbox.settings.username,
          to: toAddress,
          subject,
          text,
          ...(reply?.messageId || reply?.references || reply?.inReplyTo
            ? {
                inReplyTo: reply.inReplyTo || reply.messageId,
                references: reply.references ? `${reply.references} ${reply.messageId}`.trim() : reply.messageId,
              }
            : {}),
        });
      } finally {
        transporter.close();
      }
    },
  };
}

export { stripQuotedReply };
