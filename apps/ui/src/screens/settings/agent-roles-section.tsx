import { useEffect, useState } from "react";
import type { AgentBackendId, AgentRole, AgentRoleDefaults, AgentRoleSettings } from "@/types";
import { api } from "@/api";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAgentBackends } from "@/lib/agent-backends";
import { modelsForBackendNow } from "@/lib/model-sources";
import { SavedCheck, useSavedFlash } from "@/components/save-feedback";
import { t } from "@/lib/i18n";

const inheritValue = "__inherit__";

const roleLabels: Record<AgentRole, { label: string; hint: string }> = {
  chat: {
    label: t("Unterhaltungen"),
    hint: t("Chats, Channels und Teammitglieder – alles, wo ein Mensch mitliest und antwortet."),
  },
  automation: {
    label: t("Hintergrundläufe"),
    hint: t("Tasks und Postfach – Läufe ohne Aufsicht. Hier lohnt oft ein günstigeres Modell."),
  },
};

/** One role's program and model; empty = the workspace default (top of this screen). */
function RoleRow(props: { role: AgentRole; defaults: AgentRoleDefaults; onChange: (defaults: AgentRoleDefaults) => void }) {
  const backendsView = useAgentBackends();
  const activeBackend = backendsView?.backends.find((backend) => backend.id === backendsView.activeId) ?? null;
  const models = modelsForBackendNow(props.defaults.backendId ?? activeBackend?.id ?? null);
  const role = roleLabels[props.role];

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_11rem_11rem] items-center gap-3 rounded-lg border px-3 py-2.5">
      <div className="min-w-0">
        <div className="text-[12.5px] font-medium">{role.label}</div>
        <p className="mt-0.5 text-[11.5px] leading-snug text-muted-foreground">{role.hint}</p>
      </div>
      <Select
        value={props.defaults.backendId ?? inheritValue}
        onValueChange={(value) => {
          const backendId = value === inheritValue ? null : (value as AgentBackendId);
          // A model of the old program means nothing in the new one.
          const modelFits = props.defaults.model && modelsForBackendNow(backendId).some((model) => model.value === props.defaults.model);
          props.onChange({ backendId, model: modelFits ? props.defaults.model : null });
        }}
      >
        <SelectTrigger className="w-full">
          <SelectValue>{props.defaults.backendId ? (backendsView?.backends.find((backend) => backend.id === props.defaults.backendId)?.name ?? props.defaults.backendId) : t("Wie oben")}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={inheritValue}>{t("Wie oben")}</SelectItem>
          {(backendsView?.backends ?? []).map((backend) => (
            <SelectItem key={backend.id} value={backend.id}>
              {backend.name}
              {backend.ready ? "" : ` · ${t("nicht bereit")}`}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={props.defaults.model ?? inheritValue}
        onValueChange={(value) => props.onChange({ backendId: props.defaults.backendId, model: value === inheritValue ? null : value })}
      >
        <SelectTrigger className="w-full">
          <SelectValue>
            {props.defaults.model
              ? (models.find((model) => model.value === props.defaults.model)?.label ?? props.defaults.model)
              : props.defaults.backendId
                ? t("Standard des Programms")
                : t("Standardmodell oben")}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={inheritValue}>{props.defaults.backendId ? t("Standard des Programms") : t("Standardmodell oben")}</SelectItem>
          {models.map((model) => (
            <SelectItem key={model.value} value={model.value}>
              {model.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** Which program and model a role uses when neither the unit nor the team member names one. */
export function AgentRolesSection(props: { onRolesChange: (roles: AgentRoleSettings) => void; onError: (unknownError: unknown) => void }) {
  const [roles, setRoles] = useState<AgentRoleSettings | null>(null);
  const [saving, setSaving] = useState<AgentRole | null>(null);
  const { saved, flashSaved } = useSavedFlash();

  useEffect(() => {
    api.readAgentRoles().then(setRoles).catch(props.onError);
  }, [props.onError]);

  if (!roles) return <div className="h-24" />;

  const change = async (role: AgentRole, defaults: AgentRoleDefaults) => {
    const optimistic = { ...roles, [role]: defaults };
    setRoles(optimistic);
    setSaving(role);
    try {
      const savedRoles = await api.saveAgentRoles({ [role]: defaults });
      setRoles(savedRoles);
      props.onRolesChange(savedRoles);
      flashSaved();
    } catch (saveError) {
      props.onError(saveError);
      api.readAgentRoles().then(setRoles).catch(() => undefined);
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="grid gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <div className="text-[13px] font-medium">{t("Programm und Modell je Rolle")}</div>
          <p className="text-[11.5px] leading-snug text-muted-foreground">
            {t("Gilt, wenn eine Einheit (Team-Mitglied, Channel, Postfach, Task) nichts Eigenes wählt. Die Einheit selbst sticht diese Vorgabe.")}
          </p>
        </div>
        <SavedCheck saved={saved} />
      </div>
      {(["chat", "automation"] as AgentRole[]).map((role) => (
        <div key={role} className={saving === role ? "opacity-70" : undefined}>
          <RoleRow role={role} defaults={roles[role]} onChange={(defaults) => void change(role, defaults)} />
        </div>
      ))}
    </div>
  );
}
