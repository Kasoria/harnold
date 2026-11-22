import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { api } from "@/api";
import type { EmbeddingProvider, MemorySettings, MemorySettingsView } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FormField } from "@/components/form-field";
import { t } from "@/lib/i18n";
import { SavedCheck, useSavedFlash } from "@/components/save-feedback";

const embeddingProviderLabels: Record<EmbeddingProvider, string> = {
  off: t("Aus (nur Volltext)"),
  openai: "OpenAI",
  ollama: t("Ollama (lokal)"),
};

const defaultEmbeddingModels: Partial<Record<EmbeddingProvider, string>> = { openai: "text-embedding-3-small", ollama: "nomic-embed-text" };

export function MemorySettingsSection(props: { onError: (unknownError: unknown) => void }) {
  const [settingsView, setSettingsView] = useState<MemorySettingsView | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<MemorySettings | null>(null);
  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const { saved, flashSaved } = useSavedFlash();

  useEffect(() => {
    api
      .readMemorySettings()
      .then((loadedSettings) => {
        setSettingsView(loadedSettings);
        const { workspaceDirectory, embeddingProvider, embeddingModel, ollamaUrl } = loadedSettings;
        // Show the model actually used, never an empty "default".
        setSettingsDraft({ workspaceDirectory, embeddingProvider, embeddingModel: embeddingModel || (defaultEmbeddingModels[embeddingProvider] ?? ""), ollamaUrl });
      })
      .catch(props.onError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!settingsDraft || !settingsView) return null;
  const updateDraft = (changes: Partial<MemorySettings>) => setSettingsDraft((previous) => (previous ? { ...previous, ...changes } : previous));

  const save = async () => {
    setSaving(true);
    try {
      const savedSettings = await api.saveMemorySettings(settingsDraft, openaiApiKey);
      setSettingsView(savedSettings);
      setOpenaiApiKey("");
      flashSaved();
    } catch (saveError) {
      props.onError(saveError);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-4">
      <FormField label={t("Workspace-Memory-Ordner")}>
        <Input value={settingsDraft.workspaceDirectory || settingsView.resolvedWorkspaceDirectory} onChange={(changeEvent) => updateDraft({ workspaceDirectory: changeEvent.target.value })} />
      </FormField>

      <FormField
        label={t("Semantische Suche")}
        hint={
          settingsDraft.embeddingProvider === "openai"
            ? t("Die Notizinhalte gehen dafür an OpenAI. Für lokale Suche ohne Datenabfluss: Ollama.")
            : undefined
        }
      >
        <Select value={settingsDraft.embeddingProvider} onValueChange={(value) => updateDraft({ embeddingProvider: value as EmbeddingProvider, embeddingModel: defaultEmbeddingModels[value as EmbeddingProvider] ?? "" })}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(embeddingProviderLabels).map(([providerValue, providerLabel]) => (
              <SelectItem key={providerValue} value={providerValue}>
                {providerLabel}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>

      {settingsDraft.embeddingProvider !== "off" && (
        <FormField label={t("Modell")}>
          <Input
            value={settingsDraft.embeddingModel}
            onChange={(changeEvent) => updateDraft({ embeddingModel: changeEvent.target.value })}
          />
        </FormField>
      )}
      {settingsDraft.embeddingProvider === "openai" && (
        <FormField label={t("OpenAI API-Key")} hint={settingsView.openaiKeySet ? undefined : t("Leer = OpenAI-Key aus Voice")}>
          <Input
            type="password"
            value={openaiApiKey}
            placeholder={settingsView.openaiKeySet ? t("gespeichert – leer lassen zum Behalten") : ""}
            onChange={(changeEvent) => setOpenaiApiKey(changeEvent.target.value)}
          />
        </FormField>
      )}
      {settingsDraft.embeddingProvider === "ollama" && (
        <FormField label={t("Ollama-Adresse")}>
          <Input value={settingsDraft.ollamaUrl} onChange={(changeEvent) => updateDraft({ ollamaUrl: changeEvent.target.value })} />
        </FormField>
      )}

      <div className="flex gap-2">
        <Button size="sm" disabled={saving} onClick={() => void save()}>
          {saving && <Loader2 className="size-3.5 animate-spin" />}
          {t("Speichern")}
          <SavedCheck saved={saved} />
        </Button>
      </div>
    </div>
  );
}
