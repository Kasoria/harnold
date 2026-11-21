import { useState } from "react";
import { CheckCircle2, ExternalLink, KeyRound, Loader2, LogIn, LogOut } from "lucide-react";
import { api } from "@/api";
import type { ClaudeAuthMode, ClaudeAuthStatus } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/segmented-control";
import { FormField } from "@/components/form-field";

type ClaudeConnectionPanelProps = {
  status: ClaudeAuthStatus | null;
  onStatusChange: (status: ClaudeAuthStatus) => void;
  onError: (unknownError: unknown) => void;
};

const planLabels: Record<string, string> = { pro: "Pro", max: "Max", team: "Team", enterprise: "Enterprise" };

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
            <div className="truncate text-[13px] font-medium">{account.email ?? "Angemeldet"}</div>
            <div className="truncate text-[12px] text-muted-foreground">
              {[account.authMethod === "claude.ai" ? `Claude ${planLabels[account.subscriptionType ?? ""] ?? "Abo"}` : "Console (API-Abrechnung)", account.orgName].filter(Boolean).join(" · ")}
            </div>
          </div>
          <Button type="button" size="sm" variant="ghost" className="h-7 text-[12px]" disabled={busyAction !== null} onClick={() => startLogin("claudeai")}>
            Anderes Konto
          </Button>
          <Button type="button" size="sm" variant="ghost" className="h-7 gap-1.5 text-[12px] text-muted-foreground" disabled={busyAction !== null} onClick={() => void run("logout", async () => onStatusChange(await api.logoutClaude(environmentId)))}>
            {busyAction === "logout" ? <Loader2 className="size-3.5 animate-spin" /> : <LogOut className="size-3.5" />} Abmelden
          </Button>
        </div>
      ) : loginUrl ? (
        <div className="grid animate-in gap-3 rounded-xl border px-4 py-4 fade-in duration-200">
          <p className="text-[13px]">
            <span className="font-medium">1.</span> Auf der Anmeldeseite bei Claude einloggen und Zugriff erlauben.{" "}
            <a href={loginUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline underline-offset-2">
              Seite öffnen <ExternalLink className="size-3" />
            </a>
          </p>
          <p className="text-[13px]">
            <span className="font-medium">2.</span> Den angezeigten Code hier einfügen:
          </p>
          <div className="flex gap-2">
            <Input
              autoFocus
              value={loginCode}
              placeholder="Code"
              className="font-mono"
              onChange={(changeEvent) => setLoginCode(changeEvent.target.value)}
              onKeyDown={(keyboardEvent) => {
                if (keyboardEvent.key === "Enter") {
                  keyboardEvent.preventDefault();
                  if (loginCode.trim()) submitCode();
                }
              }}
            />
            <Button type="button" size="sm" className="h-9" disabled={!loginCode.trim() || busyAction !== null} onClick={submitCode}>
              {busyAction === "code" ? <Loader2 className="size-3.5 animate-spin" /> : "Verbinden"}
            </Button>
            <Button type="button" size="sm" variant="ghost" className="h-9" onClick={cancelLogin}>
              Abbrechen
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid gap-2">
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={busyAction !== null} onClick={() => startLogin("claudeai")}>
              {busyAction === "login" ? <Loader2 className="size-3.5 animate-spin" /> : <LogIn className="size-3.5" />} Mit Claude anmelden
            </Button>
            <Button type="button" size="sm" variant="ghost" className="text-muted-foreground" disabled={busyAction !== null} onClick={() => startLogin("console")}>
              Console-Konto
            </Button>
          </div>
          <p className="text-[12px] text-muted-foreground">Pro, Max, Team oder Enterprise. „Console-Konto“ rechnet über die API ab.</p>
        </div>
      )}
      <p className="text-[11.5px] leading-snug text-muted-foreground">
        {environmentId ? (
          "Eigene Anmeldung nur für diese Umgebung – die normale Claude-Code-Anmeldung des Rechners bleibt unberührt."
        ) : (
          <>
            Nutzt die Claude-Code-Anmeldung dieses Rechners – ist <code className="font-mono">claude</code> hier schon angemeldet, ist Harnold es auch.
          </>
        )}
      </p>
      {status.cliError && <p className="text-[12px] text-destructive">Status nicht lesbar: {status.cliError}</p>}
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

  return (
    <div className="grid gap-5">
      <SegmentedControl
        className="w-72"
        options={[
          { value: "subscription", label: "Claude-Konto" },
          { value: "apiKey", label: "API-Key" },
        ]}
        value={status.mode}
        onValueChange={changeMode}
      />

      {status.mode === "subscription" ? (
        <ClaudeAccountSection key="subscription" status={status} onStatusChange={onStatusChange} onError={onError} />
      ) : (
        <div key="apiKey" className="grid animate-in gap-3 fade-in duration-200">
          <FormField
            label="Anthropic API-Key"
            htmlFor="claude-api-key"
            hint={
              status.apiKeySet
                ? "Gespeichert (verschlüsselt). Leer lassen, um ihn zu behalten."
                : status.environmentApiKey
                  ? "ANTHROPIC_API_KEY aus der Umgebung wird genutzt, solange hier keiner gespeichert ist."
                  : "Aus der Claude Console (console.anthropic.com → API Keys). Wird verschlüsselt gespeichert."
            }
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
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <KeyRound className="size-3.5" />} Speichern
            </Button>
            {status.apiKeySet && (
              <Button size="sm" variant="ghost" className="text-muted-foreground" disabled={busy} onClick={() => void run(async () => onStatusChange(await api.saveClaudeSettings("apiKey", "")))}>
                Entfernen
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** First-run screen when Claude is not connected yet. */
export function ClaudeOnboarding(props: ClaudeConnectionPanelProps & { onDismiss: () => void }) {
  const ready = props.status?.ready ?? false;
  return (
    <div className="fixed inset-0 z-40 flex animate-in items-center justify-center bg-background/95 p-6 backdrop-blur-sm fade-in duration-200">
      <div className="w-full max-w-md">
        <h1 className="text-[20px] font-semibold">Willkommen bei Harnold</h1>
        <p className="mt-1 mb-6 text-[13px] text-muted-foreground">Verbinde Claude – damit arbeitet der Agent in deinen Projekten.</p>
        <ClaudeConnectionPanel status={props.status} onStatusChange={props.onStatusChange} onError={props.onError} />
        <div className="mt-8 flex items-center gap-2">
          {ready ? (
            <Button size="sm" onClick={props.onDismiss}>
              <CheckCircle2 className="size-3.5" /> Verbunden – los geht's
            </Button>
          ) : (
            <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={props.onDismiss}>
              Später
            </Button>
          )}
          <span className="ml-auto text-[11.5px] text-muted-foreground">Jederzeit unter Einstellungen → Claude</span>
        </div>
      </div>
    </div>
  );
}
