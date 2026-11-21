import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { api } from "@/api";
import type { Channel, ChannelInput, ChannelType, Project } from "@/types";
import { cn } from "@/lib/utils";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
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
    hint: "App im Developer Portal anlegen, Bot hinzufügen, „Message Content Intent“ aktivieren. Antwortet auf DMs und @Erwähnungen.",
    fields: [{ key: "botToken", label: "Bot-Token", secret: true }],
  },
  slack: {
    label: "Slack",
    hint: "Slack-App mit Socket Mode. Scopes: chat:write, app_mentions:read, im:history, files:read. Antwortet auf DMs und @Erwähnungen.",
    fields: [
      { key: "botToken", label: "Bot-Token", placeholder: "xoxb-…", secret: true },
      { key: "appToken", label: "App-Token", placeholder: "xapp-…", secret: true },
    ],
  },
  email: {
    label: "E-Mail",
    hint: "Prüft das Postfach jede Minute (IMAP) und antwortet per SMTP. Nur freigegebene Absender werden bearbeitet.",
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
  onDone: () => void;
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
      if (props.channel) await api.updateChannel(props.channel.id, payload);
      else await api.createChannel(payload);
      props.onDone();
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
        hint={channelInput.type === "email" ? "E-Mail-Adressen, eine pro Zeile." : "IDs, eine pro Zeile. Unbekannte Absender bekommen ihre ID als Antwort."}
      >
        <Textarea rows={3} className="font-mono text-[12.5px]" value={allowedSendersText} onChange={(event) => setAllowedSendersText(event.target.value)} />
      </FormField>
      <FormField label="Rechte des Agents" hint="Bei „Fragen“ kommen Freigaben als Buttons in den Chat.">
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

      <FormField label="Sprachantworten" hint="Sprachnachrichten werden immer transkribiert (Einstellungen → Voice).">
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
        <Button size="sm" variant="ghost" onClick={props.onDone}>
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
              props.onDone();
            }}
          >
            <Trash2 className="size-3.5" /> Entfernen
          </Button>
        )}
      </div>
    </div>
  );
}

type ChannelsSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channels: Channel[];
  projects: Project[];
  defaultProjectId: string | null;
  onError: (unknownError: unknown) => void;
};

export function ChannelsSheet(props: ChannelsSheetProps) {
  const [editingChannelId, setEditingChannelId] = useState<string | "new" | null>(null);

  useEffect(() => {
    if (!props.open) setEditingChannelId(null);
  }, [props.open]);

  const toggleEnabled = async (channel: Channel, enabled: boolean) => {
    const { id: _id, createdAt: _createdAt, secretsSet: _secretsSet, status: _status, ...channelInput } = channel;
    await api.updateChannel(channel.id, { ...channelInput, enabled, secrets: {} }).catch(props.onError);
  };

  const defaultProjectId = props.defaultProjectId ?? props.projects[0]?.id ?? "";

  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent className="w-full gap-0 sm:max-w-[520px]">
        <SheetHeader className="border-b">
          <SheetTitle>Channels</SheetTitle>
          <SheetDescription>Mit dem Agent über Telegram, Discord, Slack oder E-Mail sprechen.</SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          <Collapsible open={editingChannelId === "new"}>
            {editingChannelId !== "new" && (
              <Button size="sm" variant="secondary" className="mb-2" disabled={!props.projects.length} onClick={() => setEditingChannelId("new")}>
                <Plus className="size-3.5" /> Channel hinzufügen
              </Button>
            )}
            <CollapsibleContent className="collapsible-animated">
              <div className="mb-3 rounded-xl border bg-card px-4">
                <ChannelEditor channel={null} projects={props.projects} defaultProjectId={defaultProjectId} onDone={() => setEditingChannelId(null)} onError={props.onError} />
              </div>
            </CollapsibleContent>
          </Collapsible>

          {props.channels.length === 0 && editingChannelId !== "new" && (
            <p className="py-6 text-center text-[13px] text-muted-foreground">Noch keine Channels.</p>
          )}

          <ul className="grid gap-1.5">
            {props.channels.map((channel) => {
              const expanded = editingChannelId === channel.id;
              const projectName = props.projects.find((project) => project.id === channel.projectId)?.name ?? "—";
              return (
                <li key={channel.id} className={cn("rounded-xl border transition-colors duration-200", expanded ? "bg-card" : "border-transparent hover:bg-foreground/[0.03]")}>
                  <div className="flex items-center gap-3 px-3 py-2.5">
                    <Switch checked={channel.enabled} onCheckedChange={(enabled) => void toggleEnabled(channel, enabled)} aria-label="Aktiv" />
                    <button className="min-w-0 flex-1 text-left" onClick={() => setEditingChannelId(expanded ? null : channel.id)}>
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[13.5px] font-medium">{channel.name}</span>
                        <span className="inline-flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                          <StatusDot status={channelStatusDot(channel)} /> {statusLabels[channel.status.state]}
                        </span>
                      </div>
                      <div className="truncate text-[12px] text-muted-foreground">
                        {channelTypeDefinitions[channel.type].label} · {projectName}
                      </div>
                      {channel.status.error && <div className="mt-0.5 text-[12px] text-destructive">{channel.status.error}</div>}
                    </button>
                  </div>
                  <Collapsible open={expanded}>
                    <CollapsibleContent className="collapsible-animated">
                      <div className="border-t px-4">
                        <ChannelEditor channel={channel} projects={props.projects} defaultProjectId={defaultProjectId} onDone={() => setEditingChannelId(null)} onError={props.onError} />
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                </li>
              );
            })}
          </ul>
        </div>
      </SheetContent>
    </Sheet>
  );
}
