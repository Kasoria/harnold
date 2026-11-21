import { useEffect, useState } from "react";
import Editor from "@monaco-editor/react";
import { ChevronRight, ExternalLink, PanelLeft, RotateCw, Save, Wand2, X } from "lucide-react";
import { api } from "@/api";
import type { FileNode, Project } from "@/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SegmentedControl } from "@/components/segmented-control";
import { FileTree } from "./file-tree";
import { ProjectCanvas } from "@/components/canvas/project-canvas";

type WorkspaceView = "canvas" | "preview" | "code";

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
  css: "css", html: "html", md: "markdown", py: "python", yml: "yaml", yaml: "yaml", sh: "shell", swift: "swift",
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
  const [fileTree, setFileTree] = useState<FileNode[]>([]);
  const [filePanelOpen, setFilePanelOpen] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<WorkspaceView>("canvas");
  const [editorContent, setEditorContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [previewReloadKey, setPreviewReloadKey] = useState(0);

  const { project, onError } = props;
  const editorIsDirty = editorContent !== savedContent;

  useEffect(() => {
    api.readTree(project.id).then(setFileTree).catch(onError);
  }, [project.id, props.fileChangeCounter, onError]);

  // A new/changed design artifact from the agent is shown immediately.
  useEffect(() => {
    if (props.fileChangeCounter === 0) return;
    const changedDesignFile = props.lastChangedPaths.find((changedPath) => /^design\/.+\.html?$/i.test(changedPath));
    // On the canvas the artifact appears in place; elsewhere jump to its preview.
    if (changedDesignFile && changedDesignFile !== selectedPath && activeView !== "canvas") {
      setSelectedPath(changedDesignFile);
      setActiveView("preview");
    }
    setPreviewReloadKey((previous) => previous + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.fileChangeCounter]);

  useEffect(() => {
    if (!selectedPath || activeView !== "code") return;
    if (editorIsDirty && props.lastChangedPaths.includes(selectedPath)) return; // keep unsaved local edits
    api
      .readFile(project.id, selectedPath)
      .then(({ content }) => {
        setEditorContent(content);
        setSavedContent(content);
      })
      .catch(onError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, selectedPath, activeView, previewReloadKey]);

  const selectFile = (filePath: string) => {
    setSelectedPath(filePath);
    setActiveView(previewableExtensions.test(filePath) ? "preview" : "code");
  };

  const saveFile = async () => {
    if (!selectedPath) return;
    try {
      await api.writeFile(project.id, selectedPath, editorContent);
      setSavedContent(editorContent);
    } catch (saveError) {
      onError(saveError);
    }
  };

  const breadcrumbSegments =
    activeView === "canvas"
      ? [project.name, "Canvas"]
      : [project.name, ...(selectedPath?.split("/") ?? [])];
  const isDesignFile = selectedPath ? selectedPath.startsWith("design/") : false;

  return (
    <section className="flex h-full min-w-0 flex-col bg-canvas">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-background px-3">
        <IconAction label={filePanelOpen ? "Dateien ausblenden" : "Dateien einblenden"} onClick={() => setFilePanelOpen((open) => !open)}>
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
              className="mr-1 w-56"
              value={activeView}
              onValueChange={setActiveView}
              options={[
                { value: "canvas", label: "Canvas" },
                { value: "preview", label: "Preview" },
                { value: "code", label: editorIsDirty ? "Code •" : "Code" },
              ]}
            />
          {isDesignFile && selectedPath && (activeView === "preview" || activeView === "code") && (
            <Button size="sm" variant="secondary" className="h-7 text-[12px]" onClick={() => props.onImplementDesign(selectedPath)}>
              <Wand2 className="size-3.5" /> In Code übernehmen
            </Button>
          )}
          {activeView === "code" && editorIsDirty && (
            <IconAction label="Speichern (⌘S)" onClick={saveFile}>
              <Save className="size-4" />
            </IconAction>
          )}
          {activeView === "preview" && selectedPath && (
            <>
              <IconAction label="Neu laden" onClick={() => setPreviewReloadKey((previous) => previous + 1)}>
                <RotateCw className="size-4" />
              </IconAction>
              <IconAction label="Extern öffnen" href={api.previewUrl(project.id, selectedPath)}>
                <ExternalLink className="size-4" />
              </IconAction>
            </>
          )}
          <IconAction label="Workspace schließen" onClick={props.onClose}>
            <X className="size-4" />
          </IconAction>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav
          className={cn(
            "shrink-0 overflow-hidden border-r bg-background transition-[width,opacity] duration-200 ease-out",
            filePanelOpen ? "w-56 opacity-100" : "w-0 border-r-0 opacity-0",
          )}
        >
          <div className="h-full w-56 overflow-y-auto p-1.5">
            {fileTree.length ? (
              <FileTree nodes={fileTree} selectedPath={selectedPath} onSelect={selectFile} onReference={props.onReferenceFile} />
            ) : (
              <p className="p-2 text-[12.5px] text-muted-foreground">Noch leer. Bitte den Agent z. B. um einen Entwurf unter design/.</p>
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
                setSelectedPath(filePath);
                setActiveView("preview");
              }}
              onSendToAgent={props.onInsertIntoComposer}
              onError={onError}
            />
          ) : !selectedPath ? (
            <div className="flex h-full items-center justify-center p-6 text-center text-[13px] text-muted-foreground">
              Datei wählen. Neue Entwürfe des Agents erscheinen hier automatisch.
            </div>
          ) : activeView === "preview" ? (
            <div key={selectedPath} className="absolute inset-0 animate-in fade-in p-3 duration-200">
              <iframe
                key={previewReloadKey}
                className="size-full rounded-lg border bg-white shadow-xs"
                title="Preview"
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
              <Editor
                path={selectedPath}
                value={editorContent}
                language={languageByExtension[selectedPath.split(".").pop() ?? ""] ?? "plaintext"}
                theme={props.resolvedTheme === "dark" ? "vs-dark" : "vs"}
                onChange={(value) => setEditorContent(value ?? "")}
                options={{ minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false, padding: { top: 12 } }}
              />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
