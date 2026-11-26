import { useEffect, useRef, useState } from "react";
import { ChevronRight, Loader2 } from "lucide-react";
import { api, coreBaseUrl } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { confirmAction } from "@/components/confirm-dialog";
import { locale, t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { cancelWorkspaceImport, isImportRunning, startWorkspaceImport, useWorkspaceImport } from "@/lib/workspace-import";
import type { TransferFolders, TransferJob, TransferSelection } from "@/types";

type TransferAction = "push" | "export" | "import";

const runningPhases: TransferJob["phase"][] = ["packing", "uploading", "unpacking", "restarting"];
const jobPollMilliseconds = 1000;

const formatBytes = (bytes: number) => {
  const unit = bytes >= 1e9 ? { size: 1e9, name: "GB", digits: 2 } : bytes >= 1e6 ? { size: 1e6, name: "MB", digits: 0 } : { size: 1e3, name: "KB", digits: 0 };
  // Something small is not nothing.
  const amount = unit.name === "KB" ? Math.ceil(bytes / unit.size) : bytes / unit.size;
  return `${amount.toLocaleString(locale(), { maximumFractionDigits: unit.digits })} ${unit.name}`;
};

/** Settings → General: move to a server, export to a file, import such a file. */
export function WorkspaceTransferSetting({ canPush, onError }: { canPush: boolean; onError: (error: unknown) => void }) {
  // Nothing is chosen at first: calculating folder sizes should not start just by opening the settings.
  const [action, setAction] = useState<TransferAction | "">("");
  const [job, setJob] = useState<TransferJob | null>(null);
  const [starting, setStarting] = useState(false);
  const importState = useWorkspaceImport();
  const jobRunning = starting || (!!job && runningPhases.includes(job.phase));

  // Jobs keep running when this screen is closed: pick up their state again.
  useEffect(() => {
    api.readTransferJob().then((currentJob) => {
      setJob(currentJob);
      // A finished job's result shows once its action is chosen again.
      if (runningPhases.includes(currentJob.phase)) setAction(currentJob.kind);
    }, () => {});
    if (isImportRunning(importState.phase)) setAction("import");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!jobRunning || starting) return;
    const timer = window.setInterval(() => api.readTransferJob().then(setJob, () => {}), jobPollMilliseconds);
    return () => window.clearInterval(timer);
  }, [jobRunning, starting]);

  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between gap-4">
        <span className="text-sm">{t("Umzug & Backup")}</span>
        <Select value={action} onValueChange={(value) => setAction(value as TransferAction)}>
          <SelectTrigger size="sm" className="w-52">
            <SelectValue placeholder={t("Auswählen …")} />
          </SelectTrigger>
          <SelectContent>
            {canPush && <SelectItem value="push">{t("Auf Server übertragen")}</SelectItem>}
            <SelectItem value="export">{t("Als Datei exportieren")}</SelectItem>
            <SelectItem value="import">{t("Datei importieren")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {action === "import" && <ImportPanel disabled={jobRunning} />}
      {(action === "push" || action === "export") && (
        <SendPanel key={action} action={action} job={job?.kind === action ? job : null} running={jobRunning || isImportRunning(importState.phase)} setStarting={setStarting} setJob={setJob} onError={onError} />
      )}
    </div>
  );
}

type SendPanelProps = {
  action: "push" | "export";
  job: TransferJob | null;
  running: boolean;
  setStarting: (starting: boolean) => void;
  setJob: (job: TransferJob) => void;
  onError: (error: unknown) => void;
};

function SendPanel({ action, job, running, setStarting, setJob, onError }: SendPanelProps) {
  const [serverUrl, setServerUrl] = useState("");
  const [serverToken, setServerToken] = useState("");
  const [scope, setScope] = useState<TransferSelection["scope"]>("workspace");
  const [excludedFolders, setExcludedFolders] = useState<string[]>([]);
  const [includeAgentConfiguration, setIncludeAgentConfiguration] = useState(true);
  const [includeAgentTranscripts, setIncludeAgentTranscripts] = useState(true);
  const [contents, setContents] = useState<TransferFolders | null>(null);

  useEffect(() => {
    let active = true;
    api.listTransferFolders().then((loaded) => active && setContents(loaded), (loadError) => active && onError(loadError));
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selection: TransferSelection = { scope, excludedFolders, includeAgentConfiguration, includeAgentTranscripts };
  const nothingSelected = scope === "agents" && !includeAgentConfiguration && !includeAgentTranscripts;

  const start = async () => {
    if (action === "push") {
      const confirmed = await confirmAction({
        title: scope === "workspace" ? t("Workspace auf den Server übertragen?") : t("Agent-Konfiguration auf den Server übertragen?"),
        description:
          scope === "workspace"
            ? t("Projekte, Chats, Memory, Einstellungen und Konten werden auf den Server kopiert. Dort vorhandene Daten werden ersetzt (ein Backup bleibt auf dem Server). Dein lokaler Workspace bleibt unverändert. Kanäle wie Telegram oder Postfächer danach nur auf einer Seite aktiv lassen. Claude- und Codex-Anmeldungen musst du auf dem Server neu vornehmen.")
            : t("Der Workspace auf dem Server bleibt. Die Auswahl wird dort ergänzt, ersetzte Dateien werden gesichert. Der Server startet dabei neu."),
        confirmLabel: t("Übertragen"),
        destructive: false,
      });
      if (!confirmed) return;
    }
    setStarting(true);
    try {
      setJob(action === "push" ? await api.startPush(serverUrl, serverToken, selection) : await api.startExport(selection));
    } catch (startError) {
      onError(startError);
    } finally {
      setStarting(false);
    }
  };

  const cancellable = job?.phase === "packing" || job?.phase === "uploading";

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-4">
        <span className="text-[13px]">{t("Umfang")}</span>
        <Select value={scope} disabled={running} onValueChange={(value) => setScope(value as TransferSelection["scope"])}>
          <SelectTrigger size="sm" className="w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="workspace">{t("Ganzer Workspace")}</SelectItem>
            <SelectItem value="agents">{t("Nur Agent-Konfiguration")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <AgentTransferToggle
        label={t("Claude- und Codex-Konfiguration")}
        size={contents?.agentConfigurationBytes}
        hint={t("CLAUDE.md, Einstellungen, Skills, Agents, Befehle, Plugins und MCP-Server; Codex: config.toml, AGENTS.md, Prompts, Skills. Am Ziel vorhandene Dateien werden gesichert, Einstellungen zusammengeführt.")}
        checked={includeAgentConfiguration}
        disabled={running}
        onCheckedChange={setIncludeAgentConfiguration}
      />
      <AgentTransferToggle
        label={t("Chat-Verläufe der Agenten")}
        size={contents?.agentTranscriptBytes}
        hint={t("Damit Chats der Projekte am Ziel mit ihrem Kontext weiterlaufen, inklusive Claudes Auto-Memory.")}
        checked={includeAgentTranscripts}
        disabled={running}
        onCheckedChange={setIncludeAgentTranscripts}
      />
      {scope === "workspace" && <FolderSelection contents={contents} excludedFolders={excludedFolders} disabled={running} onChange={setExcludedFolders} />}
      {action === "push" && (
        <>
          <Input placeholder={t("Server-Adresse, z. B. https://harnold.meinserver.de")} value={serverUrl} disabled={running} onChange={(event) => setServerUrl(event.target.value)} />
          <Input type="password" placeholder={t("Zugriffstoken des Servers")} value={serverToken} disabled={running} onChange={(event) => setServerToken(event.target.value)} />
        </>
      )}
      {action === "export" && <p className="text-xs text-muted-foreground">{t("Die Datei enthält Konten und Schlüssel. Bewahre sie sicher auf.")}</p>}
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={running || nothingSelected || (action === "push" && !serverUrl.trim())} onClick={() => void start()}>
          {job && runningPhases.includes(job.phase) && <Loader2 className="size-3.5 animate-spin" />}
          {action === "push" ? t("Zum Server übertragen") : t("Exportieren")}
        </Button>
        {cancellable && (
          <Button size="sm" variant="ghost" onClick={() => api.cancelTransferJob().then(setJob, onError)}>
            {t("Abbrechen")}
          </Button>
        )}
      </div>
      {job && job.phase !== "idle" && <JobProgress job={job} onError={onError} />}
    </div>
  );
}

function FolderSelection({ contents, excludedFolders, disabled, onChange }: { contents: TransferFolders | null; excludedFolders: string[]; disabled: boolean; onChange: (folders: string[]) => void }) {
  const [open, setOpen] = useState(false);
  if (!contents) {
    return (
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        {t("Größen werden berechnet …")}
      </span>
    );
  }
  if (!contents.folders.length) return null;
  const included = contents.folders.filter((folder) => !excludedFolders.includes(folder.path));
  const includedBytes = included.reduce((sum, folder) => sum + folder.sizeBytes, 0);
  return (
    <div className="grid gap-1">
      <button type="button" aria-expanded={open} className="flex items-center gap-2 rounded-md py-1 text-left text-[13px] outline-none focus-visible:ring-1 focus-visible:ring-ring/50" onClick={() => setOpen(!open)}>
        <ChevronRight className={cn("size-3.5 text-muted-foreground transition-transform duration-150", open && "rotate-90")} />
        {t("Ordner")}
        <span className="ml-auto text-xs text-muted-foreground">{t("{0} von {1} · {2}", included.length, contents.folders.length, formatBytes(includedBytes))}</span>
      </button>
      {open && (
        <div className="grid animate-in gap-0.5 fade-in duration-150">
          {contents.folders.map((folder) => (
            <label key={folder.path} title={folder.path} className="flex cursor-pointer items-center gap-2.5 rounded-md px-1.5 py-1 hover:bg-foreground/[0.04]">
              <input
                type="checkbox"
                className="size-3.5 shrink-0"
                disabled={disabled}
                checked={!excludedFolders.includes(folder.path)}
                onChange={(event) => onChange(event.target.checked ? excludedFolders.filter((excluded) => excluded !== folder.path) : [...excludedFolders, folder.path])}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px]">{folder.name}</span>
                <span className="block truncate text-xs text-muted-foreground">{folder.path}</span>
              </span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatBytes(folder.sizeBytes)}</span>
            </label>
          ))}
          <p className="px-1.5 text-xs text-muted-foreground">{t("Abgewählte Ordner kommen leer an, ihre Chats bleiben.")}</p>
        </div>
      )}
    </div>
  );
}

const uploadText = (progress: { sentBytes: number; totalBytes: number; remainingSeconds: number | null; reconnecting: boolean }) => {
  const sent = t("{0} von {1} hochgeladen", formatBytes(progress.sentBytes), formatBytes(progress.totalBytes));
  if (progress.reconnecting) return `${sent} · ${t("Verbindung unterbrochen, neuer Versuch …")}`;
  return progress.remainingSeconds === null ? sent : `${sent} · ${t("noch etwa {0} Min.", Math.max(1, Math.ceil(progress.remainingSeconds / 60)))}`;
};

function describeJob(job: TransferJob): string {
  switch (job.phase) {
    case "packing":
      return t("Wird gepackt …");
    case "uploading":
      return uploadText(job);
    case "unpacking":
      return t("Server entpackt …");
    case "restarting":
      return t("Server startet neu …");
    case "done":
      return job.kind === "push" ? t("Übertragen.") : t("Exportiert: {0} ({1})", job.filePath?.split(/[\\/]/).pop(), formatBytes(job.totalBytes));
    case "cancelled":
      return t("Abgebrochen.");
    default:
      return job.error ?? "";
  }
}

function JobProgress({ job, onError }: { job: TransferJob; onError: (error: unknown) => void }) {
  // The desktop app's own Core saved the file on this computer; otherwise the browser fetches it.
  const savedHere = !coreBaseUrl && "__TAURI_INTERNALS__" in window;
  return (
    <div className="grid gap-1.5" role="status">
      {job.phase === "uploading" && <ProgressBar sentBytes={job.sentBytes} totalBytes={job.totalBytes} />}
      <span className={job.phase === "failed" ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>{describeJob(job)}</span>
      {job.warning && <span className="text-xs text-destructive">{job.warning}</span>}
      {(job.phase === "packing" || job.phase === "uploading") && <span className="text-xs text-muted-foreground">{t("Lass Harnold bis zum Ende geöffnet.")}</span>}
      {job.kind === "export" && job.phase === "done" && (
        <div>
          {savedHere ? (
            <Button size="sm" variant="outline" onClick={() => void api.revealExport().catch(onError)}>
              {t("Im Finder zeigen")}
            </Button>
          ) : (
            <Button size="sm" variant="outline" asChild>
              <a href={api.exportFileUrl()} download>
                {t("Herunterladen")}
              </a>
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function ImportPanel({ disabled }: { disabled: boolean }) {
  const importState = useWorkspaceImport();
  const fileInput = useRef<HTMLInputElement>(null);
  const running = isImportRunning(importState.phase);

  const chooseFile = async (file: File) => {
    const confirmed = await confirmAction({
      title: t("{0} importieren?", file.name),
      description: t("Enthält die Datei einen Workspace, ersetzt er die Daten hier (ein Backup bleibt). Eine reine Agent-Konfiguration wird ergänzt. Laufende Chats werden unterbrochen."),
      confirmLabel: t("Importieren"),
      destructive: true,
    });
    if (confirmed) await startWorkspaceImport(file);
  };

  const description = () => {
    switch (importState.phase) {
      case "uploading":
        return uploadText(importState);
      case "unpacking":
        return t("Wird entpackt …");
      case "restarting":
        return t("Server startet neu …");
      case "done":
        return t("Importiert.");
      case "restartRequired":
        return t("Beende Harnold vollständig (⌘Q) und öffne es neu, um den Import abzuschließen.");
      case "cancelled":
        return t("Abgebrochen.");
      default:
        return importState.error ?? "";
    }
  };

  return (
    <div className="grid gap-2">
      <input
        ref={fileInput}
        type="file"
        accept=".tgz,.gz,application/gzip"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          // The same file may be chosen again later.
          event.target.value = "";
          if (file) void chooseFile(file);
        }}
      />
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={disabled || running} onClick={() => fileInput.current?.click()}>
          {running && <Loader2 className="size-3.5 animate-spin" />}
          {t("Datei wählen …")}
        </Button>
        {importState.phase === "uploading" && (
          <Button size="sm" variant="ghost" onClick={cancelWorkspaceImport}>
            {t("Abbrechen")}
          </Button>
        )}
      </div>
      {importState.phase !== "idle" && (
        <div className="grid gap-1.5" role="status">
          {importState.phase === "uploading" && <ProgressBar sentBytes={importState.sentBytes} totalBytes={importState.totalBytes} />}
          <span className={importState.phase === "failed" ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>{description()}</span>
          {importState.warning && <span className="text-xs text-destructive">{importState.warning}</span>}
          {importState.phase === "uploading" && <span className="text-xs text-muted-foreground">{t("Lass dieses Fenster bis zum Ende geöffnet.")}</span>}
          {importState.phase === "done" && (
            <div>
              <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
                {t("Neu laden")}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ProgressBar({ sentBytes, totalBytes }: { sentBytes: number; totalBytes: number }) {
  const percent = totalBytes ? Math.floor((sentBytes / totalBytes) * 100) : 0;
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${percent}%` }} />
    </div>
  );
}

function AgentTransferToggle(props: { label: string; hint: string; size?: number; checked: boolean; disabled: boolean; onCheckedChange: (checked: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-md py-1">
      <Switch className="mt-0.5" checked={props.checked} disabled={props.disabled} onCheckedChange={props.onCheckedChange} />
      <span className="grid flex-1 gap-0.5">
        <span className="flex justify-between gap-3 text-[13px]">
          {props.label}
          {props.size !== undefined && <span className="text-xs tabular-nums text-muted-foreground">{formatBytes(props.size)}</span>}
        </span>
        <span className="text-xs text-muted-foreground">{props.hint}</span>
      </span>
    </label>
  );
}
