import { useEffect, useState } from "react";
import { Bot, CheckCircle2, ExternalLink, KeyRound, Loader2, LogIn, LogOut, Sparkles } from "lucide-react";
import { api } from "@/api";
import type { AgentBackendId, AgentBackendsView, ClaudeAuthStatus, CodexStatus, ProvidersView } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "@/components/form-field";
import { SegmentedControl } from "@/components/segmented-control";
import { AgentRuntimeSection } from "@/components/claude-connection";
import { NativeProviders, ProviderConnection } from "@/components/provider-connection";
import { HarnoldSymbol } from "@/components/harnold-logo";
import { ModelSelect, modelsForBackend } from "@/components/model-select";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

export type AgentConnectionProps = {
  backends: AgentBackendsView | null;
  codex: CodexStatus | null;
  claudeStatus: ClaudeAuthStatus | null;
  providers: ProvidersView | null;
  onBackendsChange: (backends: AgentBackendsView) => void;
  onCodexChange: (codex: CodexStatus) => void;
  onClaudeStatusChange: (status: ClaudeAuthStatus) => void;
  onProvidersChange: (providers: ProvidersView) => void;
  /** The active agent's default model changed (settings keep it in sync). */
  onDefaultModelChange?: (defaultModel: string) => void;
  onError: (unknownError: unknown) => void;
};

/** Codex: program, sign-in (ChatGPT account or API key) and the models offered in pickers. */
function CodexPanel(props: { codex: CodexStatus | null; onChange: (codex: CodexStatus) => void; onError: (unknownError: unknown) => void }) {
  const { codex, onChange, onError } = props;
  const [busy, setBusy] = useState(false);
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [modelText, setModelText] = useState<string | null>(null);
  if (!codex) return <div className="h-32" />;

  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    try {
      await operation();
    } catch (operationError) {
      onError(operationError);
    } finally {
      setBusy(false);
    }
  };

  if (!codex.runtime.found) {
    return <AgentRuntimeSection runtime={codex.runtime} onRecheck={async () => onChange(await api.readCodexStatus(true))} onError={onError} />;
  }

  const shownModelText = modelText ?? codex.models.join("\n");

  return (
    <div className="grid gap-5">
      <SegmentedControl
        className="w-72"
        options={[
          { value: "login", label: t("ChatGPT-Konto") },
          { value: "apiKey", label: t("API-Key") },
        ]}
        value={codex.mode}
        onValueChange={(mode) => void run(async () => onChange(await api.saveCodexSettings({ mode })))}
      />

      {codex.mode === "login" ? (
        codex.loggedIn && !loginUrl ? (
          <div className="flex items-center gap-3 rounded-xl border px-4 py-3">
            <CheckCircle2 className="size-4 shrink-0 text-status-running" />
            <span className="min-w-0 flex-1 truncate text-[13px]">{codex.loginText ?? t("Angemeldet")}</span>
            <Button type="button" size="sm" variant="ghost" className="h-7 gap-1.5 text-[12px] text-muted-foreground" disabled={busy} onClick={() => void run(async () => onChange(await api.logoutCodex()))}>
              <LogOut className="size-3.5" /> {t("Abmelden")}
            </Button>
          </div>
        ) : (
          <div className="grid gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const { url } = await api.startCodexLogin();
                    setLoginUrl(url);
                    window.open(url, "_blank", "noopener");
                  })
                }
              >
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : <LogIn className="size-3.5" />} {t("Mit ChatGPT anmelden")}
              </Button>
              {loginUrl && (
                <>
                  <a href={loginUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12px] text-muted-foreground underline underline-offset-2">
                    {t("Seite öffnen")} <ExternalLink className="size-3" />
                  </a>
                  <Button type="button" size="sm" variant="ghost" onClick={() => void run(async () => onChange(await api.readCodexStatus(true)))}>
                    {t("Erneut prüfen")}
                  </Button>
                </>
              )}
            </div>
            {loginUrl && <p className="text-[12px] text-muted-foreground">{t("Nach der Anmeldung im Browser kommt Harnold von selbst weiter.")}</p>}
          </div>
        )
      ) : (
        <div className="grid gap-3">
          <FormField label={t("OpenAI API-Key")} hint={!codex.apiKeySet && codex.environmentApiKey ? t("API-Key aus der Umgebung aktiv") : undefined}>
            <Input type="password" autoComplete="off" value={apiKeyDraft} placeholder={codex.apiKeySet ? "••••••••" : "sk-…"} onChange={(changeEvent) => setApiKeyDraft(changeEvent.target.value)} />
          </FormField>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={!apiKeyDraft.trim() || busy}
              onClick={() =>
                void run(async () => {
                  onChange(await api.saveCodexSettings({ mode: "apiKey", apiKey: apiKeyDraft }));
                  setApiKeyDraft("");
                })
              }
            >
              <KeyRound className="size-3.5" /> {t("Speichern")}
            </Button>
            {codex.apiKeySet && (
              <Button size="sm" variant="ghost" className="text-muted-foreground" disabled={busy} onClick={() => void run(async () => onChange(await api.saveCodexSettings({ mode: "apiKey", apiKey: "" })))}>
                {t("Entfernen")}
              </Button>
            )}
          </div>
        </div>
      )}

      <FormField label={t("Weitere Modelle")} hint={t("Modell-IDs, eine pro Zeile. „Codex-Standard“ ist immer dabei.")}>
        <Textarea value={shownModelText} rows={3} className="font-mono text-[13px]" onChange={(changeEvent) => setModelText(changeEvent.target.value)} />
      </FormField>
      {modelText !== null && modelText !== codex.models.join("\n") && (
        <div>
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                onChange(await api.saveCodexSettings({ mode: codex.mode, models: modelText.split(/[\s,]+/).filter(Boolean) }));
                setModelText(null);
              })
            }
          >
            {t("Speichern")}
          </Button>
        </div>
      )}
      <p className="text-[12px] text-muted-foreground">{t("Codex fragt nicht einzeln nach: Die Berechtigung bestimmt, wie weit die Sandbox reicht (Planen = nur lesen, Fragen/Edits = Projektordner, Alles erlauben = ohne Sandbox).")}</p>
      <AgentRuntimeSection runtime={codex.runtime} onRecheck={async () => onChange(await api.readCodexStatus(true))} onError={onError} />
    </div>
  );
}

const backendIcons: Record<AgentBackendId, React.ComponentType<{ className?: string }>> = { "claude-code": Sparkles, codex: Bot, native: HarnoldSymbol };

const backendHints: Record<AgentBackendId, string> = {
  "claude-code": "Claude – Abo, API-Key oder Anthropic-kompatibel",
  codex: "ChatGPT-Konto oder OpenAI-Key",
  native: "Jeder Anbieter: OpenAI, Gemini, Ollama, OpenRouter …",
};

/**
 * Choose which agent program Harnold drives (Claude Code, Codex, …) and set it up. Nothing is fixed:
 * the choice is a setting, and an environment can override it. Used in settings and onboarding.
 */
export function AgentConnection(props: AgentConnectionProps) {
  const { backends, onBackendsChange, onError } = props;
  const [selectedId, setSelectedId] = useState<AgentBackendId | null>(null);
  const [busy, setBusy] = useState(false);
  const [shownModel, setShownModel] = useState<string | null>(null);
  const shownId = selectedId ?? backends?.activeId;

  useEffect(() => {
    if (!shownId) return;
    setShownModel(null);
    api.readDefaultModel(shownId).then(({ defaultModel }) => setShownModel(defaultModel)).catch(onError);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- onError is a fresh function each render
  }, [shownId]);

  if (!backends || !shownId) return <div className="h-40" />;
  const shownBackend = backends.backends.find((backend) => backend.id === shownId);
  const shownModels = modelsForBackend(shownId, props.providers, props.codex);

  const saveModel = (model: string) =>
    api
      .saveDefaultModel(model, shownId)
      .then(({ defaultModel }) => {
        setShownModel(defaultModel);
        if (shownId === backends.activeId) props.onDefaultModelChange?.(defaultModel);
      })
      .catch(onError);

  const activate = async (backendId: AgentBackendId) => {
    setBusy(true);
    try {
      onBackendsChange(await api.setActiveBackend(backendId));
      props.onClaudeStatusChange(await api.readClaudeStatus(true));
    } catch (activateError) {
      onError(activateError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-6">
      <div className="grid gap-2 sm:grid-cols-3">
        {backends.backends.map((backend) => {
          const Icon = backendIcons[backend.id];
          return (
            <button
              key={backend.id}
              type="button"
              onClick={() => setSelectedId(backend.id)}
              className={cn("flex items-start gap-3 rounded-xl border px-4 py-3 text-left transition-colors hover:bg-foreground/[0.04]", backend.id === shownId && "border-primary bg-primary/[0.06]")}
            >
              <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-[13px] font-medium">
                  {backend.name}
                  {backend.id === backends.activeId && <CheckCircle2 className="size-3.5 text-status-running" aria-label={t("Aktiv")} />}
                </span>
                <span className="block text-[12px] text-muted-foreground">{t(backendHints[backend.id])}</span>
                <span className={cn("mt-1 block text-[11.5px]", backend.ready ? "text-status-running" : "text-muted-foreground")}>
                  {backend.ready ? t("Bereit") : !backend.runtime ? t("Kein Anbieter eingerichtet") : backend.runtime.found ? t("Nicht angemeldet") : t("Nicht installiert")}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {shownBackend && shownBackend.id !== backends.activeId && (
        <div className="flex items-center gap-3 rounded-xl border px-4 py-3">
          <span className="flex-1 text-[13px] text-muted-foreground">{t("{0} ist nicht der aktive Agent. Neue Chats nutzen ihn erst danach.", shownBackend.name)}</span>
          <Button size="sm" disabled={busy || !shownBackend.ready} onClick={() => void activate(shownBackend.id)}>
            {t("Verwenden")}
          </Button>
        </div>
      )}

      {shownId === "claude-code" ? (
        <ProviderConnection
          status={props.claudeStatus}
          providers={props.providers}
          onStatusChange={props.onClaudeStatusChange}
          onProvidersChange={props.onProvidersChange}
          onError={onError}
        />
      ) : shownId === "native" ? (
        <NativeProviders
          providers={props.providers}
          onProvidersChange={async (providers) => {
            props.onProvidersChange(providers);
            onBackendsChange(await api.readAgentBackends(true));
          }}
          onError={onError}
        />
      ) : (
        <CodexPanel
          codex={props.codex}
          onChange={async (codexStatus) => {
            props.onCodexChange(codexStatus);
            onBackendsChange(await api.readAgentBackends(true));
          }}
          onError={onError}
        />
      )}

      {shownModel !== null && shownModels.length > 0 && (
        <FormField label={t("Standardmodell von {0}", shownBackend?.name ?? "")}>
          <ModelSelect models={shownModels} value={shownModel} onChange={(model) => void saveModel(model)} />
        </FormField>
      )}
    </div>
  );
}

/** First-run screen when the active agent is not usable yet: pick any agent/provider, set it up. */
export function AgentOnboarding(props: AgentConnectionProps & { onDismiss: () => void }) {
  const activeBackend = props.backends?.backends.find((backend) => backend.id === props.backends?.activeId);
  const ready = activeBackend?.ready ?? false;
  return (
    <div className="fixed inset-0 z-40 flex animate-in justify-center overflow-y-auto bg-background/95 p-6 backdrop-blur-sm fade-in duration-200">
      <div className="my-auto w-full max-w-lg">
        <HarnoldSymbol className="mb-4 size-12" />
        <h1 className="text-[20px] font-semibold">{t("Willkommen bei Harnold")}</h1>
        <p className="mt-1 mb-6 text-[13px] text-muted-foreground">{t("Wähle deinen Agent und KI-Anbieter – damit arbeitet Harnold in deinen Projekten.")}</p>
        <AgentConnection {...props} />
        <div className="mt-8 flex items-center gap-2">
          {ready ? (
            <Button size="sm" onClick={props.onDismiss}>
              <CheckCircle2 className="size-3.5" /> {t("Verbunden – los geht's")}
            </Button>
          ) : (
            <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={props.onDismiss}>
              {t("Später")}
            </Button>
          )}
          <span className="ml-auto text-[11.5px] text-muted-foreground">{t("Jederzeit unter Einstellungen → Agent")}</span>
        </div>
      </div>
    </div>
  );
}
