import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { api } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { confirmAction } from "@/components/confirm-dialog";
import { locale, t } from "@/lib/i18n";
import type { WorkspacePushStatus } from "@/types";

const runningPhases: WorkspacePushStatus["phase"][] = ["packing", "uploading", "unpacking", "restarting"];
const statusPollMilliseconds = 1000;

/** Settings → General (local app only): moves projects, chats, memory, settings, secrets and agent configuration to a Harnold server. */
export function MigrateToServerSetting({ onError }: { onError: (error: unknown) => void }) {
  const [serverUrl, setServerUrl] = useState("");
  const [serverToken, setServerToken] = useState("");
  const [push, setPush] = useState<WorkspacePushStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [includeAgentConfiguration, setIncludeAgentConfiguration] = useState(true);
  const [includeAgentTranscripts, setIncludeAgentTranscripts] = useState(true);
  const running = starting || (!!push && runningPhases.includes(push.phase));

  // The transfer keeps running when this screen is closed: pick up its state again.
  useEffect(() => {
    api.readWorkspacePush().then(setPush, () => {});
  }, []);
  useEffect(() => {
    if (!running || starting) return;
    const timer = window.setInterval(() => api.readWorkspacePush().then(setPush, () => {}), statusPollMilliseconds);
    return () => window.clearInterval(timer);
  }, [running, starting]);

  const migrate = async () => {
    const confirmed = await confirmAction({
      title: t("Workspace auf den Server übertragen?"),
      description: t("Projekte, Chats, Memory, Einstellungen und Konten werden auf den Server kopiert. Dort vorhandene Daten werden ersetzt (ein Backup bleibt auf dem Server). Dein lokaler Workspace bleibt unverändert. Kanäle wie Telegram oder Postfächer danach nur auf einer Seite aktiv lassen. Claude- und Codex-Anmeldungen musst du auf dem Server neu vornehmen."),
      confirmLabel: t("Übertragen"),
      destructive: false,
    });
    if (!confirmed) return;
    setStarting(true);
    try {
      setPush(await api.pushWorkspaceToServer(serverUrl, serverToken, { includeAgentConfiguration, includeAgentTranscripts }));
    } catch (migrationError) {
      onError(migrationError);
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="grid gap-2">
      <span className="text-sm">{t("Auf Server umziehen")}</span>
      <p className="text-xs text-muted-foreground">{t("Überträgt deinen lokalen Workspace mit einem Klick auf einen Harnold-Server.")}</p>
      <Input placeholder={t("Server-Adresse, z. B. https://harnold.meinserver.de")} value={serverUrl} disabled={running} onChange={(event) => setServerUrl(event.target.value)} />
      <Input type="password" placeholder={t("Zugriffstoken des Servers")} value={serverToken} disabled={running} onChange={(event) => setServerToken(event.target.value)} />
      <AgentTransferToggle
        label={t("Claude- und Codex-Konfiguration")}
        hint={t("CLAUDE.md, Einstellungen, Skills, Agents, Befehle, Plugins und MCP-Server; Codex: config.toml, AGENTS.md, Prompts, Skills. Auf dem Server vorhandene Dateien werden gesichert, Einstellungen zusammengeführt.")}
        checked={includeAgentConfiguration}
        onCheckedChange={setIncludeAgentConfiguration}
      />
      <AgentTransferToggle
        label={t("Chat-Verläufe der Agenten")}
        hint={t("Damit Chats der übertragenen Projekte auf dem Server mit ihrem Kontext weiterlaufen, inklusive Claudes Auto-Memory.")}
        checked={includeAgentTranscripts}
        onCheckedChange={setIncludeAgentTranscripts}
      />
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={!serverUrl.trim() || running} onClick={() => void migrate()}>
          {running && <Loader2 className="size-3.5 animate-spin" />}
          {running ? t("Überträgt …") : t("Zum Server übertragen")}
        </Button>
        {(push?.phase === "packing" || push?.phase === "uploading") && (
          <Button size="sm" variant="ghost" onClick={() => api.cancelWorkspacePush().then(setPush, onError)}>
            {t("Abbrechen")}
          </Button>
        )}
      </div>
      {push && push.phase !== "idle" && <PushProgress push={push} />}
    </div>
  );
}

const formatBytes = (bytes: number) => {
  const gigabytes = bytes >= 1e9;
  return `${(bytes / (gigabytes ? 1e9 : 1e6)).toLocaleString(locale(), { maximumFractionDigits: gigabytes ? 2 : 0 })} ${gigabytes ? "GB" : "MB"}`;
};

function describePush(push: WorkspacePushStatus): string {
  switch (push.phase) {
    case "packing":
      return t("Workspace wird gepackt …");
    case "uploading": {
      const progress = t("{0} von {1} hochgeladen", formatBytes(push.sentBytes), formatBytes(push.totalBytes));
      if (push.reconnecting) return `${progress} · ${t("Verbindung unterbrochen, neuer Versuch …")}`;
      return push.remainingSeconds === null ? progress : `${progress} · ${t("noch etwa {0} Min.", Math.max(1, Math.ceil(push.remainingSeconds / 60)))}`;
    }
    case "unpacking":
      return t("Server entpackt …");
    case "restarting":
      return t("Server startet neu …");
    case "done":
      return t("Übertragen. Verbinde dich jetzt oben unter „Workspace“.");
    case "cancelled":
      return t("Übertragung abgebrochen.");
    default:
      return push.error ?? "";
  }
}

function PushProgress({ push }: { push: WorkspacePushStatus }) {
  const percent = push.totalBytes ? Math.floor((push.sentBytes / push.totalBytes) * 100) : 0;
  return (
    <div className="grid gap-1.5" role="status">
      {push.phase === "uploading" && (
        <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${percent}%` }} />
        </div>
      )}
      <span className={push.phase === "failed" ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>{describePush(push)}</span>
      {push.warning && <span className="text-xs text-destructive">{push.warning}</span>}
      {(push.phase === "packing" || push.phase === "uploading") && <span className="text-xs text-muted-foreground">{t("Lass Harnold bis zum Ende geöffnet.")}</span>}
    </div>
  );
}

function AgentTransferToggle(props: { label: string; hint: string; checked: boolean; onCheckedChange: (checked: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-md py-1">
      <Switch className="mt-0.5" checked={props.checked} onCheckedChange={props.onCheckedChange} />
      <span className="grid gap-0.5">
        <span className="text-[13px]">{props.label}</span>
        <span className="text-xs text-muted-foreground">{props.hint}</span>
      </span>
    </label>
  );
}
