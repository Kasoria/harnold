import bolt from "@slack/bolt";
import { splitMessage, type ChannelAdapter, type ChannelAdapterContext } from "./types.ts";

/** Slack app in Socket Mode (no public URL needed): answers DMs and @mentions. */
export function createSlackAdapter(context: ChannelAdapterContext): ChannelAdapter {
  const app = new bolt.App({ token: context.secrets.botToken, appToken: context.secrets.appToken, socketMode: true });
  let botUserId = "";

  type SlackFile = { mimetype?: string; url_private_download?: string };
  type SlackMessageEvent = { channel: string; channel_type?: string; user?: string; text?: string; bot_id?: string; subtype?: string; files?: SlackFile[] };

  const forwardMessage = async (event: SlackMessageEvent) => {
    if (event.bot_id || (event.subtype && event.subtype !== "file_share") || !event.user) return;
    const text = (event.text ?? "").replace(new RegExp(`<@${botUserId}>`, "g"), "").trim();
    const audioFile = event.files?.find((file) => file.mimetype?.startsWith("audio/") && file.url_private_download);
    let audio: { data: Buffer; mimeType: string } | undefined;
    if (audioFile?.url_private_download) {
      const response = await fetch(audioFile.url_private_download, { headers: { authorization: `Bearer ${context.secrets.botToken}` } });
      if (response.ok) audio = { data: Buffer.from(await response.arrayBuffer()), mimeType: audioFile.mimetype ?? "audio/webm" };
    }
    if (text || audio) context.onInbound({ chatId: event.channel, senderId: event.user, senderName: event.user, text, audio });
  };

  app.event("message", async ({ event }) => {
    const messageEvent = event as SlackMessageEvent;
    if (messageEvent.channel_type === "im") await forwardMessage(messageEvent);
  });
  app.event("app_mention", async ({ event }) => forwardMessage(event as SlackMessageEvent));

  app.action(/^perm_(allow|deny)$/, async ({ ack, action, body, respond }) => {
    await ack();
    if (action.type !== "button" || !action.value) return;
    const allow = "action_id" in action && action.action_id === "perm_allow";
    context.onPermissionAnswer(action.value, allow);
    const originalText = "message" in body && body.message && "text" in body.message ? String(body.message.text ?? "") : "Freigabe";
    await respond({ replace_original: true, text: `${originalText}\n${allow ? "✅ Erlaubt" : "❌ Abgelehnt"}` }).catch(() => undefined);
  });

  return {
    async start() {
      await app.start();
      const authResult = await app.client.auth.test();
      botUserId = String(authResult.user_id ?? "");
    },
    async stop() {
      await app.stop();
    },
    async sendMessage(chatId, text) {
      for (const chunk of splitMessage(text, 3500)) await app.client.chat.postMessage({ channel: chatId, text: chunk });
    },
    async sendPermissionRequest(chatId, requestId, description) {
      const text = `🔐 Freigabe nötig\n${description}`.slice(0, 2900);
      await app.client.chat.postMessage({
        channel: chatId,
        text,
        blocks: [
          { type: "section", text: { type: "mrkdwn", text } },
          {
            type: "actions",
            elements: [
              { type: "button", text: { type: "plain_text", text: "Erlauben" }, style: "primary", action_id: "perm_allow", value: requestId },
              { type: "button", text: { type: "plain_text", text: "Ablehnen" }, action_id: "perm_deny", value: requestId },
            ],
          },
        ],
      });
    },
  };
}
