import { useSyncExternalStore } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { AgentBackendId, CodexStatus, CustomProvider, EffortLevel, ProvidersView } from "@/types";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
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

/** Models one agent program offers: Codex's list, every provider for the Harnold-Agent, else Claude (or the active Anthropic provider). */
export function modelsForBackend(backendId: AgentBackendId | undefined, providers: ProvidersView | null, codex: CodexStatus | null): ModelOption[] {
  if (backendId === "codex") return modelsForCodex(codex?.models ?? []);
  if (backendId === "native") return modelsForNative(providers?.providers ?? []);
  const activeProvider = providers?.providers.find((provider) => provider.id === providers.activeId);
  return modelsForProvider(activeProvider?.protocol === "anthropic" ? activeProvider : null);
}

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

/** Harnold-Agent models are stored as "providerId::modelId"; an unknown provider id must never reach the screen. */
const withoutProviderId = (model: string) => (model.includes("::") ? model.slice(model.indexOf("::") + 2) : model);

export const modelLabel = (model: string) => [...activeModels, ...claudeModels, codexDefaultOption].find((agentModel) => agentModel.value === model)?.label ?? withoutProviderId(model);

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

/** Effort levels like Claude Code's /effort ("" = the model decides). */
const effortChoices: { value: EffortLevel | ""; label: string }[] = [
  { value: "", label: t("Standard") },
  { value: "low", label: t("niedrig") },
  { value: "medium", label: t("mittel") },
  { value: "high", label: t("hoch") },
  { value: "xhigh", label: t("sehr hoch") },
  { value: "max", label: t("maximal") },
];

function PickerItem(props: { selected: boolean; onSelect: () => void; children: React.ReactNode }) {
  return (
    <DropdownMenuItem className="gap-2 pr-2 text-[12.5px]" onSelect={props.onSelect}>
      <span className="flex-1 truncate">{props.children}</span>
      <Check className={cn("size-3.5 shrink-0", !props.selected && "invisible")} />
    </DropdownMenuItem>
  );
}

/**
 * Model and effort in one picker (composer). The trigger shows "Opus 5.5 · hoch"; the effort part
 * only exists when the agent program supports it (onEffortChange set).
 */
export function ModelEffortPicker(props: {
  value: string;
  onChange: (model: string) => void;
  inherited?: InheritedModel;
  effort: EffortLevel | "";
  onEffortChange?: (effort: EffortLevel | "") => void;
}) {
  const models = useAgentModels();
  const displayedModel = props.value || props.inherited?.model || models[0]?.value || "";
  const modelName = models.find((model) => model.value === displayedModel)?.label ?? modelLabel(displayedModel);
  const effortName = props.onEffortChange && props.effort ? effortChoices.find((choice) => choice.value === props.effort)?.label : null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex h-7 max-w-64 items-center gap-1.5 rounded-md px-2 text-[12px] whitespace-nowrap transition-colors hover:bg-foreground/5 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          title={props.onEffortChange ? t("Modell und Denkaufwand") : t("Modell")}
        >
          <span className="truncate">{modelName}</span>
          {effortName && <span className="text-muted-foreground">· {effortName}</span>}
          <ChevronDown className="size-3.5 shrink-0 opacity-50" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="text-[11px] font-medium text-muted-foreground">{t("Modell")}</DropdownMenuLabel>
        {props.inherited && (
          <PickerItem selected={!props.value} onSelect={() => props.onChange("")}>
            {modelLabel(props.inherited.model)} <span className="text-muted-foreground">· {props.inherited.source}</span>
          </PickerItem>
        )}
        {models.map((model) => (
          <PickerItem key={model.value} selected={props.value === model.value || (!props.value && !props.inherited && model.value === displayedModel)} onSelect={() => props.onChange(model.value)}>
            {model.label}
          </PickerItem>
        ))}
        {props.onEffortChange && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[11px] font-medium text-muted-foreground">{t("Denkaufwand")}</DropdownMenuLabel>
            {effortChoices.map((choice) => (
              <PickerItem key={choice.value || "default"} selected={props.effort === choice.value} onSelect={() => props.onEffortChange!(choice.value)}>
                {choice.label}
              </PickerItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
