import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

export const agentModels = [
  { value: "claude-fable-5-2", label: t("Fable 5.2") },
  { value: "claude-opus-5-5", label: t("Opus 5.5") },
  { value: "claude-sonnet-5-5", label: t("Sonnet 5.5") },
  { value: "claude-haiku-5-5", label: t("Haiku 5.5") },
] as const;

export const modelLabel = (model: string) => agentModels.find((agentModel) => agentModel.value === model)?.label ?? model;

/** The model that applies when nothing is chosen here, and where it comes from ("Einstellungen", "Umgebung X"). */
export type InheritedModel = { model: string; source: string };

const inheritValue = "inherit";

/**
 * Model picker. With `inherited`, "" means "take the inherited model" – shown by its real name, never as "Standard".
 * Without it, a concrete model must be picked.
 */
export function ModelSelect(props: { value: string; onChange: (model: string) => void; inherited?: InheritedModel; compact?: boolean; className?: string }) {
  const selectValue = props.value || (props.inherited ? inheritValue : agentModels[0].value);
  const displayedModel = props.value || props.inherited?.model || "";
  return (
    <Select value={selectValue} onValueChange={(value) => props.onChange(value === inheritValue ? "" : value)}>
      <SelectTrigger
        size={props.compact ? "sm" : "default"}
        className={cn(props.compact ? "h-7 border-0 bg-transparent text-[12px] shadow-none hover:bg-foreground/5" : "w-60", props.className)}
      >
        <SelectValue>{modelLabel(displayedModel)}</SelectValue>
      </SelectTrigger>
      <SelectContent align={props.compact ? "end" : "start"}>
        {props.inherited && (
          <SelectItem value={inheritValue}>
            {modelLabel(props.inherited.model)} <span className="text-muted-foreground">· {props.inherited.source}</span>
          </SelectItem>
        )}
        {agentModels.map((agentModel) => (
          <SelectItem key={agentModel.value} value={agentModel.value}>
            {agentModel.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
