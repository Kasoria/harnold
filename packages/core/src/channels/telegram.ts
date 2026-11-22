import { splitMessage, type ChannelAdapter, type ChannelAdapterContext } from "./types.ts";
import { t } from "../i18n.ts";

type TelegramUpdate = {
  update_id: number;
  message?: {
    chat: { id: number };
    from?: { id: number; first_name?: string; username?: string };
    text?: string;
    caption?: string;
    voice?: { file_id: string; mime_type?: string };
    audio?: { file_id: string; mime_type?: string };
  };
  callback_query?: { id: string; data?: string; message?: { chat: { id: number }; message_id: number; text?: string } };
};

/** Telegram Bot API via long polling (no webhook/public URL needed). */
export function createTelegramAdapter(context: ChannelAdapterContext): ChannelAdapter {
  const apiBase = `https://api.telegram.org/bot${context.secrets.botToken}`;
  let running = false;
  let pollAbortController: AbortController | undefined;

  const callApi = async <ResponseBody>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<ResponseBody> => {
    const response = await fetch(`${apiBase}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    const payload = (await response.json()) as { ok: boolean; result: ResponseBody; description?: string };
    if (!payload.ok) throw new Error(t("Telegram {0}: {1}", method, payload.description ?? response.statusText));
    return payload.result;
  };

  const downloadFile = async (fileId: string): Promise<Buffer> => {
    const fileInfo = await callApi<{ file_path: string }>("getFile", { file_id: fileId });
    const response = await fetch(`https://api.telegram.org/file/bot${context.secrets.botToken}/${fileInfo.file_path}`);
    if (!response.ok) throw new Error(t("Telegram-Download fehlgeschlagen: {0}", response.status));
    return Buffer.from(await response.arrayBuffer());
  };

  const handleUpdate = async (update: TelegramUpdate) => {
    if (update.message?.from) {
      const text = update.message.text ?? update.message.caption ?? "";
      const audioFile = update.message.voice ?? update.message.audio;
      if (!text && !audioFile) return;
      context.onInbound({
        chatId: String(update.message.chat.id),
        senderId: String(update.message.from.id),
        senderName: update.message.from.username ?? update.message.from.first_name ?? String(update.message.from.id),
        text,
        audio: audioFile ? { data: await downloadFile(audioFile.file_id), mimeType: audioFile.mime_type ?? "audio/ogg" } : undefined,
      });
    }
    const callbackQuery = update.callback_query;
    if (callbackQuery?.data?.startsWith("perm:")) {
      const [, requestId, decision] = callbackQuery.data.split(":");
      const allow = decision === "allow";
      context.onPermissionAnswer(requestId, allow);
      await callApi("answerCallbackQuery", { callback_query_id: callbackQuery.id, text: allow ? "Erlaubt" : "Abgelehnt" });
      if (callbackQuery.message) {
        await callApi("editMessageText", {
          chat_id: callbackQuery.message.chat.id,
          message_id: callbackQuery.message.message_id,
          text: `${callbackQuery.message.text ?? ""}\n\n${allow ? "✅ Erlaubt" : "❌ Abgelehnt"}`,
        }).catch(() => undefined);
      }
    }
  };

  const pollLoop = async () => {
    let offset = 0;
    while (running) {
      pollAbortController = new AbortController();
      try {
        const updates = await callApi<TelegramUpdate[]>("getUpdates", { offset, timeout: 30, allowed_updates: ["message", "callback_query"] }, pollAbortController.signal);
        for (const update of updates) {
          offset = update.update_id + 1;
          await handleUpdate(update).catch((updateError) => console.error("[telegram] update failed:", updateError));
        }
      } catch (pollError) {
        if (!running) return;
        console.error("[telegram] polling error:", pollError);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  };

  return {
    async start() {
      await callApi("getMe", {}); // validates the token
      running = true;
      void pollLoop();
    },
    async stop() {
      running = false;
      pollAbortController?.abort();
    },
    async sendMessage(chatId, text) {
      for (const chunk of splitMessage(text, 4000)) await callApi("sendMessage", { chat_id: chatId, text: chunk });
    },
    async sendPermissionRequest(chatId, requestId, description) {
      await callApi("sendMessage", {
        chat_id: chatId,
        text: `🔐 Freigabe nötig\n${description}`.slice(0, 4000),
        reply_markup: {
          inline_keyboard: [[
            { text: "Erlauben", callback_data: `perm:${requestId}:allow` },
            { text: "Ablehnen", callback_data: `perm:${requestId}:deny` },
          ]],
        },
      });
    },
    async sendVoice(chatId, audio) {
      const isOggVoice = audio.mimeType.includes("ogg");
      const formData = new FormData();
      formData.append("chat_id", chatId);
      formData.append(isOggVoice ? "voice" : "audio", new Blob([new Uint8Array(audio.data)], { type: audio.mimeType }), isOggVoice ? "antwort.ogg" : "antwort.mp3");
      const response = await fetch(`${apiBase}/${isOggVoice ? "sendVoice" : "sendAudio"}`, { method: "POST", body: formData });
      const payload = (await response.json()) as { ok: boolean; description?: string };
      if (!payload.ok) throw new Error(t("Telegram sendVoice: {0}", payload.description ?? response.statusText));
    },
    async indicateTyping(chatId) {
      await callApi("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => undefined);
    },
  };
}
