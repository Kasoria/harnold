import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { DetailPane, EmptyState, ListRow, MasterDetail, ScreenLayout } from "./screen-layout";
import { api } from "@/api";
import { cn } from "@/lib/utils";
import type { Channel, ChannelInput, ChannelType, Project } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusDot, type SessionStatus } from "@/components/status-dot";
import { FormField, permissionModeOptions } from "@/components/form-field";

type FieldDefinition = { key: string; label: string; placeholder?: string; secret?: boolean };

export const channelTypeDefinitions: Record<ChannelType, { label: string; hint: string; fields: FieldDefinition[] }> = {
  telegram: {
    label: "Telegram",
    hint: "Bot bei @BotFather anlegen und Token einfügen.",
    fields: [{ key: "botToken", label: "Bot-Token", placeholder: "123456:ABC…", secret: true }],
  },
  discord: {
    label: "Discord",
    hint: "Developer Portal: App + Bot anlegen, „Message Content Intent“ aktivieren.",
    fields: [{ key: "botToken", label: "Bot-Token", secret: true }],
  },
  slack: {
    label: "Slack",
    hint: "Slack-App mit Socket Mode. Scopes: chat:write, app_mentions:read, im:history, files:read.",
    fields: [
      { key: "botToken", label: "Bot-Token", placeholder: "xoxb-…", secret: true },
      { key: "appToken", label: "App-Token", placeholder: "xapp-…", secret: true },
    ],
  },
  email: {
    label: "E-Mail",
    hint: "IMAP zum Lesen, SMTP zum Antworten.",
    fields: [
      { key: "imapHost", label: "IMAP-Server", placeholder: "imap.example.com" },
      { key: "imapPort", label: "IMAP-Port", placeholder: "993" },
      { key: "smtpHost", label: "SMTP-Server", placeholder: "smtp.example.com" },
      { key: "smtpPort", label: "SMTP-Port", placeholder: "465" },
      { key: "username", label: "Benutzername" },
      { key: "fromAddress", label: "Absender-Adresse", placeholder: "agent@example.com" },
      { key: "password", label: "Passwort", secret: true },
    ],
  },
};

const statusLabels: Record<Channel["status"]["state"], string> = {
  connected: "Verbunden",
  connecting: "Verbindet …",
  error: "Fehler",
  stopped: "Aus",
};

export function channelStatusDot(channel: Channel): SessionStatus {
  if (channel.status.state === "error") return "error";
  if (channel.status.state === "connecting") return "waiting";
  if (channel.status.state === "connected") return "running";
  return "idle";
}

function ChannelEditor(props: {
  channel: Channel | null;
  projects: Project[];
  defaultProjectId: string;
  /** Saved channel id; null on cancel/removal. */
  onDone: (savedChannelId: string | null) => void;
  onError: (unknownError: unknown) => void;
}) {
  const [channelInput, setChannelInput] = useState<ChannelInput>(() =>
    props.channel
      ? { ...props.channel, secrets: {} }
      : { type: "telegram", name: "Telegram", projectId: props.defaultProjectId, enabled: true, permissionMode: "default", allowedSenders: [], voiceReplies: "voice", settings: {}, secrets: {} },
  );
  const [allowedSendersText, setAllowedSendersText] = useState((props.channel?.allowedSenders ?? []).join("\n"));
  const [saving, setSaving] = useState(false);
  const typeDefinition = channelTypeDefinitions[channelInput.type];

  const updateInput = (changes: Partial<ChannelInput>) => setChannelInput((previous) => ({ ...previous, ...changes }));

  const save = async () => {
    setSaving(true);
    const payload: ChannelInput = { ...channelInput, allowedSenders: allowedSendersText.split(/[\n,]/).map((sender) => sender.trim()).filter(Boolean) };
    try {
      const savedChannel = props.channel ? await api.updateChannel(props.channel.id, payload) : await api.createChannel(payload);
      props.onDone(savedChannel.id);
    } catch (saveError) {
      props.onError(saveError);
    } finally {
      setSaving(false);
    }
  };

  const missingSecret = typeDefinition.fields.some(
    (field) => field.secret && !channelInput.secrets[field.key]?.trim() && !props.channel?.secretsSet[field.key],
  );

  return (
    <div className="grid gap-4 py-3">
      {!props.channel && (
        <FormField label="Typ">
          <Select
            value={channelInput.type}
            onValueChange={(value) =>
              updateInput({ type: value as ChannelType, name: channelTypeDefinitions[value as ChannelType].label, settings: {}, secrets: {} })
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(channelTypeDefinitions).map(([typeValue, definition]) => (
                <SelectItem key={typeValue} value={typeValue}>
                  {definition.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
      )}
      <p className="-mt-1 text-[12px] leading-snug text-muted-foreground">{typeDefinition.hint}</p>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Name">
          <Input value={channelInput.name} onChange={(event) => updateInput({ name: event.target.value })} />
        </FormField>
        <FormField label="Projekt">
          <Select value={channelInput.projectId} onValueChange={(projectId) => updateInput({ projectId })}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Projekt wählen" />
            </SelectTrigger>
            <SelectContent>
              {props.projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {typeDefinition.fields.map((field) => (
          <div key={field.key} className={cn(field.secret && "col-span-2")}>
            <FormField label={field.label}>
              <Input
                type={field.secret ? "password" : "text"}
                autoComplete="off"
                placeholder={field.secret && props.channel?.secretsSet[field.key] ? "•••••• (gespeichert)" : field.placeholder}
                value={field.secret ? (channelInput.secrets[field.key] ?? "") : (channelInput.settings[field.key] ?? "")}
                onChange={(event) =>
                  field.secret
                    ? updateInput({ secrets: { ...channelInput.secrets, [field.key]: event.target.value } })
                    : updateInput({ settings: { ...channelInput.settings, [field.key]: event.target.value } })
                }
              />
            </FormField>
          </div>
        ))}
      </div>
      <FormField
        label="Erlaubte Absender"
        hint={channelInput.type === "email" ? undefined : "Unbekannte Absender erhalten ihre ID als Antwort."}
      >
        <Textarea rows={3} className="font-mono text-[12.5px]" value={allowedSendersText} onChange={(event) => setAllowedSendersText(event.target.value)} />
      </FormField>
      <FormField label="Rechte des Agents">
        <Select value={channelInput.permissionMode} onValueChange={(value) => updateInput({ permissionMode: value as ChannelInput["permissionMode"] })}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {permissionModeOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>

      <FormField label="Sprachantworten">
        <Select value={channelInput.voiceReplies} onValueChange={(value) => updateInput({ voiceReplies: value as ChannelInput["voiceReplies"] })}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="voice">Auf Sprachnachrichten per Sprache antworten</SelectItem>
            <SelectItem value="always">Immer zusätzlich per Sprache</SelectItem>
            <SelectItem value="off">Nur Text</SelectItem>
          </SelectContent>
        </Select>
      </FormField>

      <div className="flex items-center gap-2">
        <Button size="sm" disabled={saving || !channelInput.name.trim() || !channelInput.projectId || missingSecret} onClick={save}>
          {props.channel ? "Speichern & neu verbinden" : "Verbinden"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => props.onDone(null)}>
          Abbrechen
        </Button>
        {props.channel && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto text-muted-foreground hover:text-destructive"
            onClick={async () => {
              if (!window.confirm(`Channel „${props.channel!.name}“ entfernen?`)) return;
              await api.deleteChannel(props.channel!.id).catch(props.onError);
              props.onDone(null);
            }}
          >
            <Trash2 className="size-3.5" /> Entfernen
          </Button>
        )}
      </div>
    </div>
  );
}

type ChannelsScreenProps = {
  selectedChannelId: string | "new" | null;
  onSelectChannel: (channelId: string | "new" | null) => void;
  channels: Channel[];
  projects: Project[];
  defaultProjectId: string | null;
  onError: (unknownError: unknown) => void;
};

export function ChannelsScreen(props: ChannelsScreenProps) {
  const defaultProjectId = props.defaultProjectId ?? props.projects[0]?.id ?? "";
  const selectedChannel = props.channels.find((channel) => channel.id === props.selectedChannelId) ?? null;
  const projectNameOf = (projectId: string) => props.projects.find((project) => project.id === projectId)?.name ?? "—";

  const toggleEnabled = async (channel: Channel, enabled: boolean) => {
    const { id: _id, createdAt: _createdAt, secretsSet: _secretsSet, status: _status, ...channelInput } = channel;
    await api.updateChannel(channel.id, { ...channelInput, enabled, secrets: {} }).catch(props.onError);
  };

  const detail =
    props.selectedChannelId === "new" ? (
      <DetailPane detailKey="new" title="Channel hinzufügen" subtitle="Mit dem Agent über Telegram, Discord, Slack oder E-Mail sprechen.">
        <ChannelEditor channel={null} projects={props.projects} defaultProjectId={defaultProjectId} onDone={(savedId) => props.onSelectChannel(savedId)} onError={props.onError} />
      </DetailPane>
    ) : selectedChannel ? (
      <DetailPane
        detailKey={selectedChannel.id}
        title={selectedChannel.name}
        subtitle={
          <span className="inline-flex items-center gap-1.5">
            <StatusDot status={channelStatusDot(selectedChannel)} /> {statusLabels[selectedChannel.status.state]} · {channelTypeDefinitions[selectedChannel.type].label} ·{" "}
            {projectNameOf(selectedChannel.projectId)}
          </span>
        }
      >
        {selectedChannel.status.error && <p className="mb-3 rounded-lg border border-destructive/40 px-3 py-2 text-[12.5px] text-destructive">{selectedChannel.status.error}</p>}
        <ChannelEditor
          key={selectedChannel.id}
          channel={selectedChannel}
          projects={props.projects}
          defaultProjectId={defaultProjectId}
          onDone={(savedId) => props.onSelectChannel(savedId)}
          onError={props.onError}
        />
      </DetailPane>
    ) : (
      <EmptyState
        title={props.channels.length ? "Channel wählen" : "Noch keine Channels"}
        description="Telegram, Discord, Slack oder E-Mail."
        action={
          <Button size="sm" disabled={!props.projects.length} onClick={() => props.onSelectChannel("new")}>
            <Plus className="size-3.5" /> Channel hinzufügen
          </Button>
        }
      />
    );

  return (
    <ScreenLayout
      title="Channels"
      actions={
        <Button size="sm" variant="secondary" disabled={!props.projects.length} onClick={() => props.onSelectChannel("new")}>
          <Plus className="size-3.5" /> Channel hinzufügen
        </Button>
      }
    >
      <MasterDetail
        list={
          props.channels.length === 0 ? (
            <p className="px-2 py-6 text-center text-[12.5px] text-muted-foreground">Noch keine Channels.</p>
          ) : (
            props.channels.map((channel) => (
              <ListRow
                key={channel.id}
                selected={channel.id === props.selectedChannelId}
                onSelect={() => props.onSelectChannel(channel.id)}
                leading={<Switch checked={channel.enabled} onCheckedChange={(enabled) => void toggleEnabled(channel, enabled)} aria-label="Aktiv" />}
              >
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-medium">{channel.name}</span>
                  <StatusDot status={channelStatusDot(channel)} />
                </div>
                <div className="truncate text-[11.5px] text-muted-foreground">
                  {channelTypeDefinitions[channel.type].label} · {projectNameOf(channel.projectId)}
                </div>
              </ListRow>
            ))
          )
        }
        detail={detail}
      />
    </ScreenLayout>
  );
}
