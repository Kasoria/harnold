import { useSyncExternalStore } from "react";
import type { AgentBackendId, CodexStatus, ProvidersView } from "@/types";
import { modelsForBackend, type ModelOption } from "@/components/model-select";
import { useAgentBackends } from "@/lib/agent-backends";
import { t } from "@/lib/i18n";

/**
 * Where the model lists come from (active provider, Codex models, the Harnold agent's providers). Kept here so every
 * picker can offer the models of the backend it shows – not only those of the workspace's active one.
 */
type ModelSources = { providers: ProvidersView | null; codex: CodexStatus | null };

let sources: ModelSources = { providers: null, codex: null };
const listeners = new Set<() => void>();

export function setAgentModelSources(next: ModelSources): void {
  sources = next;
  listeners.forEach((listener) => listener());
}

export const useAgentModelSources = (): ModelSources =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => sources,
  );

/** Models one agent program offers right now. */
export function modelsForBackendNow(backendId: AgentBackendId | null | undefined): ModelOption[] {
  return modelsForBackend(backendId ?? undefined, sources.providers, sources.codex);
}

/**
 * Short label of a unit's own program and model for list rows ("Codex · gpt-5"). Empty when the unit inherits –
 * an inherited setting is the normal case and does not need a line in every row.
 */
export function useUnitModelLabel(backendId: AgentBackendId | null, model: string | null): string {
  const backendsView = useAgentBackends();
  const activeBackend = backendsView?.backends.find((backend) => backend.id === backendsView.activeId) ?? null;
  const effectiveBackendId = backendId ?? activeBackend?.id ?? null;
  const backends = backendsView?.backends ?? [];
  const programName = backends.find((backend) => backend.id === effectiveBackendId)?.name ?? effectiveBackendId ?? "";
  const modelName = model ? (modelsForBackendNow(effectiveBackendId).find((option) => option.value === model)?.label ?? model) : "";
  if (!backendId && !model) return "";
  if (backendId && !model) return t("{0} · Standard", programName);
  if (!backendId && model) return t("Modell · {0}", modelName);
  return `${programName} · ${modelName}`;
}
