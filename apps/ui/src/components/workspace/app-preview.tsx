import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Loader2, MonitorPlay, RotateCw } from "lucide-react";
import { api, previewOpeningUrl } from "@/api";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { t } from "@/lib/i18n";
import type { DevServer, Project } from "@/types";

/** Preview tickets live 60 s on the Core; the "open externally" link is renewed before that. */
const externalLinkRefreshMs = 45_000;

/** macOS reports /private/tmp for /tmp. */
const normalizedPath = (fsPath: string) => fsPath.replace(/^\/private(?=\/)/, "").replace(/\/$/, "");

export function belongsToProject(devServer: DevServer, project: Project): boolean {
  if (!devServer.workingDirectory) return false;
  const serverDirectory = normalizedPath(devServer.workingDirectory);
  const projectDirectory = normalizedPath(project.path);
  return serverDirectory === projectDirectory || serverDirectory.startsWith(projectDirectory + "/");
}

function serverLabel(devServer: DevServer): string {
  const origin = devServer.container ? t("Container {0}", devServer.container) : (devServer.processName ?? "").split("/").pop();
  return origin ? `:${devServer.port} · ${origin}` : `:${devServer.port}`;
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
export function AppPreview(props: { project: Project; devServers: DevServer[] }) {
  const { project, devServers } = props;
  const projectServers = devServers.filter((devServer) => belongsToProject(devServer, project));
  const otherServers = devServers.filter((devServer) => !belongsToProject(devServer, project));
  const [selectedPort, setSelectedPort] = useState<number | null>(null);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [externalUrl, setExternalUrl] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  const selectedServerRunning = devServers.some((devServer) => devServer.port === selectedPort);
  // First server of the project; another one once the chosen server is gone.
  useEffect(() => {
    if (selectedPort !== null && selectedServerRunning) return;
    const fallbackServer = projectServers[0] ?? (selectedPort === null ? undefined : otherServers[0]);
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

  if (!devServers.length) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-[13px] text-muted-foreground">
        <MonitorPlay className="size-6 opacity-60" />
        <p>{t("Kein Dev-Server läuft.")}</p>
        <p className="max-w-80 text-[12px]">{t("Bitte den Agenten, die App zu starten (z. B. „Starte den Dev-Server“). Sie erscheint hier automatisch.")}</p>
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
                <SelectLabel>{t("Weitere Server")}</SelectLabel>
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
        {externalUrl && (
          <Button variant="ghost" size="icon" className="size-7 text-muted-foreground" asChild>
            <a href={externalUrl} target="_blank" rel="noreferrer" aria-label={t("Extern öffnen")} title={t("Extern öffnen")}>
              <ExternalLink className="size-4" />
            </a>
          </Button>
        )}
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
