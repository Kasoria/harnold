import { useEffect, useState } from "react";
import { Loader2, Mail, Plus, Send, Trash2, X } from "lucide-react";
import { DetailPane, EmptyState, ListRow, MasterDetail, ScreenLayout } from "./screen-layout";
import { api } from "@/api";
import { cn } from "@/lib/utils";
import type { MailAction, MailActivity, MailAutonomy, MailInbox, MailInboxInput, Project, TeamAgent } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusDot, type SessionStatus } from "@/components/status-dot";
import { FormField } from "@/components/form-field";
import { confirmAction } from "@/components/confirm-dialog";
import { t } from "@/lib/i18n";
import { Combobox } from "@/components/ui/combobox";
import { SavedCheck, useSavedFlash } from "@/components/save-feedback";
import { AgentModelPicker } from "@/components/agent-model-picker";
import type { InheritedModel } from "@/components/model-select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/lib/toast";
import { UnitModelLabel } from "@/components/unit-model-label";

const mailboxFields: { key: string; label: string; placeholder?: string; secret?: boolean }[] = [
  { key: "imapHost", label: t("IMAP-Server"), placeholder: "imap.example.com" },
  { key: "imapPort", label: t("IMAP-Port"), placeholder: "993" },
  { key: "smtpHost", label: t("SMTP-Server"), placeholder: "smtp.example.com" },
  { key: "smtpPort", label: t("SMTP-Port"), placeholder: "465" },
  { key: "username", label: t("Benutzername") },
  { key: "fromAddress", label: t("Absender-Adresse"), placeholder: "ich@example.com" },
  { key: "password", label: t("Passwort"), secret: true },
];

const autonomyOptions: { value: MailAutonomy; label: string; hint: string }[] = [
  { value: "readonly", label: t("Nur lesen"), hint: t("Nur lesen und zusammenfassen, keinerlei Änderung.") },
  { value: "drafts", label: t("Entwürfe"), hint: t("Entwürfe anlegen und sortieren, nichts senden.") },
  { value: "approve", label: t("Mit Freigabe"), hint: t("Antwort-Entwürfe erst nach Freigabe im Screen senden.") },
  { value: "auto", label: t("Vollautonom"), hint: t("Darf direkt antworten und verschieben.") },
];

const statusLabels: Record<MailInbox["status"]["state"], string> = {
  connected: t("Verbunden"),
  connecting: t("Verbindet …"),
  error: t("Fehler"),
  stopped: t("Aus"),
};

function mailboxStatusDot(inbox: MailInbox): SessionStatus {
  if (inbox.status.state === "error") return "error";
  if (inbox.status.state === "connecting") return "waiting";
  if (inbox.status.state === "connected") return "running";
  return "idle";
}

const defaultAgentValue = "__default__";
const scopeGlobalValue = "__global__";
const scopeLabelOf = (inbox: MailInbox, projects: Project[]) =>
  inbox.scope === "global" ? t("Global") : (projects.find((project) => project.id === inbox.projectId)?.name ?? "—");

function MailInboxEditor(props: {
  inbox: MailInbox | null;
  projects: Project[];
  teamAgents: TeamAgent[];
  inheritedModelFor: (projectId: string | null, role?: "chat" | "automation") => InheritedModel;
  onDone: (savedId: string | null) => void;
  onError: (unknownError: unknown) => void;
}) {
  const [input, setInput] = useState<MailInboxInput>(() =>
    props.inbox
      ? { ...props.inbox, secrets: {} }
      : {
          name: "",
          scope: "global",
          projectId: "",
          agentId: null,
          autonomy: "approve",
          enabled: true,
          backendId: null,
          model: null,
          instructions: "",
          signature: "",
          tone: "",
          context: "",
          includeSenders: "",
          excludeSenders: "",
          folders: "",
          settings: {},
          secrets: {},
        },
  );
  const [saving, setSaving] = useState(false);
  const { saved, flashSaved } = useSavedFlash();

  const updateInput = (changes: Partial<MailInboxInput>) => setInput((previous) => ({ ...previous, ...changes }));

  const save = async () => {
    setSaving(true);
    try {
      const savedInbox = props.inbox ? await api.updateMail(props.inbox.id, input) : await api.createMail(input);
      flashSaved();
      toast.success(props.inbox ? t("„{0}“ gespeichert", savedInbox.name) : t("Postfach „{0}“ eingerichtet", savedInbox.name));
      props.onDone(savedInbox.id);
    } catch (saveError) {
      props.onError(saveError);
    } finally {
      setSaving(false);
    }
  };

  const missingSecret = mailboxFields.some((field) => field.secret && !input.secrets[field.key]?.trim() && !props.inbox?.secretsSet[field.key]);

  return (
    <div className="grid gap-4 py-3">
      <p className="-mt-1 text-[12px] leading-snug text-muted-foreground">
        {t("Ein Postfach wird an einen Agenten gebunden, der es im Namen des Users bearbeitet – lesen, zusammenfassen, sortieren und (je nach Stufe) beantworten.")}
      </p>
      <div className="grid grid-cols-2 gap-3">
        <FormField label={t("Name")}>
          <Input value={input.name} placeholder={t("z. B. Kontakt")} onChange={(event) => updateInput({ name: event.target.value })} />
        </FormField>
        <FormField label={t("Geltungsbereich")}>
          <Combobox
            value={input.scope === "global" ? scopeGlobalValue : input.projectId}
            placeholder={t("Projekt wählen")}
            options={[
              { value: scopeGlobalValue, label: t("Global (überall verfügbar)") },
              ...props.projects.filter((project) => project.kind !== "quick").map((project) => ({ value: project.id, label: project.name })),
            ]}
            onValueChange={(value) => updateInput(value === scopeGlobalValue ? { scope: "global", projectId: "" } : { scope: "project", projectId: value })}
          />
        </FormField>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {mailboxFields.map((field) => (
          <div key={field.key} className={cn(field.secret && "col-span-2")}>
            <FormField label={field.label}>
              <Input
                type={field.secret ? "password" : "text"}
                autoComplete="off"
                placeholder={field.secret && props.inbox?.secretsSet[field.key] ? t("•••••• (gespeichert)") : field.placeholder}
                value={field.secret ? (input.secrets[field.key] ?? "") : (input.settings[field.key] ?? "")}
                onChange={(event) =>
                  field.secret
                    ? updateInput({ secrets: { ...input.secrets, [field.key]: event.target.value } })
                    : updateInput({ settings: { ...input.settings, [field.key]: event.target.value } })
                }
              />
            </FormField>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <FormField label={t("Agent")} hint={t("Wer das Postfach bearbeitet.")}>
          <Combobox
            value={input.agentId ?? defaultAgentValue}
            placeholder={t("Agent wählen")}
            options={[
              { value: defaultAgentValue, label: t("Standard-Agent") },
              ...props.teamAgents.map((agent) => ({ value: agent.id, label: agent.name })),
            ]}
            onValueChange={(value) => updateInput({ agentId: value === defaultAgentValue ? null : value })}
          />
        </FormField>
        <FormField label={t("Autonomie")}>
          <Select value={input.autonomy} onValueChange={(value) => updateInput({ autonomy: value as MailAutonomy })}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {autonomyOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
      </div>
      <p className="-mt-2 text-[11.5px] leading-snug text-muted-foreground">{autonomyOptions.find((option) => option.value === input.autonomy)?.hint}</p>

      <div className="grid gap-3 rounded-lg border bg-foreground/[0.02] p-3">
        <div>
          <div className="text-[12px] font-semibold">{t("Auftrag & Regeln")}</div>
          <p className="mt-0.5 text-[11.5px] leading-snug text-muted-foreground">
            {t("Ohne Auftrag fasst der Agent nur zusammen und antwortet, wenn es offensichtlich passt. Mit Auftrag arbeitet er genau nach deinen Regeln.")}
          </p>
        </div>
        <FormField label={t("Was soll der Agent tun – und was nicht?")}>
          <Textarea
            rows={5}
            value={input.instructions}
            placeholder={t(
              "z. B. Rechnungen und Terminanfragen zuerst erledigen, Newsletter ignorieren, bei Absagen höflich absagen. Nichts versprechen, was Preise oder Fristen angeht.",
            )}
            onChange={(event) => updateInput({ instructions: event.target.value })}
          />
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label={t("Anrede, Ton, Sprache")} hint={t("z. B. „Sie, sachlich und kurz, Deutsch“")}>
            <Input value={input.tone} placeholder={t("Sie, freundlich, Deutsch")} onChange={(event) => updateInput({ tone: event.target.value })} />
          </FormField>
          <FormField label={t("Signatur")} hint={t("Wird an Entwürfe und Antworten automatisch angehängt.")}>
            <Textarea rows={2} value={input.signature} placeholder={t("Viele Grüße\nChristian")} onChange={(event) => updateInput({ signature: event.target.value })} />
          </FormField>
        </div>
        <FormField label={t("Hintergrundwissen")} hint={t("Wer du bist, Firma, Produkte, wichtige Kontakte. Das Projekt-Memory geht zusätzlich mit.")}>
          <Textarea
            rows={4}
            value={input.context}
            placeholder={t("z. B. Ich bin Christian, Einzelunternehmer in Hamburg, baue Websites. Stammkunden: …")}
            onChange={(event) => updateInput({ context: event.target.value })}
          />
        </FormField>
        <div className="grid grid-cols-3 gap-3">
          <FormField label={t("Nur von")} hint={t("Leer = alle Absender. Muster mit * erlaubt.")}>
            <Input value={input.includeSenders} placeholder="*@kunde.de" onChange={(event) => updateInput({ includeSenders: event.target.value })} />
          </FormField>
          <FormField label={t("Nie von")} hint={t("Wird übersprungen, ohne den Agenten zu starten.")}>
            <Input value={input.excludeSenders} placeholder="noreply@*,*@newsletter.de" onChange={(event) => updateInput({ excludeSenders: event.target.value })} />
          </FormField>
          <FormField label={t("Ordner")} hint={t("Leer = INBOX.")}>
            <Input value={input.folders} placeholder="INBOX" onChange={(event) => updateInput({ folders: event.target.value })} />
          </FormField>
        </div>
      </div>
      <div>
        <div className="text-[12px] font-semibold">{t("Agent-Programm & Modell")}</div>
        <p className="mt-0.5 text-[11.5px] leading-snug text-muted-foreground">
          {t("Leer lassen heißt: wie in den Einstellungen bzw. der Umgebung. Praktisch, um ein Postfach mit einem günstigeren Modell laufen zu lassen.")}
        </p>
      </div>
      <AgentModelPicker
        backendId={input.backendId}
        model={input.model}
        inheritedModel={props.inheritedModelFor(input.scope === "global" ? null : input.projectId, "automation")}
        onChange={(choice) => updateInput({ backendId: choice.backendId, model: choice.model })}
      />

      <div className="flex items-center gap-2">
        <Button size="sm" disabled={saving || !input.name.trim() || missingSecret} onClick={save}>
          {saving && <Loader2 className="size-3.5 animate-spin" />}
          {props.inbox ? t("Speichern & neu verbinden") : t("Verbinden")}
          <SavedCheck saved={saved} />
        </Button>
        <Button size="sm" variant="ghost" onClick={() => props.onDone(null)}>
          {t("Abbrechen")}
        </Button>
        {props.inbox && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto text-muted-foreground hover:text-destructive"
            onClick={async () => {
              if (!(await confirmAction({ title: t("Postfach „{0}“ entfernen?", props.inbox!.name), confirmLabel: t("Entfernen") }))) return;
              await api
                .deleteMail(props.inbox!.id)
                .then(() => toast.success(t("Postfach „{0}“ entfernt", props.inbox!.name)))
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

const actionKindLabels: Record<MailAction["kind"], string> = {
  summary: t("Zusammenfassung"),
  digest: t("Digest"),
  draft: t("Entwurf"),
  moved: t("Verschoben"),
  flagged: t("Markiert"),
  sent: t("Gesendet"),
};

function MailActivityView(props: { inboxId: string; onOpenSession: (projectId: string, sessionId: string) => void; onError: (unknownError: unknown) => void }) {
  const [activity, setActivity] = useState<MailActivity | null>(null);

  const reload = () => api.readMailActivity(props.inboxId).then(setActivity).catch(props.onError);
  useEffect(() => {
    setActivity(null);
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.inboxId]);

  const decide = (action: MailAction, allow: boolean) =>
    api
      .approveMailAction(props.inboxId, action.id, allow)
      .then(() => {
        toast.success(allow ? t("Antwort gesendet") : t("Entwurf verworfen"));
        void reload();
      })
      .catch(props.onError);

  return (
    <div className="mt-4 grid gap-4 border-t pt-4">
      {activity?.pending.length ? (
        <div className="grid gap-2">
          <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">{t("Freigaben")}</h3>
          {activity.pending.map((action) => {
            const payload = action.payload as { to?: string; subject?: string; text?: string };
            return (
              <div key={action.id} className="rounded-lg border p-3">
                <div className="text-[12.5px] font-medium">
                  {t("An")} {payload.to ?? "—"} · {payload.subject ?? t("(ohne Betreff)")}
                </div>
                <p className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-[12px] text-muted-foreground">{payload.text ?? ""}</p>
                <div className="mt-2 flex gap-2">
                  <Button size="sm" onClick={() => void decide(action, true)}>
                    <Send className="size-3.5" /> {t("Senden")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void decide(action, false)}>
                    <X className="size-3.5" /> {t("Verwerfen")}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      <div className="grid gap-2">
        <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">{t("Letzte Mails")}</h3>
        {activity && activity.messages.length === 0 ? (
          <p className="text-[12.5px] text-muted-foreground">{t("Noch keine Mails verarbeitet.")}</p>
        ) : (
          (activity?.messages ?? []).map((message) => (
            <button
              key={message.id}
              type="button"
              disabled={!message.sessionId || !message.projectId}
              onClick={() => message.sessionId && message.projectId && props.onOpenSession(message.projectId, message.sessionId)}
              className="flex items-start gap-2 rounded-lg border p-2.5 text-left disabled:cursor-default enabled:hover:bg-foreground/[0.03]"
            >
              <Mail className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px] font-medium">
                  {message.fromName || message.fromAddress} · {message.subject || t("(ohne Betreff)")}
                </div>
                {message.action && <div className="mt-0.5 line-clamp-2 text-[11.5px] text-muted-foreground">{message.action}</div>}
              </div>
            </button>
          ))
        )}
      </div>

      <div className="grid gap-2">
        <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">{t("Aktivität")}</h3>
        {activity && activity.actions.length === 0 ? (
          <p className="text-[12.5px] text-muted-foreground">{t("Noch keine Aktionen.")}</p>
        ) : (
          (activity?.actions ?? []).map((action) => (
            <div key={action.id} className="flex items-start gap-2 rounded-lg border p-2.5">
              <StatusDot status={action.status === "pending" ? "waiting" : "idle"} />
              <div className="min-w-0 flex-1">
                <span className="text-[12px] font-medium">{actionKindLabels[action.kind]}</span>
                <span className="text-[11.5px] text-muted-foreground"> · {new Date(action.createdAt).toLocaleString()}</span>
                {action.description && <div className="mt-0.5 text-[11.5px] text-muted-foreground">{action.description}</div>}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

type MailScreenProps = {
  selectedInboxId: string | "new" | null;
  onSelectInbox: (inboxId: string | "new" | null) => void;
  inboxes: MailInbox[];
  projects: Project[];
  teamAgents: TeamAgent[];
  /** Model that applies when a mailbox inherits – shown by name instead of a bare "Standard". */
  inheritedModelFor: (projectId: string | null, role?: "chat" | "automation") => InheritedModel;
  onOpenSession: (projectId: string, sessionId: string) => void;
  onError: (unknownError: unknown) => void;
};

export function MailScreen(props: MailScreenProps) {
  const selectedInbox = props.inboxes.find((inbox) => inbox.id === props.selectedInboxId) ?? null;

  const toggleEnabled = async (inbox: MailInbox, enabled: boolean) => {
    const { id: _id, createdAt: _createdAt, secretsSet: _secretsSet, status: _status, agentName: _agentName, ...input } = inbox;
    await api.updateMail(inbox.id, { ...input, enabled, secrets: {} }).catch(props.onError);
  };

  const detail =
    props.selectedInboxId === "new" ? (
      <DetailPane detailKey="new" title={t("Postfach verbinden")} subtitle={t("Ein Agent bearbeitet dieses Postfach im Namen des Users.")}>
        <MailInboxEditor
          inbox={null}
          projects={props.projects}
          teamAgents={props.teamAgents}
          inheritedModelFor={props.inheritedModelFor}
          onDone={(id) => props.onSelectInbox(id)}
          onError={props.onError}
        />
      </DetailPane>
    ) : selectedInbox ? (
      <DetailPane
        detailKey={selectedInbox.id}
        title={selectedInbox.name}
        subtitle={
          <span className="inline-flex items-center gap-1.5">
            <StatusDot status={mailboxStatusDot(selectedInbox)} /> {statusLabels[selectedInbox.status.state]} · {scopeLabelOf(selectedInbox, props.projects)} ·{" "}
            {autonomyOptions.find((option) => option.value === selectedInbox.autonomy)?.label}
          </span>
        }
      >
        {selectedInbox.status.error && <p className="mb-3 rounded-lg border border-destructive/40 px-3 py-2 text-[12.5px] text-destructive">{selectedInbox.status.error}</p>}
        <MailInboxEditor
          key={selectedInbox.id}
          inbox={selectedInbox}
          projects={props.projects}
          teamAgents={props.teamAgents}
          inheritedModelFor={props.inheritedModelFor}
          onDone={(id) => props.onSelectInbox(id)}
          onError={props.onError}
        />
        <MailActivityView inboxId={selectedInbox.id} onOpenSession={props.onOpenSession} onError={props.onError} />
      </DetailPane>
    ) : (
      <EmptyState
        title={props.inboxes.length ? t("Postfach wählen") : t("Noch keine Postfächer")}
        description={t("E-Mail als Integration: ein Agent liest, sortiert und beantwortet Mails im Namen des Users.")}
        action={
          <Button size="sm" onClick={() => props.onSelectInbox("new")}>
            <Plus className="size-3.5" /> {t("Postfach verbinden")}
          </Button>
        }
      />
    );

  return (
    <ScreenLayout
      title={t("Postfächer")}
      actions={
        <Button size="sm" variant="secondary" onClick={() => props.onSelectInbox("new")}>
          <Plus className="size-3.5" /> {t("Postfach verbinden")}
        </Button>
      }
    >
      <MasterDetail
        list={
          props.inboxes.length === 0 ? (
            <p className="px-2 py-6 text-center text-[12.5px] text-muted-foreground">{t("Noch keine Postfächer.")}</p>
          ) : (
            props.inboxes.map((inbox) => (
              <ListRow
                key={inbox.id}
                selected={inbox.id === props.selectedInboxId}
                onSelect={() => props.onSelectInbox(inbox.id)}
                leading={<Switch checked={inbox.enabled} onCheckedChange={(enabled) => void toggleEnabled(inbox, enabled)} aria-label={t("Aktiv")} />}
              >
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-medium">{inbox.name}</span>
                  <StatusDot status={mailboxStatusDot(inbox)} />
                </div>
                <div className="truncate text-[11.5px] text-muted-foreground">
                  {inbox.agentName ?? t("Standard-Agent")} · {autonomyOptions.find((option) => option.value === inbox.autonomy)?.label} · {scopeLabelOf(inbox, props.projects)}
                  <UnitModelLabel backendId={inbox.backendId} model={inbox.model} />
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
