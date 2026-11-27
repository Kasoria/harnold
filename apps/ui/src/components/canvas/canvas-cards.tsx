import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AppWindow, File, FileText, Folder, Loader2, RotateCw } from "lucide-react";
import { api, previewOpeningUrl } from "@/api";
import type { CanvasElement, DevServer, DirectoryEntry } from "@/types";
import { allowEmbeddedOrigin } from "@/lib/embedded-origins";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

/** Height of the card header in world units (file, folder and app cards). */
export const cardHeaderHeight = 28;
const maximumPreviewLines = 160;
const maximumPreviewCharacters = 12_000;
const maximumFolderEntries = 14;

export const appViewports = {
  desktop: { viewportWidth: 1280, viewportHeight: 800, width: 480 },
  mobile: { viewportWidth: 390, viewportHeight: 844, width: 220 },
} as const;

export const cardDefaults = {
  file: { width: 360, height: 280 },
  folder: { width: 260, height: 300 },
  app: { width: appViewports.desktop.width, height: Math.round((appViewports.desktop.width * 800) / 1280) + cardHeaderHeight },
};

export type ActivityState = "editing" | "done" | null;

function CardHeader(props: { icon: React.ReactNode; title: string; subtitle?: string; trailing?: React.ReactNode }) {
  return (
    <div className="flex shrink-0 items-center gap-1.5 border-b bg-muted/60 px-2" style={{ height: cardHeaderHeight }}>
      {props.icon}
      <span className="truncate text-[12px] font-medium">{props.title}</span>
      {props.subtitle && <span className="min-w-0 truncate text-[11px] text-muted-foreground">{props.subtitle}</span>}
      <span className="ml-auto flex shrink-0 items-center gap-1">{props.trailing}</span>
    </div>
  );
}

/** Ring that shows the agent working on the card (pulsing) or just having finished it. */
export function ActivityRing({ state, inverseZoom }: { state: ActivityState; inverseZoom: number }) {
  if (!state) return null;
  return (
    <div
      className={cn("pointer-events-none absolute -inset-0.5 rounded-lg", state === "editing" ? "animate-pulse" : "transition-opacity duration-1000")}
      style={{ boxShadow: `0 0 0 ${2.5 * inverseZoom}px rgb(16 185 129)` }}
    />
  );
}

function parentLabel(filePath: string, rootLabel: string | undefined): string {
  const parent = filePath.split("/").slice(0, -1).join("/");
  return [rootLabel, parent].filter(Boolean).join(" / ");
}

const looksBinary = (content: string) => content.includes("\u0000") || (content.match(/�/g)?.length ?? 0) > 8;

export function FileCard(props: { element: CanvasElement; projectId: string; rootLabel?: string; reloadKey: number }) {
  const { element } = props;
  const [content, setContent] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const fileName = element.path?.split("/").pop() ?? "";
  const isMarkdown = /\.(md|mdx|markdown)$/i.test(fileName);

  useEffect(() => {
    if (!element.path) return;
    let cancelled = false;
    api
      .readFile(props.projectId, element.path, element.root)
      .then(({ content: fileContent }) => {
        if (cancelled) return;
        setContent(fileContent);
        setLoadError(null);
      })
      .catch((readError) => !cancelled && setLoadError(readError instanceof Error ? readError.message : String(readError)));
    return () => {
      cancelled = true;
    };
  }, [props.projectId, element.path, element.root, props.reloadKey]);

  const previewText = content === null ? "" : content.slice(0, maximumPreviewCharacters).split("\n").slice(0, maximumPreviewLines).join("\n");
  const lineCount = content === null ? 0 : content.split("\n").length;

  return (
    <div className="flex size-full flex-col overflow-hidden rounded-md border bg-background shadow-xs">
      <CardHeader
        icon={isMarkdown ? <FileText className="size-3.5 shrink-0 text-muted-foreground" /> : <File className="size-3.5 shrink-0 text-muted-foreground" />}
        title={element.title || fileName}
        subtitle={parentLabel(element.path ?? "", props.rootLabel)}
        trailing={content !== null && !isMarkdown && <span className="text-[10.5px] text-muted-foreground tabular-nums">{t("{0} Zeilen", String(lineCount))}</span>}
      />
      <div className="min-h-0 flex-1 overflow-hidden">
        {loadError ? (
          <p className="p-3 text-[12px] text-muted-foreground">{loadError}</p>
        ) : content === null ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : looksBinary(content) ? (
          <p className="p-3 text-[12px] text-muted-foreground">{t("Keine Vorschau für diese Datei.")}</p>
        ) : isMarkdown ? (
          <div className="chat-markdown px-3 py-2 text-[12px] leading-snug">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{previewText}</ReactMarkdown>
          </div>
        ) : (
          <pre className="flex px-0 py-1.5 font-mono text-[10.5px] leading-[1.45]">
            <code className="shrink-0 pr-2 pl-2 text-right text-muted-foreground/60 select-none">
              {previewText.split("\n").map((_line, lineIndex) => `${lineIndex + 1}\n`)}
            </code>
            <code className="min-w-0 whitespace-pre text-foreground/90">{previewText}</code>
          </pre>
        )}
      </div>
    </div>
  );
}

export function FolderCard(props: { element: CanvasElement; projectId: string; rootLabel?: string; reloadKey: number; activePaths: Set<string>; onOpenEntry: (filePath: string) => void }) {
  const { element } = props;
  const [entries, setEntries] = useState<DirectoryEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const folderName = element.path?.split("/").pop() || props.rootLabel || "/";

  useEffect(() => {
    if (element.path === undefined) return;
    let cancelled = false;
    // Without root the folder is in the project folder: the roots API needs its absolute path, the Core resolves "" to it.
    api
      .readDirectory(props.projectId, element.root ?? "", element.path)
      .then((loadedEntries) => {
        if (cancelled) return;
        setEntries(loadedEntries);
        setLoadError(null);
      })
      .catch((readError) => !cancelled && setLoadError(readError instanceof Error ? readError.message : String(readError)));
    return () => {
      cancelled = true;
    };
  }, [props.projectId, element.path, element.root, props.reloadKey]);

  const shownEntries = entries?.slice(0, maximumFolderEntries) ?? [];
  const hiddenCount = (entries?.length ?? 0) - shownEntries.length;

  return (
    <div className="flex size-full flex-col overflow-hidden rounded-md border bg-background shadow-xs">
      <CardHeader
        icon={<Folder className="size-3.5 shrink-0 text-muted-foreground" />}
        title={element.title || folderName}
        subtitle={parentLabel(element.path ?? "", props.rootLabel)}
        trailing={entries && <span className="text-[10.5px] text-muted-foreground tabular-nums">{entries.length}</span>}
      />
      <div className="min-h-0 flex-1 overflow-hidden py-1">
        {loadError ? (
          <p className="p-3 text-[12px] text-muted-foreground">{loadError}</p>
        ) : !entries ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <ul>
            {shownEntries.map((entry) => {
              const isActive = [...props.activePaths].some((activePath) => activePath === entry.path || activePath.startsWith(entry.path + "/"));
              return (
                <li
                  key={entry.path}
                  className={cn("flex h-6 items-center gap-1.5 px-2.5 text-[12px]", entry.type === "file" && "hover:bg-foreground/5", entry.heavy && "text-muted-foreground")}
                  onDoubleClick={(clickEvent) => {
                    if (entry.type !== "file") return;
                    clickEvent.stopPropagation();
                    props.onOpenEntry(entry.path);
                  }}
                >
                  {entry.type === "directory" ? <Folder className="size-3.5 shrink-0 text-muted-foreground" /> : <File className="size-3.5 shrink-0 text-muted-foreground" />}
                  <span className="truncate">{entry.name}</span>
                  {isActive && <span className="ml-auto size-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500" />}
                </li>
              );
            })}
            {hiddenCount > 0 && <li className="px-2.5 pt-0.5 text-[11px] text-muted-foreground">{t("+ {0} weitere", String(hiddenCount))}</li>}
          </ul>
        )}
      </div>
    </div>
  );
}

/** The running app, live (hot reload included). Only interactive after a double click, otherwise it would swallow canvas gestures. */
export function AppTile(props: { element: CanvasElement; devServers: DevServer[]; interactive: boolean; reloadKey: number }) {
  const { element, devServers } = props;
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [manualReloadKey, setManualReloadKey] = useState(0);
  const preferredServer = devServers.find((devServer) => devServer.port === element.port);
  const shownServer = preferredServer ?? devServers[0];
  const shownPort = shownServer?.port ?? null;
  const route = element.route || "/";

  useEffect(() => {
    if (shownPort === null) {
      setFrameUrl(null);
      return;
    }
    let cancelled = false;
    setOpenError(null);
    api
      .openDevServer(shownPort, route)
      .then(async (preview) => {
        if (cancelled) return;
        if (preview.mode === "unavailable") {
          setFrameUrl(null);
          setOpenError(preview.reason);
          return;
        }
        const openingUrl = previewOpeningUrl(preview);
        if (openingUrl) await allowEmbeddedOrigin(openingUrl);
        if (!cancelled) setFrameUrl(openingUrl);
      })
      .catch((openFailure) => !cancelled && setOpenError(openFailure instanceof Error ? openFailure.message : String(openFailure)));
    return () => {
      cancelled = true;
    };
  }, [shownPort, route, manualReloadKey, props.reloadKey]);

  const viewportWidth = element.viewportWidth ?? appViewports.desktop.viewportWidth;
  const scale = element.width / viewportWidth;
  const frameHeight = Math.max(1, (element.height - cardHeaderHeight) / scale);

  return (
    <div className={cn("flex size-full flex-col overflow-hidden rounded-md border bg-background shadow-xs", props.interactive && "ring-2 ring-sky-500")}>
      <CardHeader
        icon={<AppWindow className="size-3.5 shrink-0 text-muted-foreground" />}
        title={element.title || t("App")}
        subtitle={`${route}${shownPort ? ` · :${shownPort}` : ""}`}
        trailing={
          <>
            <span className={cn("size-1.5 rounded-full", shownPort ? "bg-emerald-500" : "bg-muted-foreground/40")} />
            <button
              type="button"
              aria-label={t("Neu laden")}
              title={t("Neu laden")}
              className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
              onPointerDown={(pointerEvent) => pointerEvent.stopPropagation()}
              onClick={() => setManualReloadKey((previous) => previous + 1)}
            >
              <RotateCw className="size-3" />
            </button>
          </>
        }
      />
      <div className="relative min-h-0 flex-1 overflow-hidden bg-white">
        {openError ? (
          <p className="p-3 text-[12px] text-muted-foreground">{openError}</p>
        ) : shownPort === null ? (
          <p className="flex h-full items-center justify-center p-3 text-center text-[12px] text-muted-foreground">{t("Kein Dev-Server läuft. Bitte den Agenten, die App zu starten.")}</p>
        ) : frameUrl ? (
          <iframe
            key={frameUrl}
            title={t("App")}
            src={frameUrl}
            allow="clipboard-read; clipboard-write; fullscreen"
            tabIndex={props.interactive ? 0 : -1}
            className={cn("origin-top-left border-0", !props.interactive && "pointer-events-none")}
            style={{ width: viewportWidth, height: frameHeight, transform: `scale(${scale})` }}
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        )}
      </div>
    </div>
  );
}
