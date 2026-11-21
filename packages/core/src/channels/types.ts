export type ChannelType = "telegram" | "discord" | "slack" | "email";

/** Field definitions per channel type. Secret fields are stored encrypted and never sent back to clients. */
export const channelFieldDefinitions: Record<ChannelType, { settings: string[]; secrets: string[] }> = {
  telegram: { settings: [], secrets: ["botToken"] },
  discord: { settings: [], secrets: ["botToken"] },
  slack: { settings: [], secrets: ["botToken", "appToken"] },
  email: { settings: ["imapHost", "imapPort", "smtpHost", "smtpPort", "username", "fromAddress"], secrets: ["password"] },
};

export type InboundAudio = { data: Buffer; mimeType: string };

export type InboundMessage = {
  chatId: string;
  senderId: string;
  senderName: string;
  text: string;
  /** Voice message / audio attachment; transcribed centrally by the channel manager. */
  audio?: InboundAudio;
};

export type ChannelAdapterContext = {
  settings: Record<string, string>;
  secrets: Record<string, string>;
  onInbound: (inboundMessage: InboundMessage) => void;
  onPermissionAnswer: (requestId: string, allow: boolean) => void;
};

export interface ChannelAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(chatId: string, text: string): Promise<void>;
  /** Asks for a tool approval; adapters with buttons call onPermissionAnswer, others rely on "ja"/"nein" replies. */
  sendPermissionRequest(chatId: string, requestId: string, description: string): Promise<void>;
  indicateTyping?(chatId: string): Promise<void>;
  /** Sends a spoken reply (ogg/opus preferred). */
  sendVoice?(chatId: string, audio: InboundAudio): Promise<void>;
}

export function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    let cutIndex = remaining.lastIndexOf("\n", maxLength);
    if (cutIndex < maxLength * 0.5) cutIndex = maxLength;
    chunks.push(remaining.slice(0, cutIndex));
    remaining = remaining.slice(cutIndex).replace(/^\n/, "");
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
