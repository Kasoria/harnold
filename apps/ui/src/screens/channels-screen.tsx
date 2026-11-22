import { useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
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
import { confirmAction } from "@/components/confirm-dialog";
import { t } from "@/lib/i18n";
import { Combobox } from "@/components/ui/combobox";
import { SavedCheck, useSavedFlash } from "@/components/save-feedback";
import { toast } from "@/lib/toast";

type FieldDefinition = { key: string; label: string; placeholder?: string; secret?: boolean };

export const channelTypeDefinitions: Record<ChannelType, { label: string; hint: string; fields: FieldDefinition[] }> = {
  telegram: {
    label: t("Telegram"),
    hint: t("Bot bei @BotFather anlegen und Token einfügen."),
    fields: [{ key: "botToken", label: t("Bot-Token"), placeholder: "123456:ABC…", secret: true }],
  },
  discord: {
    label: t("Discord"),
    hint: t("Developer Portal: App + Bot anlegen, „Message Content Intent“ aktivieren."),
    fields: [{ key: "botToken", label: t("Bot-Token"), secret: true }],
  },
  slack: {
    label: t("Slack"),
    hint: t("Slack-App mit Socket Mode. Scopes: chat:write, app_mentions:read, im:history, files:read."),
    fields: [
      { key: "botToken", label: t("Bot-Token"), placeholder: "xoxb-…", secret: true },
      { key: "appToken", label: t("App-Token"), placeholder: "xapp-…", secret: true },
    ],
  },
  email: {
    label: t("E-Mail"),
    hint: t("IMAP zum Lesen, SMTP zum Antworten."),
    fields: [
      { key: "imapHost", label: t("IMAP-Server"), placeholder: "imap.example.com" },
      { key: "imapPort", label: t("IMAP-Port"), placeholder: "993" },
      { key: "smtpHost", label: t("SMTP-Server"), placeholder: "smtp.example.com" },
      { key: "smtpPort", label: t("SMTP-Port"), placeholder: "465" },
      { key: "username", label: t("Benutzername") },
      { key: "fromAddress", label: t("Absender-Adresse"), placeholder: "agent@example.com" },
      { key: "password", label: t("Passwort"), secret: true },
    ],
  },
};

const statusLabels: Record<Channel["status"]["state"], string> = {
  connected: t("Verbunden"),
  connecting: t("Verbindet …"),
  error: t("Fehler"),
  stopped: t("Aus"),
};

export function channelStatusDot(channel: Channel): SessionStatus {
  if (channel.status.state === "error") return "error";
  if (channel.status.state === "connecting") return "waiting";
  if (channel.status.state === "connected") return "running";
  return "idle";
}

const workspaceScopeValue = "__workspace__";
const workspaceScopeLabel = t("Ganz Harnold (alle Projekte)");
const scopeLabelOf = (channel: Channel, projects: Project[]) =>
  channel.scope === "workspace" ? workspaceScopeLabel : (projects.find((project) => project.id === channel.projectId)?.name ?? "—");

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
      : { type: "telegram", name: "Telegram", scope: "workspace", projectId: "", enabled: true, permissionMode: "default", allowedSenders: [], voiceReplies: "voice", settings: {}, secrets: {} },
  );
  const [allowedSendersText, setAllowedSendersText] = useState((props.channel?.allowedSenders ?? []).join("\n"));
  const [saving, setSaving] = useState(false);
  const { saved, flashSaved } = useSavedFlash();
  const typeDefinition = channelTypeDefinitions[channelInput.type];

  const updateInput = (changes: Partial<ChannelInput>) => setChannelInput((previous) => ({ ...previous, ...changes }));

  const save = async () => {
    setSaving(true);
    const payload: ChannelInput = { ...channelInput, allowedSenders: allowedSendersText.split(/[\n,]/).map((sender) => sender.trim()).filter(Boolean) };
    try {
      const savedChannel = props.channel ? await api.updateChannel(props.channel.id, payload) : await api.createChannel(payload);
      flashSaved();
      toast.success(props.channel ? t("„{0}“ verbunden", savedChannel.name) : t("„{0}“ eingerichtet", savedChannel.name));
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
        <FormField label={t("Typ")}>
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
        <FormField label={t("Name")}>
          <Input value={channelInput.name} onChange={(event) => updateInput({ name: event.target.value })} />
        </FormField>
        <FormField label={t("Zugriff")}>
          <Combobox
            value={channelInput.scope === "workspace" ? workspaceScopeValue : channelInput.projectId}
            placeholder={t("Projekt wählen")}
            options={[
              { value: workspaceScopeValue, label: workspaceScopeLabel },
              ...props.projects.filter((project) => project.kind !== "quick").map((project) => ({ value: project.id, label: project.name })),
            ]}
            onValueChange={(value) => updateInput(value === workspaceScopeValue ? { scope: "workspace", projectId: "" } : { scope: "project", projectId: value })}
          />
        </FormField>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {typeDefinition.fields.map((field) => (
          <div key={field.key} className={cn(field.secret && "col-span-2")}>
            <FormField label={field.label}>
              <Input
                type={field.secret ? "password" : "text"}
                autoComplete="off"
                placeholder={field.secret && props.channel?.secretsSet[field.key] ? t("•••••• (gespeichert)") : field.placeholder}
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
        label={t("Erlaubte Absender")}
        hint={
          channelInput.type === "email"
            ? t("E-Mail-Adressen lassen sich fälschen. Harnold verwirft Mails, deren SPF/DKIM/DMARC-Prüfung fehlschlägt – ohne diese Header im Kopf der Mail bleibt ein Restrisiko.")
            : t("Unbekannte Absender erhalten ihre ID als Antwort.")
        }
      >
        <Textarea rows={3} className="font-mono text-[12.5px]" value={allowedSendersText} onChange={(event) => setAllowedSendersText(event.target.value)} />
      </FormField>
      <FormField label={t("Rechte des Agents")}>
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

      <FormField label={t("Sprachantworten")}>
        <Select value={channelInput.voiceReplies} onValueChange={(value) => updateInput({ voiceReplies: value as ChannelInput["voiceReplies"] })}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="voice">{t("Auf Sprachnachrichten per Sprache antworten")}</SelectItem>
            <SelectItem value="always">{t("Immer zusätzlich per Sprache")}</SelectItem>
            <SelectItem value="off">{t("Nur Text")}</SelectItem>
          </SelectContent>
        </Select>
      </FormField>

      <div className="flex items-center gap-2">
        <Button size="sm" disabled={saving || !channelInput.name.trim() || (channelInput.scope === "project" && !channelInput.projectId) || missingSecret} onClick={save}>
          {saving && <Loader2 className="size-3.5 animate-spin" />}
          {props.channel ? t("Speichern & neu verbinden") : t("Verbinden")}
          <SavedCheck saved={saved} />
        </Button>
        <Button size="sm" variant="ghost" onClick={() => props.onDone(null)}>
          {t("Abbrechen")}
        </Button>
        {props.channel && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto text-muted-foreground hover:text-destructive"
            onClick={async () => {
              if (!(await confirmAction({ title: t("Channel „{0}“ entfernen?", props.channel!.name), confirmLabel: t("Entfernen") }))) return;
              await api
                .deleteChannel(props.channel!.id)
                .then(() => toast.success(t("Channel „{0}“ entfernt", props.channel!.name)))
                .catch(props.onError);
              props.onDone(null);
            }}
          >
            <Trash2 className="size-3.5" /> {t("Entfernen")}
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

  const toggleEnabled = async (channel: Channel, enabled: boolean) => {
    const { id: _id, createdAt: _createdAt, secretsSet: _secretsSet, status: _status, ...channelInput } = channel;
    await api.updateChannel(channel.id, { ...channelInput, enabled, secrets: {} }).catch(props.onError);
  };

  const detail =
    props.selectedChannelId === "new" ? (
      <DetailPane detailKey="new" title={t("Channel hinzufügen")} subtitle={t("Mit dem Agent über Telegram, Discord, Slack oder E-Mail sprechen.")}>
        <ChannelEditor channel={null} projects={props.projects} defaultProjectId={defaultProjectId} onDone={(savedId) => props.onSelectChannel(savedId)} onError={props.onError} />
      </DetailPane>
    ) : selectedChannel ? (
      <DetailPane
        detailKey={selectedChannel.id}
        title={selectedChannel.name}
        subtitle={
          <span className="inline-flex items-center gap-1.5">
            <StatusDot status={channelStatusDot(selectedChannel)} /> {statusLabels[selectedChannel.status.state]} · {channelTypeDefinitions[selectedChannel.type].label} ·{" "}
            {scopeLabelOf(selectedChannel, props.projects)}
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
        title={props.channels.length ? t("Channel wählen") : t("Noch keine Channels")}
        description={t("Telegram, Discord, Slack oder E-Mail.")}
        action={
          <Button size="sm" disabled={!props.projects.length} onClick={() => props.onSelectChannel("new")}>
            <Plus className="size-3.5" /> {t("Channel hinzufügen")}
          </Button>
        }
      />
    );

  return (
    <ScreenLayout
      title={t("Channels")}
      actions={
        <Button size="sm" variant="secondary" disabled={!props.projects.length} onClick={() => props.onSelectChannel("new")}>
          <Plus className="size-3.5" /> {t("Channel hinzufügen")}
        </Button>
      }
    >
      <MasterDetail
        list={
          props.channels.length === 0 ? (
            <p className="px-2 py-6 text-center text-[12.5px] text-muted-foreground">{t("Noch keine Channels.")}</p>
          ) : (
            props.channels.map((channel) => (
              <ListRow
                key={channel.id}
                selected={channel.id === props.selectedChannelId}
                onSelect={() => props.onSelectChannel(channel.id)}
                leading={<Switch checked={channel.enabled} onCheckedChange={(enabled) => void toggleEnabled(channel, enabled)} aria-label={t("Aktiv")} />}
              >
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-medium">{channel.name}</span>
                  <StatusDot status={channelStatusDot(channel)} />
                </div>
                <div className="truncate text-[11.5px] text-muted-foreground">
                  {channelTypeDefinitions[channel.type].label} · {scopeLabelOf(channel, props.projects)}
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
