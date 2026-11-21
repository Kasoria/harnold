import { useEffect, useState } from "react";
import { api } from "@/api";
import type { EmbeddingProvider, MemorySettings, MemorySettingsView } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FormField } from "@/components/form-field";

const embeddingProviderLabels: Record<EmbeddingProvider, string> = {
  off: "Aus (nur Volltext)",
  openai: "OpenAI",
  ollama: "Ollama (lokal)",
};

export function MemorySettingsSection(props: { onSaved: () => void; onError: (unknownError: unknown) => void }) {
  const [settingsView, setSettingsView] = useState<MemorySettingsView | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<MemorySettings | null>(null);
  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .readMemorySettings()
      .then((loadedSettings) => {
        setSettingsView(loadedSettings);
        const { workspaceDirectory, embeddingProvider, embeddingModel, ollamaUrl } = loadedSettings;
        setSettingsDraft({ workspaceDirectory, embeddingProvider, embeddingModel, ollamaUrl });
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
      props.onSaved();
    } catch (saveError) {
      props.onError(saveError);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-4">
      <FormField label="Workspace-Memory-Ordner" hint={`Leer = Standard. Kann ein Obsidian-Vault sein. Aktuell: ${settingsView.resolvedWorkspaceDirectory}`}>
        <Input value={settingsDraft.workspaceDirectory} placeholder="~/Vaults/MeinVault" onChange={(changeEvent) => updateDraft({ workspaceDirectory: changeEvent.target.value })} />
      </FormField>

      <FormField label="Semantische Suche" hint="Ergänzt die Volltextsuche um Vektoren. Der Index wird automatisch neu aufgebaut.">
        <Select value={settingsDraft.embeddingProvider} onValueChange={(value) => updateDraft({ embeddingProvider: value as EmbeddingProvider, embeddingModel: "" })}>
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
        <FormField label="Modell">
          <Input
            value={settingsDraft.embeddingModel}
            placeholder={settingsDraft.embeddingProvider === "openai" ? "text-embedding-3-small" : "nomic-embed-text"}
            onChange={(changeEvent) => updateDraft({ embeddingModel: changeEvent.target.value })}
          />
        </FormField>
      )}
      {settingsDraft.embeddingProvider === "openai" && (
        <FormField label="OpenAI API-Key" hint="Leer = Key aus den Voice-Einstellungen.">
          <Input
            type="password"
            value={openaiApiKey}
            placeholder={settingsView.openaiKeySet ? "gespeichert – leer lassen zum Behalten" : ""}
            onChange={(changeEvent) => setOpenaiApiKey(changeEvent.target.value)}
          />
        </FormField>
      )}
      {settingsDraft.embeddingProvider === "ollama" && (
        <FormField label="Ollama-Adresse">
          <Input value={settingsDraft.ollamaUrl} onChange={(changeEvent) => updateDraft({ ollamaUrl: changeEvent.target.value })} />
        </FormField>
      )}

      <div className="flex gap-2">
        <Button size="sm" disabled={saving} onClick={() => void save()}>
          Speichern
        </Button>
      </div>
    </div>
  );
}
