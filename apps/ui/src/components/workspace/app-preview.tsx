import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Loader2, MonitorPlay, RotateCw } from "lucide-react";
import { api, previewOpeningUrl } from "@/api";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { t } from "@/lib/i18n";
import type { DevServer, Project, ProjectRoot } from "@/types";
import { cn } from "@/lib/utils";
import { serverBelongsToProject } from "./project-roots";

/** Preview tickets live 60 s on the Core; the "open externally" link is renewed before that. */
const externalLinkRefreshMs = 45_000;

/** ":5173 · node · harnold" – port, program and the folder it runs in. */
function serverLabel(devServer: DevServer): string {
  if (devServer.container) return `:${devServer.port} · ${t("Container {0}", devServer.container)}`;
  const program = (devServer.processName ?? "").trim().split(/\s+/)[0]?.split("/").pop();
  const folderName = devServer.workingDirectory && devServer.workingDirectory !== "/" ? devServer.workingDirectory.split("/").filter(Boolean).pop() : undefined;
  return [`:${devServer.port}`, program, folderName].filter(Boolean).join(" · ");
}

/** Running servers, polled while the workspace is open (faster while the App view is shown). */
export function useDevServers(pollIntervalMs: number): DevServer[] {
  const [devServers, setDevServers] = useState<DevServer[]>([]);
  useEffect(() => {
    let cancelled = false;
    const refresh = () =>
      api
        .listDevServers()
        .then((servers) => !cancelled && setDevServers(servers))
        .catch(() => undefined);
    refresh();
    const pollTimer = window.setInterval(refresh, pollIntervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(pollTimer);
    };
  }, [pollIntervalMs]);
  return devServers;
}

/** Workspace → App: the running dev server in a frame, through Harnold's preview proxy on a server. */
export function AppPreview(props: { project: Project; roots: ProjectRoot[]; devServers: DevServer[] }) {
  const { project, roots, devServers } = props;
  const [showAllPorts, setShowAllPorts] = useState(false);
  const [manualPort, setManualPort] = useState("");
  const projectServers = devServers.filter((devServer) => serverBelongsToProject(devServer, project, roots));
  // Other dev servers (node, python, containers …); background apps that merely listen only on request.
  const otherApps = devServers.filter((devServer) => !serverBelongsToProject(devServer, project, roots) && devServer.likelyApp);
  const backgroundPorts = devServers.filter((devServer) => !serverBelongsToProject(devServer, project, roots) && !devServer.likelyApp);
  const otherServers = showAllPorts ? [...otherApps, ...backgroundPorts].sort((first, second) => first.port - second.port) : otherApps;
  const [selectedPort, setSelectedPort] = useState<number | null>(null);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [externalUrl, setExternalUrl] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  const selectedServerRunning = devServers.some((devServer) => devServer.port === selectedPort);
  // First server of the project; another one once the chosen server is gone.
  useEffect(() => {
    if (selectedPort !== null && selectedServerRunning) return;
    const fallbackServer = projectServers[0] ?? (selectedPort === null ? undefined : otherApps[0]);
    if (fallbackServer) setSelectedPort(fallbackServer.port);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devServers]);

  const openInFrame = useCallback(async (port: number) => {
    setOpening(true);
    setOpenError(null);
    try {
      const preview = await api.openDevServer(port);
      if (preview.mode === "unavailable") {
        setFrameUrl(null);
        setOpenError(preview.reason);
      } else {
        setFrameUrl(previewOpeningUrl(preview));
      }
    } catch (openFailure) {
      setOpenError(openFailure instanceof Error ? openFailure.message : String(openFailure));
    } finally {
      setOpening(false);
    }
  }, []);

  useEffect(() => {
    if (selectedPort !== null) void openInFrame(selectedPort);
  }, [selectedPort, openInFrame]);

  // A ticket for the external link, ready for a plain link (popups after an await get blocked).
  useEffect(() => {
    if (selectedPort === null || !selectedServerRunning) return;
    let cancelled = false;
    const renewExternalLink = () =>
      api
        .openDevServer(selectedPort)
        .then((preview) => !cancelled && setExternalUrl(previewOpeningUrl(preview)))
        .catch(() => undefined);
    renewExternalLink();
    const renewTimer = window.setInterval(renewExternalLink, externalLinkRefreshMs);
    return () => {
      cancelled = true;
      window.clearInterval(renewTimer);
    };
  }, [selectedPort, selectedServerRunning]);

  const openManualPort = () => {
    const port = Number(manualPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return;
    setSelectedPort(port);
    setManualPort("");
    if (port === selectedPort) void openInFrame(port);
  };

  const allPortsToggle = backgroundPorts.length > 0 && (
    <button type="button" className={cn("text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline", showAllPorts && "text-foreground")} onClick={() => setShowAllPorts((shown) => !shown)}>
      {showAllPorts ? t("Nur Dev-Server") : t("Alle Ports ({0})", String(backgroundPorts.length))}
    </button>
  );

  if (!projectServers.length && !otherServers.length && selectedPort === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-[13px] text-muted-foreground">
        <MonitorPlay className="size-6 opacity-60" />
        <p>{t("Kein Dev-Server läuft.")}</p>
        <p className="max-w-80 text-[12px]">{t("Bitte den Agenten, die App zu starten (z. B. „Starte den Dev-Server“). Sie erscheint hier automatisch.")}</p>
        {allPortsToggle}
      </div>
    );
  }

  return (
    <div className="absolute inset-0 flex flex-col gap-2 p-3">
      <div className="flex items-center gap-1.5">
        <Select value={selectedPort === null ? undefined : String(selectedPort)} onValueChange={(portValue) => setSelectedPort(Number(portValue))}>
          <SelectTrigger className="h-7 w-64 text-[12px]" aria-label={t("Server")}>
            <SelectValue placeholder={t("Server wählen")} />
          </SelectTrigger>
          <SelectContent>
            {projectServers.length > 0 && (
              <SelectGroup>
                <SelectLabel>{t("Dieses Projekt")}</SelectLabel>
                {projectServers.map((devServer) => (
                  <SelectItem key={devServer.port} value={String(devServer.port)}>
                    {serverLabel(devServer)}
                  </SelectItem>
                ))}
              </SelectGroup>
            )}
            {otherServers.length > 0 && (
              <SelectGroup>
                <SelectLabel>{showAllPorts ? t("Weitere Ports") : t("Weitere Dev-Server")}</SelectLabel>
                {otherServers.map((devServer) => (
                  <SelectItem key={devServer.port} value={String(devServer.port)}>
                    {serverLabel(devServer)}
                  </SelectItem>
                ))}
              </SelectGroup>
            )}
          </SelectContent>
        </Select>
        <Button variant="ghost" size="icon" className="size-7 text-muted-foreground" aria-label={t("Neu laden")} title={t("Neu laden")} disabled={selectedPort === null} onClick={() => selectedPort !== null && void openInFrame(selectedPort)}>
          {opening ? <Loader2 className="size-4 animate-spin" /> : <RotateCw className="size-4" />}
        </Button>
        <input
          className="h-7 w-20 rounded-md border bg-background px-2 text-[12px] tabular-nums outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
          inputMode="numeric"
          placeholder={t("Port")}
          aria-label={t("Port öffnen")}
          title={t("Port öffnen")}
          value={manualPort}
          onChange={(changeEvent) => setManualPort(changeEvent.target.value.replace(/\D/g, "").slice(0, 5))}
          onKeyDown={(keyboardEvent) => keyboardEvent.key === "Enter" && openManualPort()}
        />
        {externalUrl && (
          <Button variant="ghost" size="icon" className="size-7 text-muted-foreground" asChild>
            <a href={externalUrl} target="_blank" rel="noreferrer" aria-label={t("Extern öffnen")} title={t("Extern öffnen")}>
              <ExternalLink className="size-4" />
            </a>
          </Button>
        )}
        <span className="ml-auto">{allPortsToggle}</span>
      </div>
      {openError ? (
        <div className="flex flex-1 items-center justify-center rounded-lg border bg-background p-6 text-center text-[13px] text-muted-foreground">{openError}</div>
      ) : frameUrl ? (
        <iframe key={frameUrl} className="min-h-0 flex-1 rounded-lg border bg-white shadow-xs" title={t("App")} src={frameUrl} allow="clipboard-read; clipboard-write; fullscreen" />
      ) : (
        <div className="flex-1 rounded-lg border bg-background" />
      )}
    </div>
  );
}
