import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { FileText, Plus, Search, Settings2, Trash2 } from "lucide-react";
import { api } from "@/api";
import type { MemoryNoteRef, MemoryNoteSummary, MemoryScope, MemorySearchHit, Project } from "@/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SegmentedControl } from "@/components/segmented-control";
import { formatRelativeTime } from "@/components/form-field";
import { EmptyState, ScreenLayout } from "./screen-layout";
import { confirmAction } from "@/components/confirm-dialog";

/** `{ scope, path }` of the open note, "new" for a draft, null for none. */
export type MemorySelection = { scope: MemoryScope; path: string } | "new" | null;

type MemoryScreenProps = {
  project: Project | null;
  selection: MemorySelection;
  onSelect: (selection: MemorySelection) => void;
  memoryChangeCounter: number;
  onOpenSettings: () => void;
  onError: (unknownError: unknown) => void;
};

type ScopeFilter = "all" | MemoryScope;
type EditorState = { noteRef: MemoryNoteRef | null; draftScope: MemoryScope; draftPath: string; content: string; savedContent: string };

const scopeLabels: Record<MemoryScope, string> = { workspace: "Workspace", project: "Projekt" };

function ScopeBadge(props: { scope: MemoryScope }) {
  return (
    <span className={cn("shrink-0 rounded px-1.5 py-px text-[10.5px] font-medium", props.scope === "project" ? "bg-primary/10 text-foreground" : "bg-muted text-muted-foreground")}>
      {scopeLabels[props.scope]}
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
  const { onError } = props;

  useEffect(() => {
    api.listMemoryNotes(projectId).then(setNoteSummaries).catch(onError);
  }, [projectId, props.memoryChangeCounter, onError]);

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
    const noteRef: MemoryNoteRef = { scope: selection.scope, projectId: selection.scope === "project" ? projectId : null, path: selection.path };
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
      projectId: editor.draftScope === "project" ? projectId : null,
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
            { value: "workspace", label: "Workspace" },
          ]}
          value={scopeFilter}
          onValueChange={setScopeFilter}
        />
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {props.project && (
          <button
            className={cn(
              "mb-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12.5px] text-muted-foreground transition-colors duration-150 hover:bg-foreground/[0.04] hover:text-foreground",
              editor?.noteRef?.path === "HARNOLD.md" && editor.noteRef.scope === "project" && "bg-foreground/[0.07] text-foreground",
            )}
            onClick={() => selectNote({ scope: "project", path: "HARNOLD.md" })}
          >
            <FileText className="size-3.5" /> Projekt-Anweisungen (HARNOLD.md)
          </button>
        )}
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
                  <ScopeBadge scope={noteSummary.scope} />
                </div>
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="truncate font-mono">{noteSummary.path}</span>
                  <span className="ml-auto shrink-0">{formatRelativeTime(noteSummary.modifiedAt)}</span>
                </div>
                {"snippet" in noteSummary && noteSummary.snippet && <Snippet text={noteSummary.snippet} />}
              </button>
            );
          })}
      </div>
    </div>
  );

  const detail = !editor ? (
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
            <ScopeBadge scope={editor.noteRef.scope} />
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
      description={props.project ? `Workspace + Projekt „${props.project.name}“` : "Workspace"}
      actions={
        <>
          <Button size="sm" variant="ghost" className="gap-1.5 text-muted-foreground" onClick={props.onOpenSettings}>
            <Settings2 className="size-3.5" /> Einstellungen
          </Button>
          <Button size="sm" variant="secondary" onClick={() => selectNote("new")}>
            <Plus className="size-3.5" /> Neue Notiz
          </Button>
        </>
      }
    >
      <div className="flex h-full min-h-0">
        <div className="w-80 shrink-0 border-r">{list}</div>
        <div className="min-w-0 flex-1">{detail}</div>
      </div>
    </ScreenLayout>
  );
}
