import { useSyncExternalStore } from "react";
import type { CustomProvider } from "@/types";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

export type ModelOption = { value: string; label: string };

const claudeModels: ModelOption[] = [
  { value: "claude-fable-5-2", label: t("Fable 5.2") },
  { value: "claude-opus-5-5", label: t("Opus 5.5") },
  { value: "claude-sonnet-5-5", label: t("Sonnet 5.5") },
  { value: "claude-haiku-5-5", label: t("Haiku 5.5") },
];

/** Models of a custom provider (ids as labels), or the Claude models when none is given. */
export const modelsForProvider = (provider?: Pick<CustomProvider, "models"> | null): ModelOption[] =>
  provider ? provider.models.map((model) => ({ value: model, label: model })) : claudeModels;

const codexDefaultOption: ModelOption = { value: "codex-default", label: t("Codex-Standard") };
/** Codex: its own default plus the model ids the user added. */
export const modelsForCodex = (extraModels: string[]): ModelOption[] => [codexDefaultOption, ...extraModels.map((model) => ({ value: model, label: model }))];

/** Harnold-Agent: every model of every ready provider, as "providerId::modelId". */
export const modelsForNative = (providers: Pick<CustomProvider, "id" | "name" | "models" | "ready">[]): ModelOption[] =>
  providers.filter((provider) => provider.ready).flatMap((provider) => provider.models.map((model) => ({ value: `${provider.id}::${model}`, label: `${provider.name} · ${model}` })));
/** One provider's models in the Harnold-Agent format. */
export const nativeModelsOf = (provider: Pick<CustomProvider, "id" | "name" | "models" | "ready">): ModelOption[] => modelsForNative([{ ...provider, ready: true }]);

// Models of the workspace's active provider – shared by every picker that doesn't bring its own list.
let activeModels: ModelOption[] = claudeModels;
const modelListeners = new Set<() => void>();
export function setActiveModels(models: ModelOption[]): void {
  activeModels = models;
  modelListeners.forEach((listener) => listener());
}
export const getAgentModels = () => activeModels;
export const useAgentModels = () =>
  useSyncExternalStore(
    (listener) => {
      modelListeners.add(listener);
      return () => modelListeners.delete(listener);
    },
    getAgentModels,
  );

export const modelLabel = (model: string) => [...activeModels, ...claudeModels, codexDefaultOption].find((agentModel) => agentModel.value === model)?.label ?? model;

/** The model that applies when nothing is chosen here, and where it comes from ("Einstellungen", "Umgebung X"). */
export type InheritedModel = { model: string; source: string };

const inheritValue = "inherit";

/**
 * Model picker. With `inherited`, "" means "take the inherited model" – shown by its real name, never as "Standard".
 * Without it, a concrete model must be picked.
 */
export function ModelSelect(props: { models?: ModelOption[]; value: string; onChange: (model: string) => void; inherited?: InheritedModel; compact?: boolean; className?: string }) {
  const activeModelList = useAgentModels();
  const models = props.models ?? activeModelList;
  const selectValue = props.value || (props.inherited ? inheritValue : models[0]?.value ?? "");
  const displayedModel = props.value || props.inherited?.model || "";
  return (
    <Select value={selectValue} onValueChange={(value) => props.onChange(value === inheritValue ? "" : value)}>
      <SelectTrigger
        size={props.compact ? "sm" : "default"}
        className={cn(props.compact ? "h-7 border-0 bg-transparent text-[12px] shadow-none hover:bg-foreground/5" : "w-60", props.className)}
      >
        <SelectValue>{models.find((model) => model.value === displayedModel)?.label ?? modelLabel(displayedModel)}</SelectValue>
      </SelectTrigger>
      <SelectContent align={props.compact ? "end" : "start"}>
        {props.inherited && (
          <SelectItem value={inheritValue}>
            {modelLabel(props.inherited.model)} <span className="text-muted-foreground">· {props.inherited.source}</span>
          </SelectItem>
        )}
        {models.map((agentModel) => (
          <SelectItem key={agentModel.value} value={agentModel.value}>
            {agentModel.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
