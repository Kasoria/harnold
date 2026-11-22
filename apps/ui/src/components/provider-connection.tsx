import { useEffect, useState } from "react";
import { CheckCircle2, CircleAlert, Download, Loader2, Plus, Server, Sparkles, Trash2 } from "lucide-react";
import { api } from "@/api";
import type { ClaudeAuthStatus, CustomProvider, ProviderInput, ProviderPreset, ProviderProtocol, ProvidersView } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "@/components/form-field";
import { SegmentedControl } from "@/components/segmented-control";
import { ClaudeConnectionPanel } from "@/components/claude-connection";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { SavedCheck, useAsyncAction } from "@/components/save-feedback";

const claudeEntryId = "claude";
const newEntryId = "new";

const parseModels = (modelText: string) => [...new Set(modelText.split(/[\s,]+/).map((model) => model.trim()).filter(Boolean))];

export const protocolLabel = (protocol: ProviderProtocol) => (protocol === "anthropic" ? t("Anthropic-API") : t("OpenAI-kompatibel"));

/** Form for one provider (new or existing). `fixedProtocol` limits it to one wire protocol (Claude Code: Anthropic). */
export function ProviderForm(props: {
  provider: CustomProvider | null;
  presets: ProviderPreset[];
  fixedProtocol?: ProviderProtocol;
  busy: boolean;
  /** Green check for a moment after the save went through. */
  saved?: boolean;
  onSave: (input: ProviderInput) => void;
  onDelete?: () => void;
  onError: (unknownError: unknown) => void;
}) {
  const { provider, presets, fixedProtocol } = props;
  const [presetId, setPresetId] = useState(provider ? "" : presets[0]?.id ?? "");
  const preset = presets.find((candidate) => candidate.id === presetId);
  const [name, setName] = useState(provider?.name ?? preset?.name ?? "");
  const [protocol, setProtocol] = useState<ProviderProtocol>(fixedProtocol ?? provider?.protocol ?? preset?.protocol ?? "openai");
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? preset?.baseUrl ?? "");
  const [modelText, setModelText] = useState((provider?.models ?? preset?.models ?? []).join("\n"));
  const [apiKey, setApiKey] = useState("");
  const [needsKey, setNeedsKey] = useState(provider?.needsKey ?? preset?.needsKey ?? true);
  const [foundModels, setFoundModels] = useState<string[] | null>(null);
  const [modelFilter, setModelFilter] = useState("");
  const [discovering, setDiscovering] = useState(false);

  const choosePreset = (nextPreset: ProviderPreset) => {
    setPresetId(nextPreset.id);
    setName(nextPreset.name);
    setProtocol(fixedProtocol ?? nextPreset.protocol);
    setBaseUrl(nextPreset.baseUrl);
    setModelText(nextPreset.models.join("\n"));
    setNeedsKey(nextPreset.needsKey);
    setFoundModels(null);
  };

  const models = parseModels(modelText);
  const urlValid = /^https?:\/\/\S+$/.test(baseUrl.trim());
  const canSave = Boolean(name.trim() && urlValid && models.length > 0);
  // Protocol is a choice only for own endpoints; presets know theirs.
  const protocolEditable = !fixedProtocol && (Boolean(provider) || presetId.startsWith("custom-"));

  const discover = async () => {
    setDiscovering(true);
    try {
      const { models: discovered } = await api.discoverProviderModels({ protocol, baseUrl: baseUrl.trim(), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), ...(provider ? { providerId: provider.id } : {}) });
      setFoundModels(discovered);
      if (!models.length) setModelText(discovered.slice(0, 1).join("\n"));
    } catch (discoverError) {
      props.onError(discoverError);
    } finally {
      setDiscovering(false);
    }
  };

  const toggleModel = (model: string) => setModelText((models.includes(model) ? models.filter((entry) => entry !== model) : [...models, model]).join("\n"));
  const shownFoundModels = (foundModels ?? []).filter((model) => model.toLowerCase().includes(modelFilter.trim().toLowerCase())).slice(0, 200);

  return (
    <div className="grid animate-in gap-4 fade-in duration-200">
      {!provider && (
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
          {presets.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              onClick={() => choosePreset(candidate)}
              className={cn(
                "rounded-lg border px-3 py-2 text-left text-[13px] transition-colors hover:bg-foreground/[0.04]",
                candidate.id === presetId && "border-primary bg-primary/[0.06]",
              )}
            >
              {t(candidate.name)}
            </button>
          ))}
        </div>
      )}
      {preset?.hint && !provider && <p className="-mt-2 text-[12px] text-muted-foreground">{t(preset.hint)}</p>}

      <FormField label={t("Name")}>
        <Input value={name} onChange={(changeEvent) => setName(changeEvent.target.value)} />
      </FormField>
      {protocolEditable && (
        <FormField label={t("Schnittstelle")}>
          <SegmentedControl
            className="w-72"
            options={[
              { value: "openai", label: protocolLabel("openai") },
              { value: "anthropic", label: protocolLabel("anthropic") },
            ]}
            value={protocol}
            onValueChange={(nextProtocol) => setProtocol(nextProtocol as ProviderProtocol)}
          />
        </FormField>
      )}
      <FormField
        label={t("Endpunkt (Base-URL)")}
        hint={protocol === "anthropic" ? t("Bietet die Anthropic-Messages-API an (…/v1/messages).") : t("Bietet die OpenAI-Schnittstelle an (…/chat/completions).")}
      >
        <Input value={baseUrl} placeholder="https://…" className="font-mono text-[13px]" onChange={(changeEvent) => setBaseUrl(changeEvent.target.value)} />
      </FormField>
      <FormField label={needsKey ? t("API-Key") : t("API-Key (optional)")}>
        <Input
          type="password"
          autoComplete="off"
          value={apiKey}
          placeholder={provider?.apiKeySet ? t("gespeichert – leer lassen zum Behalten") : preset?.keyPlaceholder || ""}
          onChange={(changeEvent) => setApiKey(changeEvent.target.value)}
        />
      </FormField>
      <FormField label={t("Modelle")} hint={t("Modell-IDs, eine pro Zeile. Das erste ist das Standardmodell.")}>
        <div className="grid gap-2">
          <Textarea value={modelText} rows={3} className="font-mono text-[13px]" onChange={(changeEvent) => setModelText(changeEvent.target.value)} />
          <div>
            <Button type="button" size="sm" variant="outline" className="gap-1.5" disabled={!urlValid || discovering} onClick={() => void discover()}>
              {discovering ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />} {t("Modelle laden")}
            </Button>
          </div>
          {foundModels && (
            <div className="grid animate-in gap-2 rounded-xl border p-2 fade-in duration-150">
              {foundModels.length > 12 && (
                <Input value={modelFilter} placeholder={t("{0} Modelle filtern …", foundModels.length)} className="h-7 text-[12px]" onChange={(changeEvent) => setModelFilter(changeEvent.target.value)} />
              )}
              <div className="flex max-h-40 flex-wrap gap-1 overflow-y-auto">
                {shownFoundModels.map((model) => (
                  <button
                    key={model}
                    type="button"
                    onClick={() => toggleModel(model)}
                    className={cn(
                      "rounded-md border px-2 py-0.5 font-mono text-[11.5px] transition-colors hover:bg-foreground/[0.04]",
                      models.includes(model) && "border-primary bg-primary/[0.08] text-foreground",
                    )}
                  >
                    {model}
                  </button>
                ))}
              </div>
              <p className="text-[11.5px] text-muted-foreground">{t("Antippen fügt das Modell hinzu oder entfernt es.")}</p>
            </div>
          )}
        </div>
      </FormField>

      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={!canSave || props.busy}
          onClick={() =>
            props.onSave({
              name: name.trim(),
              protocol,
              baseUrl: baseUrl.trim(),
              models,
              needsKey,
              ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
            })
          }
        >
          {props.busy ? <Loader2 className="size-3.5 animate-spin" /> : provider ? t("Speichern") : t("Hinzufügen")}
          <SavedCheck saved={props.saved ?? false} />
        </Button>
        {props.onDelete && (
          <Button size="sm" variant="ghost" className="gap-1.5 text-muted-foreground" disabled={props.busy} onClick={props.onDelete}>
            <Trash2 className="size-3.5" /> {t("Entfernen")}
          </Button>
        )}
      </div>
    </div>
  );
}

const entryClassName = (selected: boolean) =>
  cn("flex h-8 items-center gap-1.5 rounded-lg border px-3 text-[13px] transition-colors hover:bg-foreground/[0.04]", selected && "border-primary bg-primary/[0.06]");

function AddEntryButton(props: { selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={cn(
        "flex h-8 items-center gap-1.5 rounded-lg border border-dashed px-3 text-[13px] text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground",
        props.selected && "border-primary text-foreground",
      )}
    >
      <Plus className="size-3.5" /> {t("Anbieter hinzufügen")}
    </button>
  );
}

/** Created provider = the one not in the list before. */
const createdIn = (before: ProvidersView, after: ProvidersView) => after.providers.find((provider) => !before.providers.some((existing) => existing.id === provider.id));

type ProviderConnectionProps = {
  status: ClaudeAuthStatus | null;
  providers: ProvidersView | null;
  onStatusChange: (status: ClaudeAuthStatus) => void;
  onProvidersChange: (providers: ProvidersView) => void;
  onError: (unknownError: unknown) => void;
};

/**
 * Claude Code's access: Claude (login / API key) or an Anthropic-compatible endpoint.
 * Used in settings and onboarding.
 */
export function ProviderConnection(props: ProviderConnectionProps) {
  const { providers, status, onProvidersChange, onError } = props;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { busy, saved, run } = useAsyncAction(onError);

  // Start on the active provider; stay on the user's pick afterwards.
  const activeId = providers?.activeId ?? claudeEntryId;
  useEffect(() => setSelectedId((previous) => previous ?? activeId), [activeId]);
  if (!providers) return <div className="h-40" />;

  const anthropicProviders = providers.providers.filter((provider) => provider.protocol === "anthropic");
  const anthropicPresets = providers.presets.filter((preset) => preset.protocol === "anthropic");
  const shownId = selectedId ?? activeId;
  const selectedProvider = anthropicProviders.find((provider) => provider.id === shownId) ?? null;

  const activate = (providerId: string) =>
    run(async () => {
      onProvidersChange(await api.setActiveProvider(providerId));
      props.onStatusChange(await api.readClaudeStatus(true));
    });

  const entries = [
    { id: claudeEntryId, name: "Claude", icon: Sparkles },
    ...anthropicProviders.map((provider) => ({ id: provider.id, name: provider.name, icon: Server })),
  ];

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap gap-1.5">
        {entries.map((entry) => (
          <button key={entry.id} type="button" onClick={() => setSelectedId(entry.id)} className={entryClassName(entry.id === shownId)}>
            <entry.icon className="size-3.5 text-muted-foreground" />
            {entry.name}
            {entry.id === activeId && <CheckCircle2 className="size-3.5 text-status-running" aria-label={t("Aktiv")} />}
          </button>
        ))}
        <AddEntryButton selected={shownId === newEntryId} onClick={() => setSelectedId(newEntryId)} />
      </div>

      {shownId === newEntryId ? (
        <>
          <p className="-mt-2 text-[12px] text-muted-foreground">{t("Claude Code spricht nur die Anthropic-Schnittstelle. Andere Anbieter (OpenAI, Gemini, Ollama …) nutzt der Harnold-Agent.")}</p>
          <ProviderForm
            key="new"
            provider={null}
            presets={anthropicPresets}
            fixedProtocol="anthropic"
            busy={busy}
            saved={saved}
            onError={onError}
            onSave={(input) =>
              void run(async () => {
                const created = await api.createProvider(input);
                const createdProvider = createdIn(providers, created);
                onProvidersChange(created);
                if (createdProvider) {
                  setSelectedId(createdProvider.id);
                  onProvidersChange(await api.setActiveProvider(createdProvider.id));
                  props.onStatusChange(await api.readClaudeStatus(true));
                }
              })
            }
          />
        </>
      ) : selectedProvider ? (
        <div key={selectedProvider.id} className="grid gap-5">
          {shownId !== activeId && (
            <div className="flex items-center gap-3 rounded-xl border px-4 py-3">
              <span className="flex-1 text-[13px] text-muted-foreground">{t("Dieser Anbieter ist nicht aktiv.")}</span>
              <Button size="sm" disabled={busy || !selectedProvider.ready} onClick={() => void activate(selectedProvider.id)}>
                {t("Verwenden")}
              </Button>
            </div>
          )}
          <ProviderForm
            provider={selectedProvider}
            presets={anthropicPresets}
            fixedProtocol="anthropic"
            busy={busy}
            saved={saved}
            onError={onError}
            onSave={(input) =>
              void run(async () => {
                onProvidersChange(await api.updateProvider(selectedProvider.id, input));
                props.onStatusChange(await api.readClaudeStatus(true));
              })
            }
            onDelete={() =>
              void run(async () => {
                onProvidersChange(await api.deleteProvider(selectedProvider.id));
                setSelectedId(null);
                props.onStatusChange(await api.readClaudeStatus(true));
              })
            }
          />
          {status && !status.runtime.found && <ClaudeConnectionPanel status={status} onStatusChange={props.onStatusChange} onError={onError} />}
        </div>
      ) : (
        <div key="claude" className="grid gap-5">
          {activeId !== claudeEntryId && (
            <div className="flex items-center gap-3 rounded-xl border px-4 py-3">
              <span className="flex-1 text-[13px] text-muted-foreground">{t("Claude ist nicht aktiv.")}</span>
              <Button size="sm" disabled={busy} onClick={() => void activate(claudeEntryId)}>
                {t("Verwenden")}
              </Button>
            </div>
          )}
          <ClaudeConnectionPanel status={status} onStatusChange={props.onStatusChange} onError={onError} />
        </div>
      )}
    </div>
  );
}

/**
 * Harnold-Agent: any number of providers over either protocol, all usable at the same time
 * (the model picker lists "Anbieter · Modell").
 */
export function NativeProviders(props: { providers: ProvidersView | null; onProvidersChange: (providers: ProvidersView) => void; onError: (unknownError: unknown) => void }) {
  const { providers, onProvidersChange, onError } = props;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { busy, saved, run } = useAsyncAction(onError);
  if (!providers) return <div className="h-40" />;

  const shownId = selectedId ?? providers.providers[0]?.id ?? newEntryId;
  const selectedProvider = providers.providers.find((provider) => provider.id === shownId) ?? null;

  return (
    <div className="grid gap-5">
      <p className="text-[12px] text-muted-foreground">
        {t("Harnolds eigener Agent – ohne Zusatzprogramm. Er nutzt alle eingerichteten Anbieter gleichzeitig; das Modell wählst du im Chat.")}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {providers.providers.map((provider) => (
          <button key={provider.id} type="button" onClick={() => setSelectedId(provider.id)} className={entryClassName(provider.id === shownId)}>
            <Server className="size-3.5 text-muted-foreground" />
            {provider.name}
            {provider.ready ? (
              <CheckCircle2 className="size-3.5 text-status-running" aria-label={t("Bereit")} />
            ) : (
              <CircleAlert className="size-3.5 text-status-waiting" aria-label={t("Nicht fertig eingerichtet")} />
            )}
          </button>
        ))}
        <AddEntryButton selected={shownId === newEntryId} onClick={() => setSelectedId(newEntryId)} />
      </div>

      {shownId === newEntryId || !selectedProvider ? (
        <ProviderForm
          key="new"
          provider={null}
          presets={providers.presets}
          busy={busy}
          saved={saved}
          onError={onError}
          onSave={(input) =>
            void run(async () => {
              const created = await api.createProvider(input);
              onProvidersChange(created);
              const createdProvider = createdIn(providers, created);
              if (createdProvider) setSelectedId(createdProvider.id);
            })
          }
        />
      ) : (
        <div key={selectedProvider.id} className="grid gap-3">
          <p className="text-[12px] text-muted-foreground">
            {protocolLabel(selectedProvider.protocol)} · {t("{0} Modelle", selectedProvider.models.length)}
            {!selectedProvider.ready && ` · ${t("API-Key fehlt")}`}
          </p>
          <ProviderForm
            provider={selectedProvider}
            presets={providers.presets}
            busy={busy}
            saved={saved}
            onError={onError}
            onSave={(input) => void run(async () => onProvidersChange(await api.updateProvider(selectedProvider.id, input)))}
            onDelete={() =>
              void run(async () => {
                onProvidersChange(await api.deleteProvider(selectedProvider.id));
                setSelectedId(null);
              })
            }
          />
        </div>
      )}
    </div>
  );
}
