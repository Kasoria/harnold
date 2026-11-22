import { useState } from "react";
import { CheckCircle2, Download, ExternalLink, KeyRound, Loader2, LogIn, LogOut, RefreshCw, TriangleAlert } from "lucide-react";
import { api } from "@/api";
import type { AgentRuntimeStatus, ClaudeAuthMode, ClaudeAuthStatus } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/segmented-control";
import { FormField } from "@/components/form-field";
import { isActionEnter } from "@/lib/utils";
import { t } from "@/lib/i18n";

type ClaudeConnectionPanelProps = {
  status: ClaudeAuthStatus | null;
  onStatusChange: (status: ClaudeAuthStatus) => void;
  onError: (unknownError: unknown) => void;
};

const planLabels: Record<string, string> = { pro: t("Pro"), max: t("Max"), team: t("Team"), enterprise: t("Enterprise") };

type ClaudeAccountSectionProps = ClaudeConnectionPanelProps & {
  status: ClaudeAuthStatus;
  /** Own Claude login of this environment; omitted = the workspace login. */
  environmentId?: string;
};

/** Claude login (subscription / Console): account card, or login steps (open URL, paste code). */
export function ClaudeAccountSection(props: ClaudeAccountSectionProps) {
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [loginCode, setLoginCode] = useState("");
  const [busyAction, setBusyAction] = useState<"login" | "code" | "logout" | null>(null);
  const { status, onStatusChange, onError, environmentId } = props;

  const run = async (action: NonNullable<typeof busyAction>, operation: () => Promise<void>) => {
    setBusyAction(action);
    try {
      await operation();
    } catch (operationError) {
      onError(operationError);
    } finally {
      setBusyAction(null);
    }
  };

  const startLogin = (method: "claudeai" | "console") =>
    void run("login", async () => {
      const { url } = await api.startClaudeLogin(method, environmentId);
      setLoginUrl(url);
      setLoginCode("");
      window.open(url, "_blank", "noopener");
    });

  const submitCode = () =>
    void run("code", async () => {
      onStatusChange(await api.submitClaudeLoginCode(loginCode, environmentId));
      setLoginUrl(null);
    });

  const cancelLogin = () => {
    setLoginUrl(null);
    api.cancelClaudeLogin(environmentId).catch(onError);
  };

  const account = status.account;

  return (
    <div className="grid animate-in gap-4 fade-in duration-200">
      {account?.loggedIn && !loginUrl ? (
        <div className="flex items-center gap-3 rounded-xl border px-4 py-3">
          <CheckCircle2 className="size-4 shrink-0 text-status-running" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium">{account.email ?? t("Angemeldet")}</div>
            <div className="truncate text-[12px] text-muted-foreground">
              {[account.authMethod === "claude.ai" ? `Claude ${planLabels[account.subscriptionType ?? ""] ?? t("Abo")}` : "Console (API-Abrechnung)", account.orgName].filter(Boolean).join(" · ")}
            </div>
          </div>
          <Button type="button" size="sm" variant="ghost" className="h-7 text-[12px]" disabled={busyAction !== null} onClick={() => startLogin("claudeai")}>
            {t("Anderes Konto")}
          </Button>
          <Button type="button" size="sm" variant="ghost" className="h-7 gap-1.5 text-[12px] text-muted-foreground" disabled={busyAction !== null} onClick={() => void run("logout", async () => onStatusChange(await api.logoutClaude(environmentId)))}>
            {busyAction === "logout" ? <Loader2 className="size-3.5 animate-spin" /> : <LogOut className="size-3.5" />} {t("Abmelden")}
          </Button>
        </div>
      ) : loginUrl ? (
        <div className="grid animate-in gap-3 rounded-xl border px-4 py-4 fade-in duration-200">
          <p className="text-[13px]">
            <span className="font-medium">1.</span> {t("Auf der Anmeldeseite bei Claude einloggen und Zugriff erlauben.")}{" "}
            <a href={loginUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline underline-offset-2">
              {t("Seite öffnen")} <ExternalLink className="size-3" />
            </a>
          </p>
          <p className="text-[13px]">
            <span className="font-medium">2.</span> {t("Den angezeigten Code hier einfügen:")}
          </p>
          <div className="flex gap-2">
            <Input
              autoFocus
              value={loginCode}
              placeholder={t("Code")}
              className="font-mono"
              onChange={(changeEvent) => setLoginCode(changeEvent.target.value)}
              onKeyDown={(keyboardEvent) => {
                if (isActionEnter(keyboardEvent)) {
                  keyboardEvent.preventDefault();
                  if (loginCode.trim()) submitCode();
                }
              }}
            />
            <Button type="button" size="sm" className="h-9" disabled={!loginCode.trim() || busyAction !== null} onClick={submitCode}>
              {busyAction === "code" ? <Loader2 className="size-3.5 animate-spin" /> : t("Verbinden")}
            </Button>
            <Button type="button" size="sm" variant="ghost" className="h-9" onClick={cancelLogin}>
              {t("Abbrechen")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid gap-2">
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={busyAction !== null} onClick={() => startLogin("claudeai")}>
              {busyAction === "login" ? <Loader2 className="size-3.5 animate-spin" /> : <LogIn className="size-3.5" />} {t("Mit Claude anmelden")}
            </Button>
            <Button type="button" size="sm" variant="ghost" className="text-muted-foreground" disabled={busyAction !== null} onClick={() => startLogin("console")}>
              {t("Console-Konto (API-Abrechnung)")}
            </Button>
          </div>
        </div>
      )}
      {status.cliError && <p className="text-[12px] text-destructive">{t("Status nicht lesbar:")} {status.cliError}</p>}
    </div>
  );
}

const megabytes = (byteCount: number) => `${Math.round(byteCount / 1_000_000)} MB`;
const runtimeSourceLabels: Record<NonNullable<AgentRuntimeStatus["source"]>, string> = {
  installed: t("auf diesem Rechner installiert"),
  downloaded: t("von Harnold geladen"),
  bundled: t("aus der Harnold-Installation"),
  configured: t("fest eingestellt"),
};

/**
 * The Claude Code program. Harnold uses an existing install; downloading one is the user's explicit choice.
 * Returns the found-line when present, otherwise the choice (install yourself / download).
 */
export function AgentRuntimeSection(props: { runtime: AgentRuntimeStatus; onRecheck: () => Promise<void>; onError: (unknownError: unknown) => void }) {
  const [checking, setChecking] = useState(false);
  const { runtime, onRecheck, onError } = props;

  const recheck = async () => {
    setChecking(true);
    try {
      await onRecheck();
    } catch (checkError) {
      onError(checkError);
    } finally {
      setChecking(false);
    }
  };

  if (runtime.found) {
    return (
      <div className="grid gap-1 text-[12px] text-muted-foreground">
        <span title={runtime.executablePath}>
          {runtime.name} {runtime.version ?? ""} · {runtimeSourceLabels[runtime.source ?? "installed"]}
        </span>
        {runtime.outdated && (
          <span>
            {t("Älter als empfohlen (")}{runtime.recommendedVersion}{t(") – aktualisieren mit")} <code className="font-mono">{runtime.updateHint}</code>
          </span>
        )}
      </div>
    );
  }

  const { download } = runtime;
  return (
    <div className="grid animate-in gap-3 rounded-xl border px-4 py-4 fade-in duration-200">
      <div className="flex items-start gap-2 text-[13px]">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p>
          {t("Harnold steuert")} {runtime.name}{t(", das Programm ist auf diesem Rechner aber nicht gefunden")}
          {runtime.tooOldPath ? t(" (nur eine zu alte Version unter {0})", runtime.tooOldPath) : ""}.
        </p>
      </div>
      <div className="grid gap-1.5 text-[13px]">
        <span className="font-medium">{t("Selbst installieren (empfohlen)")}</span>
        <code className="rounded-md bg-muted px-2 py-1.5 font-mono text-[12px] select-all">{runtime.installHint}</code>
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="ghost" className="h-7 gap-1.5 text-[12px]" disabled={checking} onClick={() => void recheck()}>
            {checking ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} {t("Erneut prüfen")}
          </Button>
          <a href={runtime.installUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12px] text-muted-foreground underline underline-offset-2">
            {t("Anleitung")} <ExternalLink className="size-3" />
          </a>
        </div>
      </div>
      {runtime.downloadable && (
      <div className="grid gap-1.5 text-[13px]">
        <span className="font-medium">{t("Oder von Harnold laden")}</span>
        <span className="text-[12px] text-muted-foreground">{t("Nur für Harnold, Version")} {runtime.recommendedVersion}. Download ca. 165 MB, belegt ca. 360 MB.</span>
        {download.running ? (
          <div className="grid gap-1">
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-primary transition-[width]"
                style={{ width: download.totalBytes ? `${Math.min(100, (download.receivedBytes / download.totalBytes) * 100)}%` : "30%" }}
              />
            </div>
            <span className="text-[12px] text-muted-foreground">
              {megabytes(download.receivedBytes)}
              {download.totalBytes ? ` von ${megabytes(download.totalBytes)}` : ""} {t("geladen …")}
            </span>
          </div>
        ) : (
          <div>
            <Button type="button" size="sm" variant="secondary" onClick={() => api.downloadRuntime(runtime.id).catch(onError)}>
              <Download className="size-3.5" /> {runtime.name} herunterladen
            </Button>
          </div>
        )}
        {download.error && <p className="text-[12px] text-destructive">{t("Download fehlgeschlagen:")} {download.error}</p>}
      </div>
      )}
    </div>
  );
}

/** Connect Harnold to Claude: Claude login (subscription / Console) or an API key. Used in settings and onboarding. */
export function ClaudeConnectionPanel(props: ClaudeConnectionPanelProps) {
  const [busy, setBusy] = useState(false);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const { status, onStatusChange, onError } = props;

  if (!status) return <div className="h-40" />;

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

  const changeMode = (mode: ClaudeAuthMode) => void run(async () => onStatusChange(await api.saveClaudeSettings(mode)));

  if (!status.runtime.found) return <AgentRuntimeSection runtime={status.runtime} onRecheck={async () => onStatusChange(await api.readClaudeStatus(true))} onError={onError} />;

  return (
    <div className="grid gap-5">
      <SegmentedControl
        className="w-72"
        options={[
          { value: "subscription", label: t("Claude-Konto") },
          { value: "apiKey", label: t("API-Key") },
        ]}
        value={status.mode}
        onValueChange={changeMode}
      />

      {status.mode === "subscription" ? (
        <ClaudeAccountSection key="subscription" status={status} onStatusChange={onStatusChange} onError={onError} />
      ) : (
        <div key="apiKey" className="grid animate-in gap-3 fade-in duration-200">
          <FormField
            label={t("Anthropic API-Key")}
            htmlFor="claude-api-key"
            hint={!status.apiKeySet && status.environmentApiKey ? t("ANTHROPIC_API_KEY aus der Umgebung aktiv") : undefined}
          >
            <Input id="claude-api-key" type="password" autoComplete="off" value={apiKeyDraft} placeholder={status.apiKeySet ? "••••••••" : "sk-ant-…"} onChange={(changeEvent) => setApiKeyDraft(changeEvent.target.value)} />
          </FormField>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={!apiKeyDraft.trim() || busy}
              onClick={() =>
                void run(async () => {
                  onStatusChange(await api.saveClaudeSettings("apiKey", apiKeyDraft));
                  setApiKeyDraft("");
                })
              }
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <KeyRound className="size-3.5" />} {t("Speichern")}
            </Button>
            {status.apiKeySet && (
              <Button size="sm" variant="ghost" className="text-muted-foreground" disabled={busy} onClick={() => void run(async () => onStatusChange(await api.saveClaudeSettings("apiKey", "")))}>
                {t("Entfernen")}
              </Button>
            )}
          </div>
        </div>
      )}
      <AgentRuntimeSection runtime={status.runtime} onRecheck={async () => onStatusChange(await api.readClaudeStatus(true))} onError={onError} />
    </div>
  );
}
