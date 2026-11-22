import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { simpleParser } from "mailparser";
import { type ChannelAdapter, type ChannelAdapterContext } from "./types.ts";
import { failsAuthentication, stripQuotedReply } from "../mail/mail-parse.ts";

const pollIntervalMs = 60_000;

/** IMAP polling for inbound mail, SMTP for replies. Sender address = conversation. */
export function createEmailAdapter(context: ChannelAdapterContext): ChannelAdapter {
  const { settings, secrets } = context;
  const lastSubjectByAddress = new Map<string, string>();
  let pollTimer: NodeJS.Timeout | undefined;
  let stopped = false;

  const transporter = nodemailer.createTransport({
    host: settings.smtpHost,
    port: Number(settings.smtpPort || 465),
    secure: Number(settings.smtpPort || 465) === 465,
    auth: { user: settings.username, pass: secrets.password },
  });

  const createImapClient = () =>
    new ImapFlow({
      host: settings.imapHost,
      port: Number(settings.imapPort || 993),
      secure: true,
      auth: { user: settings.username, pass: secrets.password },
      logger: false,
    });

  const pollInbox = async () => {
    const imapClient = createImapClient();
    try {
      await imapClient.connect();
      const mailboxLock = await imapClient.getMailboxLock("INBOX");
      try {
        const unseenUids = (await imapClient.search({ seen: false }, { uid: true })) || [];
        for (const uid of unseenUids) {
          const fetchedMessage = await imapClient.fetchOne(String(uid), { source: true }, { uid: true });
          if (!fetchedMessage || !fetchedMessage.source) continue;
          const parsedMail = await simpleParser(fetchedMessage.source);
          await imapClient.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
          const senderAddress = parsedMail.from?.value[0]?.address?.toLowerCase();
          if (failsAuthentication(parsedMail.headers.get("authentication-results"))) {
            console.warn(`[email] verworfen: Authentifizierung fehlgeschlagen (${senderAddress ?? "unbekannt"})`);
            continue;
          }
          const text = stripQuotedReply(parsedMail.text ?? "");
          const audioAttachment = parsedMail.attachments.find((attachment) => attachment.contentType.startsWith("audio/"));
          if (!senderAddress || (!text && !audioAttachment)) continue;
          lastSubjectByAddress.set(senderAddress, parsedMail.subject ?? "Harnold");
          context.onInbound({
            chatId: senderAddress,
            senderId: senderAddress,
            senderName: parsedMail.from?.value[0]?.name || senderAddress,
            text,
            audio: audioAttachment ? { data: audioAttachment.content, mimeType: audioAttachment.contentType } : undefined,
          });
        }
      } finally {
        mailboxLock.release();
      }
    } finally {
      await imapClient.logout().catch(() => undefined);
    }
  };

  const schedulePoll = () => {
    if (stopped) return;
    pollTimer = setTimeout(async () => {
      await pollInbox().catch((pollError) => console.error("[email] poll failed:", pollError));
      schedulePoll();
    }, pollIntervalMs);
  };

  const sendMail = async (toAddress: string, text: string) => {
    const lastSubject = lastSubjectByAddress.get(toAddress);
    await transporter.sendMail({
      from: settings.fromAddress || settings.username,
      to: toAddress,
      subject: lastSubject ? (lastSubject.startsWith("Re:") ? lastSubject : `Re: ${lastSubject}`) : "Harnold",
      text,
    });
  };

  return {
    async start() {
      stopped = false;
      await transporter.verify();
      await pollInbox();
      schedulePoll();
    },
    async stop() {
      stopped = true;
      clearTimeout(pollTimer);
      transporter.close();
    },
    sendMessage: sendMail,
    async sendPermissionRequest(chatId, _requestId, description) {
      await sendMail(chatId, `Freigabe nötig:\n${description}\n\nAntworte mit JA oder NEIN.`);
    },
  };
}
