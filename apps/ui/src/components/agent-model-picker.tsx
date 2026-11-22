import type { AgentBackendId } from "@/types";
import { useAgentBackends } from "@/lib/agent-backends";
import { modelsForBackendNow } from "@/lib/model-sources";
import { FormField } from "@/components/form-field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { InheritedModel } from "@/components/model-select";
import { t } from "@/lib/i18n";

const inheritValue = "__inherit__";

/**
 * Agent program plus model for one unit (team member, channel, mailbox, task). Both may stay empty: then the unit runs
 * with the workspace's program and the environment's model. Choosing a program narrows the model list to that program.
 */
export function AgentModelPicker(props: {
  backendId: AgentBackendId | null;
  model: string | null;
  onChange: (choice: { backendId: AgentBackendId | null; model: string | null }) => void;
  /** What applies when the unit inherits (environment/workspace) – shown instead of a bare "Standard". */
  inheritedModel: InheritedModel;
  className?: string;
}) {
  const backendsView = useAgentBackends();
  const activeBackend = backendsView?.backends.find((backend) => backend.id === backendsView.activeId) ?? null;
  const ownBackend = props.backendId ? (backendsView?.backends.find((backend) => backend.id === props.backendId) ?? null) : null;
  const effectiveBackendId = props.backendId ?? activeBackend?.id ?? null;
  const models = modelsForBackendNow(effectiveBackendId);
  const inheritedModelLabel = `${props.inheritedModel.model} (${props.inheritedModel.source})`;
  const modelLabel = props.model ? (models.find((model) => model.value === props.model)?.label ?? props.model) : "";

  return (
    <div className={props.className ?? "grid grid-cols-2 gap-3"}>
      <FormField label={t("Agent-Programm")} hint={t("Leer = wie in den Einstellungen bzw. der Umgebung.")}>
        <Select
          value={props.backendId ?? inheritValue}
          onValueChange={(value) => {
            const backendId = value === inheritValue ? null : (value as AgentBackendId);
            // A model of the old program means nothing in the new one: fall back to its default.
            const modelStillFits = props.model && modelsForBackendNow(backendId).some((model) => model.value === props.model);
            props.onChange({ backendId, model: modelStillFits ? props.model : null });
          }}
        >
          <SelectTrigger className="w-full">
            <SelectValue>
              {props.backendId
                ? (ownBackend?.name ?? props.backendId)
                : t("Wie überall ({0})", activeBackend?.name ?? t("Einstellungen"))}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={inheritValue}>{t("Wie überall ({0})", activeBackend?.name ?? t("Einstellungen"))}</SelectItem>
            {(backendsView?.backends ?? []).map((backend) => (
              <SelectItem key={backend.id} value={backend.id}>
                {backend.name}
                {backend.ready ? "" : ` · ${t("nicht bereit")}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>
      <FormField label={t("Modell")} hint={props.backendId ? undefined : t("Leer = erbt {0}", inheritedModelLabel)}>
        <Select
          value={props.model ?? inheritValue}
          onValueChange={(value) => props.onChange({ backendId: props.backendId, model: value === inheritValue ? null : value })}
        >
          <SelectTrigger className="w-full">
            <SelectValue>
              {props.model
                ? modelLabel
                : props.backendId
                  ? t("Standard von {0}", ownBackend?.name ?? props.backendId)
                  : inheritedModelLabel}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={inheritValue}>
              {props.backendId ? t("Standard des Programms") : t("Erbt: {0}", inheritedModelLabel)}
            </SelectItem>
            {models.map((model) => (
              <SelectItem key={model.value} value={model.value}>
                {model.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>
    </div>
  );
}
