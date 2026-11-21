import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { ArrowLeft, FileText, Plus, Search, Settings2, Trash2 } from "lucide-react";
import { api } from "@/api";
import type { EmbeddingProvider, MemoryNoteRef, MemoryNoteSummary, MemoryScope, MemorySearchHit, MemorySettings, MemorySettingsView, Project } from "@/types";
import { cn } from "@/lib/utils";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SegmentedControl } from "@/components/segmented-control";
import { FormField, formatRelativeTime } from "@/components/form-field";

type MemorySheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project | null;
  /** Bumped on every `memory_changed` event. */
  memoryChangeCounter: number;
  onError: (unknownError: unknown) => void;
};

type ScopeFilter = "all" | MemoryScope;
type EditorState = { noteRef: MemoryNoteRef | null; draftScope: MemoryScope; draftPath: string; content: string; savedContent: string };
type SheetView = { kind: "list" } | { kind: "editor"; editor: EditorState } | { kind: "settings" };

const scopeLabels: Record<MemoryScope, string> = { workspace: "Workspace", project: "Projekt" };

const embeddingProviderLabels: Record<EmbeddingProvider, string> = {
  off: "Aus (nur Volltext)",
  openai: "OpenAI",
  ollama: "Ollama (lokal)",
};

function ScopeBadge(props: { scope: MemoryScope }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1.5 py-px text-[10.5px] font-medium",
        props.scope === "project" ? "bg-primary/10 text-foreground" : "bg-muted text-muted-foreground",
      )}
    >
      {scopeLabels[props.scope]}
    </span>
  );
}

/** Renders FTS snippets: `**term**` → highlighted. */
function Snippet(props: { text: string }) {
  const parts = props.text.split(/\*\*(.+?)\*\*/g);
  return (
    <p className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-muted-foreground">
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

function MemorySettingsForm(props: { onDone: () => void; onError: (unknownError: unknown) => void }) {
  const [settingsView, setSettingsView] = useState<MemorySettingsView | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<MemorySettings | null>(null);
  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .readMemorySettings()
      .then((loadedSettings) => {
        setSettingsView(loadedSettings);
        const { workspaceDirectory, embeddingProvider, embeddingModel, ollamaUrl } = loadedSettings;
        setSettingsDraft({ workspaceDirectory, embeddingProvider, embeddingModel, ollamaUrl });
      })
      .catch(props.onError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!settingsDraft || !settingsView) return null;
  const updateDraft = (changes: Partial<MemorySettings>) => setSettingsDraft((previous) => (previous ? { ...previous, ...changes } : previous));

  const save = async () => {
    setSaving(true);
    try {
      await api.saveMemorySettings(settingsDraft, openaiApiKey);
      props.onDone();
    } catch (saveError) {
      props.onError(saveError);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid animate-in gap-4 fade-in slide-in-from-right-2 duration-200">
      <FormField label="Workspace-Memory-Ordner" hint={`Leer = Standard. Kann ein Obsidian-Vault sein. Aktuell: ${settingsView.resolvedWorkspaceDirectory}`}>
        <Input value={settingsDraft.workspaceDirectory} placeholder="~/Vaults/MeinVault" onChange={(changeEvent) => updateDraft({ workspaceDirectory: changeEvent.target.value })} />
      </FormField>

      <FormField label="Semantische Suche" hint="Ergänzt die Volltextsuche um Vektoren. Der Index wird automatisch neu aufgebaut.">
        <Select value={settingsDraft.embeddingProvider} onValueChange={(value) => updateDraft({ embeddingProvider: value as EmbeddingProvider, embeddingModel: "" })}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(embeddingProviderLabels).map(([providerValue, providerLabel]) => (
              <SelectItem key={providerValue} value={providerValue}>
                {providerLabel}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>

      {settingsDraft.embeddingProvider !== "off" && (
        <FormField label="Modell">
          <Input
            value={settingsDraft.embeddingModel}
            placeholder={settingsDraft.embeddingProvider === "openai" ? "text-embedding-3-small" : "nomic-embed-text"}
            onChange={(changeEvent) => updateDraft({ embeddingModel: changeEvent.target.value })}
          />
        </FormField>
      )}
      {settingsDraft.embeddingProvider === "openai" && (
        <FormField label="OpenAI API-Key" hint="Leer = Key aus den Voice-Einstellungen.">
          <Input
            type="password"
            value={openaiApiKey}
            placeholder={settingsView.openaiKeySet ? "gespeichert – leer lassen zum Behalten" : ""}
            onChange={(changeEvent) => setOpenaiApiKey(changeEvent.target.value)}
          />
        </FormField>
      )}
      {settingsDraft.embeddingProvider === "ollama" && (
        <FormField label="Ollama-Adresse">
          <Input value={settingsDraft.ollamaUrl} onChange={(changeEvent) => updateDraft({ ollamaUrl: changeEvent.target.value })} />
        </FormField>
      )}

      <div className="flex gap-2">
        <Button size="sm" disabled={saving} onClick={() => void save()}>
          Speichern
        </Button>
        <Button size="sm" variant="ghost" onClick={props.onDone}>
          Abbrechen
        </Button>
      </div>
    </div>
  );
}

export function MemorySheet(props: MemorySheetProps) {
  const projectId = props.project?.id ?? null;
  const [sheetView, setSheetView] = useState<SheetView>({ kind: "list" });
  const [noteSummaries, setNoteSummaries] = useState<MemoryNoteSummary[]>([]);
  const [searchText, setSearchText] = useState("");
  const [searchHits, setSearchHits] = useState<MemorySearchHit[] | null>(null);
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");
  const [editorMode, setEditorMode] = useState<"edit" | "preview">("edit");
  const [saving, setSaving] = useState(false);
  const searchRequestRef = useRef(0);

  useEffect(() => {
    if (props.open) api.listMemoryNotes(projectId).then(setNoteSummaries).catch(props.onError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open, projectId, props.memoryChangeCounter]);

  useEffect(() => {
    if (!props.open || !searchText.trim()) {
      setSearchHits(null);
      return;
    }
    const searchRequestId = ++searchRequestRef.current;
    const debounceTimer = window.setTimeout(() => {
      api
        .searchMemory(searchText, projectId)
        .then((foundHits) => searchRequestId === searchRequestRef.current && setSearchHits(foundHits))
        .catch(props.onError);
    }, 200);
    return () => window.clearTimeout(debounceTimer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchText, projectId, props.open, props.memoryChangeCounter]);

  useEffect(() => {
    if (!props.open) setSheetView({ kind: "list" });
  }, [props.open]);

  const visibleNotes = useMemo(() => {
    const sourceNotes: (MemoryNoteSummary | MemorySearchHit)[] = searchHits ?? noteSummaries;
    return sourceNotes.filter((noteSummary) => scopeFilter === "all" || noteSummary.scope === scopeFilter);
  }, [searchHits, noteSummaries, scopeFilter]);

  const openNote = async (noteRef: MemoryNoteRef) => {
    try {
      const content = await api.readMemoryNote(noteRef).catch((readError) => {
        if (noteRef.path === "HARNOLD.md") return ""; // not created yet
        throw readError;
      });
      setEditorMode("edit");
      setSheetView({ kind: "editor", editor: { noteRef, draftScope: noteRef.scope, draftPath: noteRef.path, content, savedContent: content } });
    } catch (openError) {
      props.onError(openError);
    }
  };

  const startNewNote = () => {
    setEditorMode("edit");
    setSheetView({
      kind: "editor",
      editor: { noteRef: null, draftScope: projectId ? "project" : "workspace", draftPath: "", content: "# \n", savedContent: "" },
    });
  };

  const updateEditor = (changes: Partial<EditorState>) =>
    setSheetView((previous) => (previous.kind === "editor" ? { kind: "editor", editor: { ...previous.editor, ...changes } } : previous));

  const saveNote = async (editor: EditorState) => {
    const noteRef: MemoryNoteRef = editor.noteRef ?? {
      scope: editor.draftScope,
      projectId: editor.draftScope === "project" ? projectId : null,
      path: editor.draftPath.trim() || editor.content.match(/^#\s+(.+)$/m)?.[1]?.trim() || "notiz",
    };
    setSaving(true);
    try {
      const savedPath = await api.saveMemoryNote(noteRef, editor.content);
      updateEditor({ noteRef: { ...noteRef, path: savedPath }, draftPath: savedPath, savedContent: editor.content });
    } catch (saveError) {
      props.onError(saveError);
    } finally {
      setSaving(false);
    }
  };

  const deleteNote = async (noteRef: MemoryNoteRef) => {
    if (!window.confirm(`„${noteRef.path}“ löschen? Die Datei wird entfernt.`)) return;
    try {
      await api.deleteMemoryNote(noteRef);
      setSheetView({ kind: "list" });
    } catch (deleteError) {
      props.onError(deleteError);
    }
  };

  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent className="w-full gap-0 sm:max-w-[640px]">
        <SheetHeader className="border-b">
          <SheetTitle>Memory</SheetTitle>
          <SheetDescription>Markdown-Notizen, die der Agent kennt. Workspace gilt überall, Projekt nur hier.</SheetDescription>
        </SheetHeader>

        {sheetView.kind === "list" && (
          <div key="list" className="flex min-h-0 flex-1 animate-in flex-col fade-in duration-200">
            <div className="flex items-center gap-2 border-b px-4 py-2.5">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input className="h-8 pl-8" placeholder="Suchen …" value={searchText} onChange={(changeEvent) => setSearchText(changeEvent.target.value)} />
              </div>
              <SegmentedControl
                className="w-56"
                options={[
                  { value: "all", label: "Alle" },
                  { value: "project", label: "Projekt" },
                  { value: "workspace", label: "Workspace" },
                ]}
                value={scopeFilter}
                onValueChange={setScopeFilter}
              />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" onClick={() => setSheetView({ kind: "settings" })} aria-label="Memory-Einstellungen">
                    <Settings2 className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Einstellungen</TooltipContent>
              </Tooltip>
            </div>

            <div className="flex-1 overflow-y-auto px-2 py-2">
              <div className="flex gap-1.5 px-2 pb-2">
                <Button size="sm" variant="outline" className="h-7 gap-1.5 text-[12px]" onClick={startNewNote}>
                  <Plus className="size-3.5" /> Neue Notiz
                </Button>
                {props.project && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 gap-1.5 text-[12px] text-muted-foreground"
                    onClick={() => void openNote({ scope: "project", projectId, path: "HARNOLD.md" })}
                  >
                    <FileText className="size-3.5" /> Projekt-Anweisungen
                  </Button>
                )}
              </div>

              {visibleNotes.length === 0 && (
                <p className="px-2 py-6 text-center text-[13px] text-muted-foreground">
                  {searchHits ? "Keine Treffer." : "Noch keine Notizen. Sag dem Agent „merk dir …“ oder leg eine an."}
                </p>
              )}

              {visibleNotes.map((noteSummary) => (
                <button
                  key={`${noteSummary.scope}:${noteSummary.projectId}:${noteSummary.path}`}
                  className="block w-full animate-in rounded-lg px-2.5 py-2 text-left transition-colors duration-150 fade-in hover:bg-foreground/5"
                  onClick={() => void openNote(noteSummary)}
                >
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13.5px] font-medium">{noteSummary.title}</span>
                    <ScopeBadge scope={noteSummary.scope} />
                    <span className="ml-auto shrink-0 text-[11.5px] text-muted-foreground">{formatRelativeTime(noteSummary.modifiedAt)}</span>
                  </div>
                  <div className="truncate font-mono text-[11.5px] text-muted-foreground">{noteSummary.path}</div>
                  {"snippet" in noteSummary && noteSummary.snippet && <Snippet text={noteSummary.snippet} />}
                </button>
              ))}
            </div>
          </div>
        )}

        {sheetView.kind === "editor" && (
          <div key="editor" className="flex min-h-0 flex-1 animate-in flex-col fade-in slide-in-from-right-2 duration-200">
            <div className="flex items-center gap-2 border-b px-3 py-2">
              <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" onClick={() => setSheetView({ kind: "list" })} aria-label="Zurück">
                <ArrowLeft className="size-4" />
              </Button>
              {sheetView.editor.noteRef ? (
                <>
                  <span className="truncate font-mono text-[12.5px]">{sheetView.editor.noteRef.path}</span>
                  <ScopeBadge scope={sheetView.editor.noteRef.scope} />
                </>
              ) : (
                <>
                  <Input
                    className="h-8 flex-1 font-mono text-[12.5px]"
                    placeholder="pfad/zur-notiz.md (leer = aus Titel)"
                    value={sheetView.editor.draftPath}
                    onChange={(changeEvent) => updateEditor({ draftPath: changeEvent.target.value })}
                  />
                  <Select value={sheetView.editor.draftScope} onValueChange={(value) => updateEditor({ draftScope: value as MemoryScope })}>
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
                value={sheetView.editor.content}
                onChange={(changeEvent) => updateEditor({ content: changeEvent.target.value })}
                onKeyDown={(keyboardEvent) => {
                  if ((keyboardEvent.metaKey || keyboardEvent.ctrlKey) && keyboardEvent.key === "s" && sheetView.kind === "editor") {
                    keyboardEvent.preventDefault();
                    void saveNote(sheetView.editor);
                  }
                }}
                className="flex-1 animate-in resize-none bg-transparent px-5 py-4 font-mono text-[13px] leading-relaxed outline-none fade-in duration-150"
                spellCheck={false}
              />
            ) : (
              <div key="preview" className="chat-markdown flex-1 animate-in overflow-y-auto px-5 py-4 text-[14px] leading-relaxed fade-in duration-150">
                <ReactMarkdown>{sheetView.editor.content}</ReactMarkdown>
              </div>
            )}

            <div className="flex items-center gap-2 border-t px-4 py-2.5">
              <Button size="sm" disabled={saving || sheetView.editor.content === sheetView.editor.savedContent} onClick={() => void saveNote(sheetView.editor)}>
                Speichern
              </Button>
              <span className="text-[11.5px] text-muted-foreground transition-opacity duration-150">
                {sheetView.editor.content !== sheetView.editor.savedContent ? "Ungespeichert · ⌘S" : sheetView.editor.noteRef ? "Gespeichert" : ""}
              </span>
              {sheetView.editor.noteRef && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto gap-1.5 text-muted-foreground hover:text-destructive"
                  onClick={() => sheetView.editor.noteRef && void deleteNote(sheetView.editor.noteRef)}
                >
                  <Trash2 className="size-3.5" /> Löschen
                </Button>
              )}
            </div>
          </div>
        )}

        {sheetView.kind === "settings" && (
          <div key="settings" className="flex-1 overflow-y-auto px-4 py-4">
            <MemorySettingsForm onDone={() => setSheetView({ kind: "list" })} onError={props.onError} />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
