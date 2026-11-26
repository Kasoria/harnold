import { lazy, Suspense, useEffect, useState } from "react";
import { ChevronRight, ExternalLink, Loader2, PanelLeft, RotateCw, Save, SquareTerminal, Wand2, X } from "lucide-react";
import { api } from "@/api";
import type { Project } from "@/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SegmentedControl } from "@/components/segmented-control";
import { ProjectFiles, type FileSelection } from "./file-tree";
import { AppPreview, useDevServers } from "./app-preview";
import { preferredCodeRoot, serverBelongsToProject, useProjectRoots } from "./project-roots";
import { GitView } from "./git-view";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ProjectCanvas } from "@/components/canvas/project-canvas";
import { t } from "@/lib/i18n";
import { toast } from "@/lib/toast";

/** Monaco is large; it arrives with the first file the user opens in the code view. */
const CodeEditor = lazy(() => import("./code-editor"));
/** xterm.js only loads once a terminal is opened. */
const TerminalPanel = lazy(() => import("./terminal-panel").then((terminalModule) => ({ default: terminalModule.TerminalPanel })));

type WorkspaceView = "canvas" | "preview" | "code" | "app" | "git";

type WorkspacePaneProps = {
  project: Project;
  resolvedTheme: "light" | "dark";
  fileChangeCounter: number;
  lastChangedPaths: string[];
  onReferenceFile: (filePath: string) => void;
  onInsertIntoComposer: (text: string) => void;
  onImplementDesign: (filePath: string) => void;
  onClose: () => void;
  onError: (unknownError: unknown) => void;
};

const previewableExtensions = /\.(html?|svg|png|jpe?g|webp|gif)$/i;

const languageByExtension: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", json: "json",
  mjs: "javascript", cjs: "javascript", mts: "typescript", cts: "typescript", scss: "scss", less: "less",
  css: "css", html: "html", md: "markdown", py: "python", yml: "yaml", yaml: "yaml", sh: "shell", swift: "swift",
  rs: "rust", go: "go", rb: "ruby", php: "php", java: "java", kt: "kotlin", sql: "sql", xml: "xml", toml: "ini", ini: "ini",
  c: "c", h: "c", cpp: "cpp", cs: "csharp", dockerfile: "dockerfile", vue: "html", svelte: "html",
};

function IconAction(props: { label: string; onClick?: () => void; href?: string; children: React.ReactNode }) {
  const button = (
    <Button variant="ghost" size="icon" className="size-7 text-muted-foreground" onClick={props.onClick} asChild={Boolean(props.href)} aria-label={props.label}>
      {props.href ? (
        <a href={props.href} target="_blank" rel="noreferrer">
          {props.children}
        </a>
      ) : (
        props.children
      )}
    </Button>
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{props.label}</TooltipContent>
    </Tooltip>
  );
}

export function WorkspacePane(props: WorkspacePaneProps) {
  const [filePanelOpen, setFilePanelOpen] = useState(false);
  const [selection, setSelection] = useState<FileSelection | null>(null);
  const [fileTreeReloadKey, setFileTreeReloadKey] = useState(0);
  const [activeView, setActiveView] = useState<WorkspaceView>("canvas");
  const [editorContent, setEditorContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [savingFile, setSavingFile] = useState(false);
  const [previewReloadKey, setPreviewReloadKey] = useState(0);

  const { project, onError } = props;
  const selectedPath = selection?.path ?? null;
  // Files outside the project folder are code, not design files: no HTML preview, no "implement design".
  const selectionInProjectFolder = !selection || selection.root === project.path;
  // The project's folders: the code often lives in an attached folder, not in the project folder.
  const roots = useProjectRoots(project, `${props.fileChangeCounter}-${activeView}-${filePanelOpen}`);
  const codeRoot = preferredCodeRoot(roots, project);
  const [chosenGitRoot, setChosenGitRoot] = useState<string | null>(null);
  const gitRoot = chosenGitRoot && roots.some((root) => root.path === chosenGitRoot) ? chosenGitRoot : codeRoot;
  const devServers = useDevServers(activeView === "app" ? 4000 : 15_000);
  const projectHasRunningServer = devServers.some((devServer) => serverBelongsToProject(devServer, project, roots));
  const [gitChangeCount, setGitChangeCount] = useState(0);
  const [terminalOpen, setTerminalOpen] = useState(false);

  // Ctrl+` like in editors.
  useEffect(() => {
    const toggleTerminal = (keyboardEvent: KeyboardEvent) => {
      if (keyboardEvent.ctrlKey && keyboardEvent.key === "`") {
        keyboardEvent.preventDefault();
        setTerminalOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", toggleTerminal);
    return () => window.removeEventListener("keydown", toggleTerminal);
  }, []);

  // Number of uncommitted changes for the Git tab (the view itself refreshes while open).
  useEffect(() => {
    if (activeView === "git") return;
    const refreshCount = () =>
      api
        .gitStatus(project.id, gitRoot)
        .then((gitStatus) => setGitChangeCount(gitStatus.isRepository ? gitStatus.files.length : 0))
        .catch(() => setGitChangeCount(0));
    refreshCount();
    // Attached folders aren't watched: check now and then.
    const pollTimer = window.setInterval(() => document.visibilityState === "visible" && refreshCount(), 20_000);
    return () => window.clearInterval(pollTimer);
  }, [project.id, gitRoot, props.fileChangeCounter, activeView]);
  const editorIsDirty = editorContent !== savedContent;

  useEffect(() => setFileTreeReloadKey((previous) => previous + 1), [props.fileChangeCounter]);

  // A new/changed design artifact from the agent is shown immediately.
  useEffect(() => {
    if (props.fileChangeCounter === 0) return;
    const changedDesignFile = props.lastChangedPaths.find((changedPath) => /^design\/.+\.html?$/i.test(changedPath));
    // On the canvas the artifact appears in place; elsewhere jump to its preview.
    if (changedDesignFile && changedDesignFile !== selectedPath && activeView !== "canvas") {
      setSelection({ root: project.path, path: changedDesignFile });
      setActiveView("preview");
    }
    setPreviewReloadKey((previous) => previous + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.fileChangeCounter]);

  useEffect(() => {
    const editorShown = activeView === "code" || (activeView === "preview" && !selectionInProjectFolder);
    if (!selectedPath || !editorShown) return;
    if (editorIsDirty && selectionInProjectFolder && props.lastChangedPaths.includes(selectedPath)) return; // keep unsaved local edits
    api
      .readFile(project.id, selectedPath, selection?.root)
      .then(({ content }) => {
        setEditorContent(content);
        setSavedContent(content);
      })
      .catch(onError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, selection?.root, selectedPath, activeView, previewReloadKey]);

  const selectFile = (nextSelection: FileSelection) => {
    setSelection(nextSelection);
    setActiveView(nextSelection.root === project.path && previewableExtensions.test(nextSelection.path) ? "preview" : "code");
  };

  // Outside the project folder the chat gets the absolute path.
  const referenceFile = (fileSelection: FileSelection) =>
    props.onReferenceFile(fileSelection.root === project.path ? fileSelection.path : `${fileSelection.root}/${fileSelection.path}`);

  const saveFile = async () => {
    if (!selectedPath) return;
    setSavingFile(true);
    try {
      await api.writeFile(project.id, selectedPath, editorContent, selection?.root);
      setSavedContent(editorContent);
      toast.success(t("{0} gespeichert", selectedPath.split("/").pop() ?? selectedPath));
    } catch (saveError) {
      onError(saveError);
    } finally {
      setSavingFile(false);
    }
  };

  const breadcrumbSegments =
    activeView === "canvas"
      ? [project.name, "Canvas"]
      : activeView === "app" || activeView === "git"
        ? [project.name, activeView === "app" ? t("App") : "Git"]
      : [selectionInProjectFolder ? project.name : (roots.find((root) => root.path === selection?.root)?.label ?? project.name), ...(selectedPath?.split("/") ?? [])];
  const isDesignFile = selectedPath && selectionInProjectFolder ? selectedPath.startsWith("design/") : false;

  const workspaceBody = (
      <div className="flex min-h-0 flex-1">
        <nav
          className={cn(
            "shrink-0 overflow-hidden border-r bg-background transition-[width,opacity] duration-200 ease-out",
            filePanelOpen ? "w-64 opacity-100" : "w-0 border-r-0 opacity-0",
          )}
        >
          <div className="h-full w-64 overflow-y-auto p-1.5">
            {filePanelOpen && (
              <ProjectFiles project={project} roots={roots} codeRoot={codeRoot} selected={selection} refreshKey={fileTreeReloadKey} onSelect={selectFile} onReference={referenceFile} />
            )}
          </div>
        </nav>

        <div className="relative min-w-0 flex-1">
          {activeView === "canvas" ? (
            <ProjectCanvas
              projectId={project.id}
              fileChangeCounter={props.fileChangeCounter}
              lastChangedPaths={props.lastChangedPaths}
              onOpenFile={(filePath) => {
                setSelection({ root: project.path, path: filePath });
                setActiveView("preview");
              }}
              onSendToAgent={props.onInsertIntoComposer}
              onError={onError}
            />
          ) : activeView === "git" ? (
            <GitView
              project={project}
              roots={roots}
              root={gitRoot}
              onSelectRoot={setChosenGitRoot}
              fileChangeCounter={props.fileChangeCounter}
              onAskAgent={props.onInsertIntoComposer}
              onStatusChange={setGitChangeCount}
            />
          ) : activeView === "app" ? (
            <AppPreview project={project} roots={roots} devServers={devServers} />
          ) : !selectedPath ? (
            <div className="flex h-full items-center justify-center p-6 text-center text-[13px] text-muted-foreground">
              {t("Datei wählen. Neue Entwürfe des Agents erscheinen hier automatisch.")}
            </div>
          ) : activeView === "preview" && selectionInProjectFolder ? (
            <div key={selectedPath} className="absolute inset-0 animate-in fade-in p-3 duration-200">
              <iframe
                key={previewReloadKey}
                className="size-full rounded-lg border bg-white shadow-xs"
                title={t("Preview")}
                sandbox="allow-scripts allow-forms allow-popups allow-modals"
                src={api.previewUrl(project.id, selectedPath)}
              />
            </div>
          ) : (
            <div
              className="absolute inset-0 animate-in fade-in bg-background duration-200"
              onKeyDown={(keyboardEvent) => {
                if ((keyboardEvent.metaKey || keyboardEvent.ctrlKey) && keyboardEvent.key === "s") {
                  keyboardEvent.preventDefault();
                  void saveFile();
                }
              }}
            >
              <Suspense fallback={<div className="flex h-full items-center justify-center text-[13px] text-muted-foreground">{t("Editor lädt …")}</div>}>
                <CodeEditor
                  path={selectionInProjectFolder ? selectedPath : `${selection!.root.replace(/^\/+/, "")}/${selectedPath}`}
                  value={editorContent}
                  language={languageByExtension[(selectedPath.split("/").pop()?.split(".").pop() ?? "").toLowerCase()] ?? "plaintext"}
                  theme={props.resolvedTheme}
                  onChange={setEditorContent}
                />
              </Suspense>
            </div>
          )}
        </div>
      </div>
  );

  return (
    <section className="flex h-full min-w-0 flex-col bg-canvas">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-background px-3">
        <IconAction label={filePanelOpen ? t("Dateien ausblenden") : t("Dateien einblenden")} onClick={() => setFilePanelOpen((open) => !open)}>
          <PanelLeft className="size-4" />
        </IconAction>
        <nav className="flex min-w-0 items-center gap-1 text-[13px]">
          {breadcrumbSegments.map((segment, segmentIndex) => (
            <span key={`${segment}-${segmentIndex}`} className="flex min-w-0 items-center gap-1">
              {segmentIndex > 0 && <ChevronRight className="size-3 shrink-0 text-muted-foreground" />}
              <span className={cn("truncate", segmentIndex === breadcrumbSegments.length - 1 ? "font-medium" : "text-muted-foreground")}>
                {segment}
              </span>
            </span>
          ))}
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          <SegmentedControl
              className="mr-1 w-88"
              value={activeView}
              onValueChange={setActiveView}
              options={[
                { value: "canvas", label: t("Canvas") },
                { value: "preview", label: t("Preview") },
                { value: "code", label: editorIsDirty ? "Code •" : "Code" },
                {
                  value: "app",
                  label: (
                    <span className="inline-flex items-center gap-1">
                      {t("App")}
                      {projectHasRunningServer && <span className="size-1.5 rounded-full bg-emerald-500" aria-label={t("Server läuft")} />}
                    </span>
                  ),
                },
                {
                  value: "git",
                  label: (
                    <span className="inline-flex items-center gap-1">
                      Git
                      {gitChangeCount > 0 && <span className="text-[10.5px] text-muted-foreground tabular-nums">{gitChangeCount}</span>}
                    </span>
                  ),
                },
              ]}
            />
          {isDesignFile && selectedPath && (activeView === "preview" || activeView === "code") && (
            <Button size="sm" variant="secondary" className="h-7 text-[12px]" onClick={() => props.onImplementDesign(selectedPath)}>
              <Wand2 className="size-3.5" /> {t("In Code übernehmen")}
            </Button>
          )}
          {activeView === "code" && editorIsDirty && (
            <IconAction label={t("Speichern (⌘S)")} onClick={saveFile}>
              {savingFile ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            </IconAction>
          )}
          {activeView === "preview" && selectedPath && selectionInProjectFolder && (
            <>
              <IconAction label={t("Neu laden")} onClick={() => setPreviewReloadKey((previous) => previous + 1)}>
                <RotateCw className="size-4" />
              </IconAction>
              <IconAction label={t("Extern öffnen")} href={api.previewUrl(project.id, selectedPath)}>
                <ExternalLink className="size-4" />
              </IconAction>
            </>
          )}
          <IconAction label={terminalOpen ? t("Terminal ausblenden (Ctrl+`)") : t("Terminal (Ctrl+`)")} onClick={() => setTerminalOpen((open) => !open)}>
            <SquareTerminal className={cn("size-4", terminalOpen && "text-foreground")} />
          </IconAction>
          <IconAction label={t("Workspace schließen")} onClick={props.onClose}>
            <X className="size-4" />
          </IconAction>
        </div>
      </header>

      <ResizablePanelGroup id="harnold-workspace" orientation="vertical" className="min-h-0 flex-1">
        <ResizablePanel id="workspace-view" minSize={120} className="flex min-h-0">
          {workspaceBody}
        </ResizablePanel>
        {terminalOpen && (
          <>
            <ResizableHandle />
            <ResizablePanel id="workspace-terminal" defaultSize="35" minSize={100}>
              <Suspense fallback={<div className="h-full bg-background" />}>
                <TerminalPanel project={project} startRoot={codeRoot} theme={props.resolvedTheme} onClose={() => setTerminalOpen(false)} />
              </Suspense>
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
    </section>
  );
}
