import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { ExternalLink, FileText, Paperclip, Plus, Search, Settings2, Trash2 } from "lucide-react";
import { api } from "@/api";
import type { Environment, MemoryFile, MemoryNoteRef, MemoryNoteSummary, MemoryScope, MemorySearchHit, Project } from "@/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SegmentedControl } from "@/components/segmented-control";
import { formatRelativeTime } from "@/components/form-field";
import { EmptyState, ScreenLayout } from "./screen-layout";
import { confirmAction } from "@/components/confirm-dialog";
import { ProjectAvatar } from "@/components/project-avatar";
import { fileIconFor, formatFileSize, isImagePath } from "@/components/chat/attachment-views";

/** `{ scope, path }` of the open note, "new" for a draft, null for none. */
export type MemorySelection = { scope: MemoryScope; path: string } | "new" | null;

type MemoryScreenProps = {
  project: Project | null;
  /** Environment of the project; its memory applies to all projects in it. */
  environment: Environment | null;
  /** All projects, for the project selector (project memory belongs to one project). */
  projects: Project[];
  onProjectChange: (projectId: string) => void;
  selection: MemorySelection;
  onSelect: (selection: MemorySelection) => void;
  memoryChangeCounter: number;
  onOpenSettings: () => void;
  onError: (unknownError: unknown) => void;
};

type ScopeFilter = "all" | MemoryScope;
type EditorState = { noteRef: MemoryNoteRef | null; draftScope: MemoryScope; draftPath: string; content: string; savedContent: string };

const scopeLabels: Record<MemoryScope, string> = { workspace: "Workspace", environment: "Umgebung", project: "Projekt" };
const scopeBadgeClassNames: Record<MemoryScope, string> = {
  project: "bg-primary/10 text-foreground",
  environment: "bg-primary/10 text-primary",
  workspace: "bg-muted text-muted-foreground",
};

/** Environment badges show the environment's name. */
function ScopeBadge(props: { scope: MemoryScope; environmentName?: string }) {
  return (
    <span className={cn("max-w-28 shrink-0 truncate rounded px-1.5 py-px text-[10.5px] font-medium", scopeBadgeClassNames[props.scope])}>
      {props.scope === "environment" && props.environmentName ? props.environmentName : scopeLabels[props.scope]}
    </span>
  );
}

/** Renders FTS snippets: `**term**` → highlighted. */
function Snippet(props: { text: string }) {
  const parts = props.text.split(/\*\*(.+?)\*\*/g);
  return (
    <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-muted-foreground">
      {parts.map((part, partIndex) =>
        partIndex % 2 ? (
          <mark key={partIndex} className="rounded-sm bg-status-waiting/25 px-0.5 text-foreground">
            {part}
          </mark>
        ) : (
          part.replace(/^#+\s*/gm, "")
        ),
      )}
    </p>
  );
}

const sameNote = (first: { scope: MemoryScope; path: string }, second: { scope: MemoryScope; path: string }) => first.scope === second.scope && first.path === second.path;

export function MemoryScreen(props: MemoryScreenProps) {
  const projectId = props.project?.id ?? null;
  const [noteSummaries, setNoteSummaries] = useState<MemoryNoteSummary[]>([]);
  const [searchText, setSearchText] = useState("");
  const [searchHits, setSearchHits] = useState<MemorySearchHit[] | null>(null);
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [editorMode, setEditorMode] = useState<"edit" | "preview">("edit");
  const [saving, setSaving] = useState(false);
  const searchRequestRef = useRef(0);
  const environmentName = props.environment?.name;
  const scopeLabelOf = (scope: MemoryScope) => (scope === "environment" && environmentName ? `Umgebung „${environmentName}“` : scopeLabels[scope]);
  const [memoryFileList, setMemoryFileList] = useState<MemoryFile[]>([]);
  const [openedFile, setOpenedFile] = useState<MemoryFile | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { onError } = props;

  useEffect(() => {
    api.listMemoryNotes(projectId).then(setNoteSummaries).catch(onError);
  }, [projectId, props.memoryChangeCounter, onError]);

  const reloadMemoryFiles = () => api.listMemoryFiles(projectId).then(setMemoryFileList).catch(onError);
  useEffect(() => {
    void reloadMemoryFiles();
    setOpenedFile(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, props.memoryChangeCounter]);

  // Project without environment: the environment filter makes no sense there.
  useEffect(() => {
    if (!props.environment && scopeFilter === "environment") setScopeFilter("all");
  }, [props.environment, scopeFilter]);

  // A note opened via route closes the file view.
  useEffect(() => {
    if (props.selection !== null) setOpenedFile(null);
  }, [props.selection]);

  useEffect(() => {
    if (!searchText.trim()) {
      setSearchHits(null);
      return;
    }
    const searchRequestId = ++searchRequestRef.current;
    const debounceTimer = window.setTimeout(() => {
      api
        .searchMemory(searchText, projectId)
        .then((foundHits) => searchRequestId === searchRequestRef.current && setSearchHits(foundHits))
        .catch(onError);
    }, 200);
    return () => window.clearTimeout(debounceTimer);
  }, [searchText, projectId, props.memoryChangeCounter, onError]);

  // Load the selected note (route → editor).
  useEffect(() => {
    const selection = props.selection;
    if (selection === null) return setEditor(null);
    if (selection === "new") {
      setEditorMode("edit");
      return setEditor({ noteRef: null, draftScope: projectId ? "project" : "workspace", draftPath: "", content: "# \n", savedContent: "" });
    }
    if (editor?.noteRef && sameNote(editor.noteRef, selection)) return;
    const noteRef: MemoryNoteRef = { scope: selection.scope, projectId: selection.scope === "workspace" ? null : projectId, path: selection.path };
    api
      .readMemoryNote(noteRef)
      .catch((readError) => {
        if (noteRef.path === "HARNOLD.md") return ""; // not created yet
        throw readError;
      })
      .then((content) => {
        setEditorMode("edit");
        setEditor({ noteRef, draftScope: noteRef.scope, draftPath: noteRef.path, content, savedContent: content });
      })
      .catch((readError) => {
        onError(readError);
        props.onSelect(null);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.selection, projectId]);

  const visibleNotes = useMemo(() => {
    const sourceNotes: (MemoryNoteSummary | MemorySearchHit)[] = searchHits ?? noteSummaries;
    return sourceNotes.filter((noteSummary) => scopeFilter === "all" || noteSummary.scope === scopeFilter);
  }, [searchHits, noteSummaries, scopeFilter]);

  const visibleFiles = memoryFileList.filter(
    (memoryFile) => (scopeFilter === "all" || memoryFile.scope === scopeFilter) && (!searchText.trim() || memoryFile.path.toLowerCase().includes(searchText.trim().toLowerCase())),
  );

  /** Upload target: the filtered scope, otherwise the project (if one is chosen). */
  const uploadScope: MemoryScope = scopeFilter === "workspace" || !projectId ? "workspace" : scopeFilter === "environment" && props.environment ? "environment" : "project";
  const uploadFiles = async (files: File[]) => {
    const memoryFilesToUpload = files.filter((file) => !file.name.toLowerCase().endsWith(".md"));
    if (!memoryFilesToUpload.length) return;
    setUploading(true);
    try {
      const savedFiles = await api.uploadMemoryFiles(uploadScope, projectId, memoryFilesToUpload);
      await reloadMemoryFiles();
      if (savedFiles.length === 1) openFile(savedFiles[0]);
    } catch (uploadError) {
      onError(uploadError);
    } finally {
      setUploading(false);
    }
  };

  const openFile = async (memoryFile: MemoryFile) => {
    if (dirty && !(await confirmAction({ title: "Ungespeicherte Änderungen verwerfen?", confirmLabel: "Verwerfen" }))) return;
    if (props.selection !== null) props.onSelect(null);
    setOpenedFile(memoryFile);
  };

  const deleteFile = async (memoryFile: MemoryFile) => {
    if (!(await confirmAction({ title: `„${memoryFile.name}“ löschen?`, description: "Die Datei wird entfernt." }))) return;
    try {
      await api.deleteMemoryFile(memoryFile);
      setOpenedFile(null);
      await reloadMemoryFiles();
    } catch (deleteError) {
      onError(deleteError);
    }
  };

  const updateEditor = (changes: Partial<EditorState>) => setEditor((previous) => (previous ? { ...previous, ...changes } : previous));
  const dirty = editor ? editor.content !== editor.savedContent : false;

  const selectNote = async (selection: MemorySelection) => {
    if (dirty && !(await confirmAction({ title: "Ungespeicherte Änderungen verwerfen?", confirmLabel: "Verwerfen" }))) return;
    props.onSelect(selection);
  };

  const saveNote = async () => {
    if (!editor) return;
    const noteRef: MemoryNoteRef = editor.noteRef ?? {
      scope: editor.draftScope,
      projectId: editor.draftScope === "workspace" ? null : projectId,
      path: editor.draftPath.trim() || editor.content.match(/^#\s+(.+)$/m)?.[1]?.trim() || "notiz",
    };
    setSaving(true);
    try {
      const savedPath = await api.saveMemoryNote(noteRef, editor.content);
      const savedRef = { ...noteRef, path: savedPath };
      setEditor({ ...editor, noteRef: savedRef, draftPath: savedPath, savedContent: editor.content });
      if (!editor.noteRef) props.onSelect({ scope: savedRef.scope, path: savedPath });
    } catch (saveError) {
      onError(saveError);
    } finally {
      setSaving(false);
    }
  };

  const deleteNote = async (noteRef: MemoryNoteRef) => {
    if (!(await confirmAction({ title: `„${noteRef.path}“ löschen?`, description: "Die Datei wird entfernt." }))) return;
    try {
      await api.deleteMemoryNote(noteRef);
      props.onSelect(null);
    } catch (deleteError) {
      onError(deleteError);
    }
  };

  /** HARNOLD.md per level: permanent instructions, loaded automatically into every turn. */
  const instructionFiles = [
    props.project && { scope: "project" as const, label: "Projekt-Anweisungen (HARNOLD.md)" },
    props.project && props.environment && { scope: "environment" as const, label: `Umgebungs-Anweisungen „${props.environment.name}“` },
    { scope: "workspace" as const, label: "Workspace-Anweisungen (HARNOLD.md)" },
  ].filter(Boolean) as { scope: MemoryScope; label: string }[];

  const list = (
    <div className="flex h-full flex-col">
      <div className="grid gap-2 border-b p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input className="h-8 pl-8" placeholder="Suchen …" value={searchText} onChange={(changeEvent) => setSearchText(changeEvent.target.value)} />
        </div>
        <SegmentedControl
          options={[
            { value: "all", label: "Alle" },
            { value: "project", label: "Projekt" },
            ...(props.environment ? [{ value: "environment" as const, label: "Umgebung" }] : []),
            { value: "workspace", label: "Workspace" },
          ]}
          value={scopeFilter}
          onValueChange={setScopeFilter}
        />
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {instructionFiles.map((instructionFile) => (
          <button
            key={instructionFile.scope}
            className={cn(
              "mb-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12.5px] text-muted-foreground transition-colors duration-150 hover:bg-foreground/[0.04] hover:text-foreground",
              editor?.noteRef?.path === "HARNOLD.md" && editor.noteRef.scope === instructionFile.scope && "bg-foreground/[0.07] text-foreground",
            )}
            onClick={() => selectNote({ scope: instructionFile.scope, path: "HARNOLD.md" })}
          >
            <FileText className="size-3.5 shrink-0" /> <span className="truncate">{instructionFile.label}</span>
          </button>
        ))}
        {visibleNotes.length === 0 && (
          <p className="px-2 py-6 text-center text-[12.5px] text-muted-foreground">{searchHits ? "Keine Treffer." : "Noch keine Notizen."}</p>
        )}
        {visibleNotes
          .filter((noteSummary) => noteSummary.path !== "HARNOLD.md")
          .map((noteSummary) => {
            const selected = Boolean(editor?.noteRef && sameNote(editor.noteRef, noteSummary));
            return (
              <button
                key={`${noteSummary.scope}:${noteSummary.projectId}:${noteSummary.path}`}
                className={cn(
                  "block w-full rounded-lg px-2.5 py-2 text-left transition-colors duration-150",
                  selected ? "bg-foreground/[0.07]" : "hover:bg-foreground/[0.04]",
                )}
                onClick={() => selectNote({ scope: noteSummary.scope, path: noteSummary.path })}
              >
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-medium">{noteSummary.title}</span>
                  <ScopeBadge scope={noteSummary.scope} environmentName={environmentName} />
                </div>
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="truncate font-mono">{noteSummary.path}</span>
                  <span className="ml-auto shrink-0">{formatRelativeTime(noteSummary.modifiedAt)}</span>
                </div>
                {"snippet" in noteSummary && noteSummary.snippet && <Snippet text={noteSummary.snippet} />}
              </button>
            );
          })}
        {visibleFiles.length > 0 && (
          <>
            <p className="px-2.5 pt-3 pb-1 text-[11px] font-medium text-muted-foreground">Dateien</p>
            {visibleFiles.map((memoryFile) => {
              const TypeIcon = fileIconFor(memoryFile.mimeType, memoryFile.name);
              const selected = openedFile !== null && openedFile.scope === memoryFile.scope && openedFile.path === memoryFile.path;
              return (
                <button
                  key={`${memoryFile.scope}:${memoryFile.path}`}
                  className={cn("flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors duration-150", selected ? "bg-foreground/[0.07]" : "hover:bg-foreground/[0.04]")}
                  onClick={() => void openFile(memoryFile)}
                >
                  <TypeIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-[13px] font-medium">{memoryFile.name}</span>
                      <ScopeBadge scope={memoryFile.scope} environmentName={environmentName} />
                    </span>
                    <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
                      <span>{formatFileSize(memoryFile.size)}</span>
                      <span className="ml-auto shrink-0">{formatRelativeTime(memoryFile.modifiedAt)}</span>
                    </span>
                  </span>
                </button>
              );
            })}
          </>
        )}
      </div>
    </div>
  );

  const fileDetail = openedFile && (
    <div key={`file:${openedFile.scope}:${openedFile.path}`} className="flex h-full animate-in flex-col fade-in duration-200">
      <div className="flex items-center gap-2 border-b px-4 py-2">
        <span className="truncate font-mono text-[12.5px]">{openedFile.path}</span>
        <ScopeBadge scope={openedFile.scope} environmentName={environmentName} />
        <a href={api.memoryFileUrl(openedFile)} target="_blank" rel="noreferrer" className="ml-auto text-muted-foreground hover:text-foreground" aria-label="In neuem Tab öffnen">
          <ExternalLink className="size-3.5" />
        </a>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-muted/30">
        {isImagePath(openedFile.name) ? (
          <img src={api.memoryFileUrl(openedFile)} alt={openedFile.name} className="mx-auto max-h-full max-w-full object-contain p-6" />
        ) : openedFile.mimeType === "application/pdf" || openedFile.mimeType.startsWith("text/") ? (
          <iframe src={api.memoryFileUrl(openedFile)} title={openedFile.name} className="size-full border-0 bg-background" />
        ) : (
          <EmptyState
            title="Keine Vorschau"
            description="Der Agent liest die Datei bei Bedarf mit seinen Tools."
            action={
              <Button size="sm" variant="secondary" asChild>
                <a href={api.memoryFileUrl(openedFile)} target="_blank" rel="noreferrer">
                  Öffnen
                </a>
              </Button>
            }
          />
        )}
      </div>
      <div className="flex items-center gap-2 border-t px-4 py-2.5">
        <span className="text-[11.5px] text-muted-foreground">Im Kontext: der Agent sieht die Datei und öffnet sie, wenn sie relevant ist.</span>
        <Button size="sm" variant="ghost" className="ml-auto gap-1.5 text-muted-foreground hover:text-destructive" onClick={() => void deleteFile(openedFile)}>
          <Trash2 className="size-3.5" /> Löschen
        </Button>
      </div>
    </div>
  );

  const detail = fileDetail ? (
    fileDetail
  ) : !editor ? (
    <EmptyState
      title="Notiz wählen"
      action={
        <Button size="sm" onClick={() => selectNote("new")}>
          <Plus className="size-3.5" /> Neue Notiz
        </Button>
      }
    />
  ) : (
    <div key={editor.noteRef ? `${editor.noteRef.scope}:${editor.noteRef.path}` : "new"} className="flex h-full animate-in flex-col fade-in duration-200">
      <div className="flex items-center gap-2 border-b px-4 py-2">
        {editor.noteRef ? (
          <>
            <span className="truncate font-mono text-[12.5px]">{editor.noteRef.path}</span>
            <ScopeBadge scope={editor.noteRef.scope} environmentName={environmentName} />
          </>
        ) : (
          <>
            <Input
              className="h-8 flex-1 font-mono text-[12.5px]"
              placeholder="pfad/zur-notiz.md (leer = aus Titel)"
              value={editor.draftPath}
              onChange={(changeEvent) => updateEditor({ draftPath: changeEvent.target.value })}
            />
            <Select value={editor.draftScope} onValueChange={(value) => updateEditor({ draftScope: value as MemoryScope })}>
              <SelectTrigger size="sm" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {projectId && <SelectItem value="project">Projekt</SelectItem>}
                {projectId && props.environment && <SelectItem value="environment">Umgebung</SelectItem>}
                <SelectItem value="workspace">Workspace</SelectItem>
              </SelectContent>
            </Select>
          </>
        )}
        <SegmentedControl
          className="ml-auto w-44 shrink-0"
          options={[
            { value: "edit", label: "Bearbeiten" },
            { value: "preview", label: "Vorschau" },
          ]}
          value={editorMode}
          onValueChange={setEditorMode}
        />
      </div>

      {editorMode === "edit" ? (
        <textarea
          key="edit"
          autoFocus
          value={editor.content}
          onChange={(changeEvent) => updateEditor({ content: changeEvent.target.value })}
          onKeyDown={(keyboardEvent) => {
            if ((keyboardEvent.metaKey || keyboardEvent.ctrlKey) && keyboardEvent.key === "s") {
              keyboardEvent.preventDefault();
              void saveNote();
            }
          }}
          className="mx-auto w-full max-w-3xl flex-1 animate-in resize-none bg-transparent px-6 py-5 font-mono text-[13px] leading-relaxed outline-none fade-in duration-150"
          spellCheck={false}
        />
      ) : (
        <div key="preview" className="flex-1 animate-in overflow-y-auto fade-in duration-150">
          <div className="chat-markdown mx-auto max-w-3xl px-6 py-5 text-[14px] leading-relaxed">
            <ReactMarkdown>{editor.content}</ReactMarkdown>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 border-t px-4 py-2.5">
        <Button size="sm" disabled={saving || !dirty} onClick={() => void saveNote()}>
          Speichern
        </Button>
        <span className="text-[11.5px] text-muted-foreground">{dirty ? "Ungespeichert · ⌘S" : editor.noteRef ? "Gespeichert" : ""}</span>
        {editor.noteRef && (
          <Button size="sm" variant="ghost" className="ml-auto gap-1.5 text-muted-foreground hover:text-destructive" onClick={() => editor.noteRef && void deleteNote(editor.noteRef)}>
            <Trash2 className="size-3.5" /> Löschen
          </Button>
        )}
      </div>
    </div>
  );

  return (
    <ScreenLayout
      title="Memory"
      tabs={
        props.projects.length > 0 && (
          <Select value={props.project?.id ?? ""} onValueChange={props.onProjectChange}>
            <SelectTrigger size="sm" className="h-7 min-w-40 text-[12.5px]" aria-label="Projekt">
              <SelectValue placeholder="Projekt wählen" />
            </SelectTrigger>
            <SelectContent>
              {props.projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  <ProjectAvatar name={project.name} icon={project.icon} className="size-4 text-[9px]" />
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )
      }
      actions={
        <>
          <Button size="sm" variant="ghost" className="gap-1.5 text-muted-foreground" onClick={props.onOpenSettings}>
            <Settings2 className="size-3.5" /> Einstellungen
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(changeEvent) => {
              void uploadFiles([...(changeEvent.target.files ?? [])]);
              changeEvent.target.value = "";
            }}
          />
          <Button
            size="sm"
            variant="ghost"
            className="gap-1.5 text-muted-foreground"
            disabled={uploading}
            title={`Landet im Gedächtnis: ${scopeLabelOf(uploadScope)}`}
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip className="size-3.5" /> {uploading ? "Lädt hoch …" : "Datei hinzufügen"}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => selectNote("new")}>
            <Plus className="size-3.5" /> Neue Notiz
          </Button>
        </>
      }
    >
      <div
        className="relative flex h-full min-h-0"
        onDragOver={(dragEvent) => {
          if (!dragEvent.dataTransfer.types.includes("Files")) return;
          dragEvent.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={(dragEvent) => {
          if (!dragEvent.currentTarget.contains(dragEvent.relatedTarget as Node | null)) setDragActive(false);
        }}
        onDrop={(dragEvent) => {
          if (!dragEvent.dataTransfer.files.length) return;
          dragEvent.preventDefault();
          setDragActive(false);
          void uploadFiles([...dragEvent.dataTransfer.files]);
        }}
      >
        <div className="w-80 shrink-0 border-r">{list}</div>
        <div className="min-w-0 flex-1">{detail}</div>
        {dragActive && (
          <div className="pointer-events-none absolute inset-2 z-30 flex animate-in flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-primary bg-primary/10 fade-in duration-150">
            <Paperclip className="size-6 text-primary" />
            <p className="text-[14px] font-medium">Ablegen im Gedächtnis: {scopeLabelOf(uploadScope)}</p>
            <p className="text-[12px] text-muted-foreground">PDFs, Bilder, Dokumente – der Agent liest sie bei Bedarf</p>
          </div>
        )}
      </div>
    </ScreenLayout>
  );
}
