import { useState } from "react";
import { Loader2, Plus, Trash2, Users } from "lucide-react";
import { api } from "@/api";
import type { Environment, TeamAgent, TeamAgentInput } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FormField } from "@/components/form-field";
import { ModelSelect } from "@/components/model-select";
import { ProjectAvatar } from "@/components/project-avatar";
import { confirmAction } from "@/components/confirm-dialog";
import { DetailPane, EmptyState, ListRow, MasterDetail, ScreenLayout } from "./screen-layout";

const everywhereValue = "__everywhere__";

type TeamScreenProps = {
  agents: TeamAgent[];
  environments: Environment[];
  selection: string | null;
  onSelect: (selection: string | null) => void;
  onTeamChange: () => void;
  onError: (unknownError: unknown) => void;
};

function TeamAgentEditor(props: { agent: TeamAgent | null; environments: Environment[]; onDone: (savedId: string | null) => void; onTeamChange: () => void; onError: (unknownError: unknown) => void }) {
  const [agentInput, setAgentInput] = useState<TeamAgentInput>(() =>
    props.agent
      ? { environmentId: props.agent.environmentId, name: props.agent.name, role: props.agent.role, instructions: props.agent.instructions, model: props.agent.model, icon: props.agent.icon }
      : { environmentId: null, name: "", role: "", instructions: "", model: null, icon: null },
  );
  const [saving, setSaving] = useState(false);
  const updateInput = (changes: Partial<TeamAgentInput>) => setAgentInput((previous) => ({ ...previous, ...changes }));

  const save = async () => {
    setSaving(true);
    try {
      const savedAgent = props.agent ? await api.updateTeamAgent(props.agent.id, agentInput) : await api.createTeamAgent(agentInput);
      props.onTeamChange();
      props.onDone(savedAgent.id);
    } catch (saveError) {
      props.onError(saveError);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!props.agent || !(await confirmAction({ title: `„${props.agent.name}“ aus dem Team entfernen?`, description: "Bisherige Unterhaltungen bleiben, laufen danach mit dem Standard-Agent." }))) return;
    await api.deleteTeamAgent(props.agent.id).catch(props.onError);
    props.onTeamChange();
    props.onDone(null);
  };

  return (
    <div className="grid gap-4 py-3">
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Name">
          <Input value={agentInput.name} placeholder="z. B. Designerin" onChange={(changeEvent) => updateInput({ name: changeEvent.target.value })} />
        </FormField>
        <FormField label="Team">
          <Select value={agentInput.environmentId ?? everywhereValue} onValueChange={(value) => updateInput({ environmentId: value === everywhereValue ? null : value })}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={everywhereValue}>Alle Umgebungen</SelectItem>
              {props.environments.map((environment) => (
                <SelectItem key={environment.id} value={environment.id}>
                  {environment.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
      </div>
      <FormField label="Rolle" hint="Ein Satz – daran erkennen die anderen Agenten, wann sie fragen sollten.">
        <Input value={agentInput.role} placeholder="z. B. UI/UX-Design und Design Systems" onChange={(changeEvent) => updateInput({ role: changeEvent.target.value })} />
      </FormField>
      <FormField label="Anweisungen">
        <Textarea
          rows={8}
          value={agentInput.instructions}
          placeholder="Wie arbeitet dieser Agent? Worauf achtet er, was macht er nicht?"
          onChange={(changeEvent) => updateInput({ instructions: changeEvent.target.value })}
        />
      </FormField>
      <FormField label="Modell">
        <ModelSelect value={agentInput.model ?? ""} inherited={{ model: "claude-opus-5-5", source: "wie die Umgebung" }} onChange={(model) => updateInput({ model: model || null })} />
      </FormField>
      <div className="flex gap-2">
        <Button size="sm" disabled={saving || !agentInput.name.trim()} onClick={() => void save()}>
          {saving && <Loader2 className="size-3.5 animate-spin" />} Speichern
        </Button>
        {props.agent ? (
          <Button size="sm" variant="ghost" className="ml-auto text-destructive" onClick={() => void remove()}>
            <Trash2 className="size-3.5" /> Entfernen
          </Button>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => props.onDone(null)}>
            Abbrechen
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
    environmentId ? (props.environments.find((environment) => environment.id === environmentId)?.name ?? "—") : "Alle Umgebungen";

  const detail =
    props.selection === "new" ? (
      <DetailPane detailKey="new" title="Teammitglied hinzufügen" subtitle="Ein Agent mit eigener Rolle, eigenen Anweisungen und eigenem Modell.">
        <TeamAgentEditor agent={null} environments={props.environments} onDone={props.onSelect} onTeamChange={props.onTeamChange} onError={props.onError} />
      </DetailPane>
    ) : selectedAgent ? (
      <DetailPane detailKey={selectedAgent.id} title={selectedAgent.name} subtitle={`${selectedAgent.role || "Ohne Rolle"} · ${environmentNameOf(selectedAgent.environmentId)}`}>
        <TeamAgentEditor key={selectedAgent.id} agent={selectedAgent} environments={props.environments} onDone={props.onSelect} onTeamChange={props.onTeamChange} onError={props.onError} />
      </DetailPane>
    ) : (
      <EmptyState
        title={props.agents.length ? "Teammitglied wählen" : "Noch kein Team"}
        description="Mehrere Agenten mit eigenen Rollen. Sie fragen und beauftragen sich gegenseitig; jede Session kann mit einem von ihnen sein."
        action={
          <Button size="sm" onClick={() => props.onSelect("new")}>
            <Plus className="size-3.5" /> Teammitglied hinzufügen
          </Button>
        }
      />
    );

  return (
    <ScreenLayout
      title="Team"
      description="Agenten je Umgebung, die zusammenarbeiten."
      actions={
        <Button size="sm" variant="secondary" onClick={() => props.onSelect("new")}>
          <Plus className="size-3.5" /> Teammitglied hinzufügen
        </Button>
      }
    >
      <MasterDetail
        list={
          props.agents.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-2 py-6 text-center text-[12.5px] text-muted-foreground">
              <Users className="size-5" /> Noch keine Teammitglieder.
            </div>
          ) : (
            props.agents.map((agent) => (
              <ListRow key={agent.id} selected={agent.id === props.selection} onSelect={() => props.onSelect(agent.id)} leading={<ProjectAvatar name={agent.name} icon={agent.icon} />}>
                <div className="truncate text-[13px] font-medium">{agent.name}</div>
                <div className="truncate text-[11.5px] text-muted-foreground">
                  {agent.role || "Ohne Rolle"} · {environmentNameOf(agent.environmentId)}
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
