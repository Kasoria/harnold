import { useState } from "react";
import { Loader2, Plus, Trash2, Users } from "lucide-react";
import { api } from "@/api";
import type { Environment, TeamAgent, TeamAgentInput } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "@/components/form-field";
import { AgentModelPicker } from "@/components/agent-model-picker";
import type { InheritedModel } from "@/components/model-select";
import { ProjectAvatar } from "@/components/project-avatar";
import { confirmAction } from "@/components/confirm-dialog";
import { DetailPane, EmptyState, ListRow, MasterDetail, ScreenLayout } from "./screen-layout";
import { t } from "@/lib/i18n";
import { Combobox } from "@/components/ui/combobox";
import { SavedCheck, useSavedFlash } from "@/components/save-feedback";
import { toast } from "@/lib/toast";
import { UnitModelLabel } from "@/components/unit-model-label";

const everywhereValue = "__everywhere__";

type TeamScreenProps = {
  agents: TeamAgent[];
  environments: Environment[];
  /** Model that applies when a member inherits – shown by name instead of a bare "Standard". */
  inheritedModel: InheritedModel;
  selection: string | null;
  onSelect: (selection: string | null) => void;
  onTeamChange: () => void;
  onError: (unknownError: unknown) => void;
};

function TeamAgentEditor(props: {
  agent: TeamAgent | null;
  environments: Environment[];
  inheritedModel: InheritedModel;
  onDone: (savedId: string | null) => void;
  onTeamChange: () => void;
  onError: (unknownError: unknown) => void;
}) {
  const [agentInput, setAgentInput] = useState<TeamAgentInput>(() =>
    props.agent
      ? {
          environmentId: props.agent.environmentId,
          name: props.agent.name,
          role: props.agent.role,
          instructions: props.agent.instructions,
          model: props.agent.model,
          backendId: props.agent.backendId,
          icon: props.agent.icon,
        }
      : { environmentId: null, name: "", role: "", instructions: "", model: null, backendId: null, icon: null },
  );
  const [saving, setSaving] = useState(false);
  const { saved, flashSaved } = useSavedFlash();
  const updateInput = (changes: Partial<TeamAgentInput>) => setAgentInput((previous) => ({ ...previous, ...changes }));

  const save = async () => {
    setSaving(true);
    try {
      const savedAgent = props.agent ? await api.updateTeamAgent(props.agent.id, agentInput) : await api.createTeamAgent(agentInput);
      flashSaved();
      if (!props.agent) toast.success(t("„{0}“ ist im Team", savedAgent.name));
      props.onTeamChange();
      props.onDone(savedAgent.id);
    } catch (saveError) {
      props.onError(saveError);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!props.agent || !(await confirmAction({ title: t("„{0}“ aus dem Team entfernen?", props.agent.name), description: t("Bisherige Unterhaltungen bleiben, laufen danach mit dem Standard-Agent.") }))) return;
    await api
      .deleteTeamAgent(props.agent.id)
      .then(() => toast.success(t("„{0}“ entfernt", props.agent!.name)))
      .catch(props.onError);
    props.onTeamChange();
    props.onDone(null);
  };

  return (
    <div className="grid gap-4 py-3">
      <div className="grid grid-cols-2 gap-3">
        <FormField label={t("Name")}>
          <Input value={agentInput.name} placeholder={t("z. B. Designerin")} onChange={(changeEvent) => updateInput({ name: changeEvent.target.value })} />
        </FormField>
        <FormField label={t("Team")}>
          <Combobox
            value={agentInput.environmentId ?? everywhereValue}
            options={[{ value: everywhereValue, label: t("Alle Umgebungen") }, ...props.environments.map((environment) => ({ value: environment.id, label: environment.name }))]}
            onValueChange={(value) => updateInput({ environmentId: value === everywhereValue ? null : value })}
          />
        </FormField>
      </div>
      <FormField label={t("Rolle")} hint={t("Ein Satz – daran erkennen die anderen Agenten, wann sie fragen sollten.")}>
        <Input value={agentInput.role} placeholder={t("z. B. UI/UX-Design und Design Systems")} onChange={(changeEvent) => updateInput({ role: changeEvent.target.value })} />
      </FormField>
      <FormField label={t("Anweisungen")}>
        <Textarea
          rows={8}
          value={agentInput.instructions}
          placeholder={t("Wie arbeitet dieser Agent? Worauf achtet er, was macht er nicht?")}
          onChange={(changeEvent) => updateInput({ instructions: changeEvent.target.value })}
        />
      </FormField>
      <AgentModelPicker
        backendId={agentInput.backendId}
        model={agentInput.model}
        inheritedModel={props.inheritedModel}
        onChange={(choice) => updateInput({ backendId: choice.backendId, model: choice.model })}
      />
      <p className="-mt-2 text-[11.5px] leading-snug text-muted-foreground">
        {t("Ein anderes Agent-Programm gilt für neue Unterhaltungen mit diesem Mitglied; laufende behalten ihres, bis der Kontext neu beginnt.")}
      </p>
      <div className="flex gap-2">
        <Button size="sm" disabled={saving || !agentInput.name.trim()} onClick={() => void save()}>
          {saving && <Loader2 className="size-3.5 animate-spin" />} {t("Speichern")}
          <SavedCheck saved={saved} />
        </Button>
        {props.agent ? (
          <Button size="sm" variant="ghost" className="ml-auto text-destructive" onClick={() => void remove()}>
            <Trash2 className="size-3.5" /> {t("Entfernen")}
          </Button>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => props.onDone(null)}>
            {t("Abbrechen")}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Several agents (experts) per environment. Chats can be with one of them; they ask each other via team_ask. */
export function TeamScreen(props: TeamScreenProps) {
  const selectedAgent = props.agents.find((agent) => agent.id === props.selection) ?? null;
  const environmentNameOf = (environmentId: string | null) =>
    environmentId ? (props.environments.find((environment) => environment.id === environmentId)?.name ?? "—") : t("Alle Umgebungen");

  const detail =
    props.selection === "new" ? (
      <DetailPane detailKey="new" title={t("Teammitglied hinzufügen")} subtitle={t("Ein Agent mit eigener Rolle, eigenen Anweisungen und eigenem Modell.")}>
        <TeamAgentEditor
          agent={null}
          environments={props.environments}
          inheritedModel={props.inheritedModel}
          onDone={props.onSelect}
          onTeamChange={props.onTeamChange}
          onError={props.onError}
        />
      </DetailPane>
    ) : selectedAgent ? (
      <DetailPane detailKey={selectedAgent.id} title={selectedAgent.name} subtitle={`${selectedAgent.role || t("Ohne Rolle")} · ${environmentNameOf(selectedAgent.environmentId)}`}>
        <TeamAgentEditor
          key={selectedAgent.id}
          agent={selectedAgent}
          environments={props.environments}
          inheritedModel={props.inheritedModel}
          onDone={props.onSelect}
          onTeamChange={props.onTeamChange}
          onError={props.onError}
        />
      </DetailPane>
    ) : (
      <EmptyState
        title={props.agents.length ? t("Teammitglied wählen") : t("Noch kein Team")}
        description={t("Mehrere Agenten mit eigenen Rollen. Sie fragen und beauftragen sich gegenseitig; jede Session kann mit einem von ihnen sein.")}
        action={
          <Button size="sm" onClick={() => props.onSelect("new")}>
            <Plus className="size-3.5" /> {t("Teammitglied hinzufügen")}
          </Button>
        }
      />
    );

  return (
    <ScreenLayout
      title={t("Team")}
      description={t("Agenten je Umgebung, die zusammenarbeiten.")}
      actions={
        <Button size="sm" variant="secondary" onClick={() => props.onSelect("new")}>
          <Plus className="size-3.5" /> {t("Teammitglied hinzufügen")}
        </Button>
      }
    >
      <MasterDetail
        list={
          props.agents.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-2 py-6 text-center text-[12.5px] text-muted-foreground">
              <Users className="size-5" /> {t("Noch keine Teammitglieder.")}
            </div>
          ) : (
            props.agents.map((agent) => (
              <ListRow key={agent.id} selected={agent.id === props.selection} onSelect={() => props.onSelect(agent.id)} leading={<ProjectAvatar name={agent.name} icon={agent.icon} />}>
                <div className="truncate text-[13px] font-medium">{agent.name}</div>
                <div className="truncate text-[11.5px] text-muted-foreground">
                  {agent.role || t("Ohne Rolle")} · {environmentNameOf(agent.environmentId)}
                  <UnitModelLabel backendId={agent.backendId} model={agent.model} />
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
