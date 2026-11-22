import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelType as DiscordChannelType, Client, Events, GatewayIntentBits, Partials } from "discord.js";
import { splitMessage, type ChannelAdapter, type ChannelAdapterContext } from "./types.ts";
import { t } from "../i18n.ts";

/** Discord bot: answers DMs and messages that mention it. */
export function createDiscordAdapter(context: ChannelAdapterContext): ChannelAdapter {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
    partials: [Partials.Channel],
  });

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot || !client.user) return;
    const isDirectMessage = message.channel.type === DiscordChannelType.DM;
    if (!isDirectMessage && !message.mentions.has(client.user)) return;
    const text = message.content.replace(new RegExp(`<@!?${client.user.id}>`, "g"), "").trim();
    const audioAttachment = message.attachments.find((attachment) => attachment.contentType?.startsWith("audio/"));
    if (!text && !audioAttachment) return;
    let audio: { data: Buffer; mimeType: string } | undefined;
    if (audioAttachment) {
      const response = await fetch(audioAttachment.url);
      if (response.ok) audio = { data: Buffer.from(await response.arrayBuffer()), mimeType: audioAttachment.contentType ?? "audio/ogg" };
    }
    context.onInbound({ chatId: message.channelId, senderId: message.author.id, senderName: message.author.username, text, audio });
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton() || !interaction.customId.startsWith("perm:")) return;
    const [, requestId, decision] = interaction.customId.split(":");
    const allow = decision === "allow";
    context.onPermissionAnswer(requestId, allow);
    await interaction
      .update({ content: `${interaction.message.content}\n\n${allow ? "✅ Erlaubt" : "❌ Abgelehnt"}`, components: [] })
      .catch(() => undefined);
  });

  const fetchTextChannel = async (chatId: string) => {
    const channel = await client.channels.fetch(chatId);
    if (!channel?.isSendable()) throw new Error(t("Discord-Kanal nicht beschreibbar"));
    return channel;
  };

  return {
    async start() {
      await client.login(context.secrets.botToken);
    },
    async stop() {
      await client.destroy();
    },
    async sendMessage(chatId, text) {
      const channel = await fetchTextChannel(chatId);
      for (const chunk of splitMessage(text, 1900)) await channel.send(chunk);
    },
    async sendPermissionRequest(chatId, requestId, description) {
      const channel = await fetchTextChannel(chatId);
      const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`perm:${requestId}:allow`).setLabel("Erlauben").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`perm:${requestId}:deny`).setLabel("Ablehnen").setStyle(ButtonStyle.Secondary),
      );
      await channel.send({ content: `🔐 Freigabe nötig\n${description}`.slice(0, 1900), components: [buttonRow] });
    },
    async sendVoice(chatId, audio) {
      const channel = await fetchTextChannel(chatId);
      const fileName = audio.mimeType.includes("ogg") ? "antwort.ogg" : audio.mimeType.includes("wav") ? "antwort.wav" : "antwort.mp3";
      await channel.send({ files: [new AttachmentBuilder(audio.data, { name: fileName })] });
    },
    async indicateTyping(chatId) {
      const channel = await fetchTextChannel(chatId).catch(() => undefined);
      if (channel && "sendTyping" in channel) await channel.sendTyping().catch(() => undefined);
    },
  };
}
