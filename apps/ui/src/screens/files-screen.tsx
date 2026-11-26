import { useCallback, useEffect, useMemo, useState } from "react";
import { BookmarkPlus, Copy, ExternalLink, MessageSquare, RefreshCw, Search, Sparkles, Trash2 } from "lucide-react";
import { api } from "@/api";
import type { Environment, ManagedFile, ManagedFileKind, MemoryScope } from "@/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { OptionSelect } from "@/components/option-select";
import { formatRelativeTime } from "@/components/form-field";
import { confirmAction } from "@/components/confirm-dialog";
import { fileIconFor, formatFileSize, isImagePath } from "@/components/chat/attachment-views";
import { EmptyState, MasterDetail, ScreenLayout } from "./screen-layout";
import { t } from "@/lib/i18n";
import { Combobox } from "@/components/ui/combobox";

type FilesScreenProps = {
  environments: Environment[];
  onOpenSession: (projectId: string, sessionId: string) => void;
  onError: (unknownError: unknown) => void;
  onInfo: (message: string) => void;
};

type KindFilter = "all" | ManagedFileKind;
type StatusFilter = "all" | "orphaned" | "duplicates";
type SortOrder = "newest" | "largest";

const kindLabels: Record<ManagedFileKind, string> = { attachment: t("Anhang"), generated: t("Generiert"), memory: t("Memory") };
const sumSize = (files: ManagedFile[]) => files.reduce((total, file) => total + file.size, 0);

function Badge(props: { tone: "warning" | "muted"; children: React.ReactNode }) {
  return (
    <span className={cn("shrink-0 rounded px-1.5 py-px text-[10.5px] font-medium", props.tone === "warning" ? "bg-status-waiting/20 text-foreground" : "bg-muted text-muted-foreground")}>
      {props.children}
    </span>
  );
}

function FileThumbnail({ file }: { file: ManagedFile }) {
  const TypeIcon = fileIconFor(file.mimeType, file.name);
  if (isImagePath(file.name)) return <img src={api.managedFileUrl(file.id)} alt="" loading="lazy" className="size-9 shrink-0 rounded-md border bg-muted object-cover" />;
  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
      <TypeIcon className="size-4 text-muted-foreground" />
    </span>
  );
}

/** Every file Harnold created (attachments, generated images, memory files) across projects – find, reuse, clean up. */
export function FilesScreen(props: FilesScreenProps) {
  const [files, setFiles] = useState<ManagedFile[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [ownerFilter, setOwnerFilter] = useState("all");
  const [sortOrder, setSortOrder] = useState<SortOrder>("newest");
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [checkedFileIds, setCheckedFileIds] = useState<Set<string>>(new Set());
  const { onError } = props;

  const reload = useCallback(() => {
    setLoading(true);
    api
      .listManagedFiles()
      .then((loadedFiles) => {
        setFiles(loadedFiles);
        setCheckedFileIds((previous) => new Set([...previous].filter((fileId) => loadedFiles.some((file) => file.id === fileId))));
      })
      .catch(onError)
      .finally(() => setLoading(false));
  }, [onError]);
  useEffect(reload, [reload]);

  const allFiles = useMemo(() => files ?? [], [files]);
  const owners = useMemo(() => [...new Map(allFiles.map((file) => [`${file.scope}|${file.ownerId}`, file.ownerName])).entries()], [allFiles]);
  const orphanedFiles = useMemo(() => allFiles.filter((file) => file.orphaned), [allFiles]);
  const duplicateFiles = useMemo(() => allFiles.filter((file) => file.duplicateGroup), [allFiles]);

  const visibleFiles = useMemo(() => {
    const searchTerm = searchText.trim().toLowerCase();
    return allFiles
      .filter((file) => kindFilter === "all" || file.kind === kindFilter)
      .filter((file) => statusFilter === "all" || (statusFilter === "orphaned" ? file.orphaned : Boolean(file.duplicateGroup)))
      .filter((file) => ownerFilter === "all" || `${file.scope}|${file.ownerId}` === ownerFilter)
      .filter((file) => !searchTerm || file.path.toLowerCase().includes(searchTerm) || file.sessions.some((session) => session.title.toLowerCase().includes(searchTerm)))
      .sort((first, second) => (sortOrder === "largest" ? second.size - first.size : second.modifiedAt - first.modifiedAt));
  }, [allFiles, kindFilter, statusFilter, ownerFilter, searchText, sortOrder]);

  const selectedFile = allFiles.find((file) => file.id === selectedFileId) ?? null;
  const checkedFiles = allFiles.filter((file) => checkedFileIds.has(file.id));

  const deleteFiles = async (filesToDelete: ManagedFile[], title: string) => {
    if (!filesToDelete.length) return;
    const canvasCount = filesToDelete.filter((file) => file.usedIn.includes("Canvas")).length;
    const confirmed = await confirmAction({
      title,
      description: [
        t("{0} werden endgültig gelöscht.", formatFileSize(sumSize(filesToDelete))),
        canvasCount ? (canvasCount === 1 ? t("Ein Bild verschwindet dabei auch vom Canvas.") : t("{0} Bilder verschwinden dabei auch vom Canvas.", canvasCount)) : "",
      ]
        .filter(Boolean)
        .join(" "),
    });
    if (!confirmed) return;
    try {
      const { removedCount } = await api.deleteManagedFiles(filesToDelete.map((file) => file.id));
      props.onInfo(removedCount === 1 ? t("1 Datei gelöscht") : t("{0} Dateien gelöscht", removedCount));
      if (selectedFileId && filesToDelete.some((file) => file.id === selectedFileId)) setSelectedFileId(null);
      setCheckedFileIds(new Set());
      reload();
    } catch (deleteError) {
      onError(deleteError);
    }
  };

  const copyToMemory = async (file: ManagedFile, scope: MemoryScope) => {
    try {
      const savedFile = await api.copyFileToMemory(file.id, scope, scope === "workspace" ? null : file.projectId);
      props.onInfo(t("Ins Gedächtnis übernommen: {0}", savedFile.path));
      reload();
    } catch (copyError) {
      onError(copyError);
    }
  };

  const toggleChecked = (fileId: string) =>
    setCheckedFileIds((previous) => {
      const next = new Set(previous);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      return next;
    });

  const list = (
    <div className="flex h-full flex-col">
      <div className="grid gap-2 border-b p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input className="h-8 pl-8" placeholder={t("Name, Pfad oder Session …")} value={searchText} onChange={(changeEvent) => setSearchText(changeEvent.target.value)} />
        </div>
        <div className="flex gap-2">
          <Combobox
            size="sm"
            className="h-8 min-w-0 flex-1 text-[12.5px]"
            value={ownerFilter}
            options={[{ value: "all", label: t("Alle Orte") }, ...owners.map(([ownerKey, ownerName]) => ({ value: ownerKey, label: ownerName }))]}
            onValueChange={setOwnerFilter}
          />
          <Select value={sortOrder} onValueChange={(value) => setSortOrder(value as SortOrder)}>
            <SelectTrigger size="sm" className="h-8 w-28 text-[12.5px]" aria-label={t("Sortierung")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">{t("Neueste")}</SelectItem>
              <SelectItem value="largest">{t("Größte")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <OptionSelect
          ariaLabel={t("Status")}
          options={[
            { value: "all", label: t("Alle Dateien") },
            { value: "orphaned", label: orphanedFiles.length ? t("Verwaist ({0})", String(orphanedFiles.length)) : t("Verwaist") },
            { value: "duplicates", label: duplicateFiles.length ? t("Doppelt ({0})", String(duplicateFiles.length)) : t("Doppelt") },
          ]}
          value={statusFilter}
          onValueChange={setStatusFilter}
        />
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {files === null ? (
          <p className="px-2 py-6 text-center text-[12.5px] text-muted-foreground">{t("Lädt …")}</p>
        ) : visibleFiles.length === 0 ? (
          <p className="px-2 py-6 text-center text-[12.5px] text-muted-foreground">{allFiles.length ? t("Keine Treffer.") : t("Noch keine Dateien.")}</p>
        ) : (
          visibleFiles.map((file) => (
            <div
              key={file.id}
              role="button"
              tabIndex={0}
              onClick={() => setSelectedFileId(file.id)}
              onKeyDown={(keyboardEvent) => keyboardEvent.key === "Enter" && setSelectedFileId(file.id)}
              className={cn(
                "group/file flex w-full cursor-default items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors duration-150 outline-none focus-visible:ring-1 focus-visible:ring-ring/50",
                selectedFileId === file.id ? "bg-foreground/[0.07]" : "hover:bg-foreground/[0.04]",
              )}
            >
              <input
                type="checkbox"
                aria-label={t("{0} auswählen", file.name)}
                checked={checkedFileIds.has(file.id)}
                onClick={(clickEvent) => clickEvent.stopPropagation()}
                onChange={() => toggleChecked(file.id)}
                className={cn("size-3.5 shrink-0 transition-opacity duration-150", checkedFileIds.size ? "opacity-100" : "opacity-0 group-hover/file:opacity-100 focus-visible:opacity-100")}
              />
              <FileThumbnail file={file} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-[13px] font-medium">{file.name}</span>
                  {file.orphaned && <Badge tone="warning">{t("Verwaist")}</Badge>}
                  {file.duplicateGroup && <Badge tone="muted">{t("Doppelt")}</Badge>}
                </span>
                <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span className="truncate">
                    {file.ownerName} · {kindLabels[file.kind]}
                  </span>
                  <span className="ml-auto shrink-0 tabular-nums">{formatFileSize(file.size)}</span>
                </span>
              </span>
            </div>
          ))
        )}
      </div>

      {checkedFiles.length > 0 && (
        <div className="flex animate-in items-center gap-2 border-t px-3 py-2 text-[12px] fade-in slide-in-from-bottom-1 duration-150">
          <span className="text-muted-foreground">
            {checkedFiles.length} {t("ausgewählt ·")} {formatFileSize(sumSize(checkedFiles))}
          </span>
          <Button size="sm" variant="ghost" className="ml-auto h-7 px-2 text-[12px]" onClick={() => setCheckedFileIds(new Set())}>
            {t("Abwählen")}
          </Button>
          <Button size="sm" variant="destructive" className="h-7 gap-1.5 px-2 text-[12px]" onClick={() => void deleteFiles(checkedFiles, checkedFiles.length === 1 ? t("1 Datei löschen?") : t("{0} Dateien löschen?", checkedFiles.length))}>
            <Trash2 className="size-3.5" /> {t("Löschen")}
          </Button>
        </div>
      )}
    </div>
  );

  const environmentOfProject = (projectId: string | null) => (projectId ? props.environments.find((environment) => environment.projectIds.includes(projectId)) : undefined);

  const detail = !selectedFile ? (
    <EmptyState
      title={files ? t("{0} Dateien · {1}", allFiles.length, formatFileSize(sumSize(allFiles))) : t("Dateien")}
      description={
        orphanedFiles.length
          ? t("{0} davon verwaist ({1}): Anhänge und Bilder, auf die keine Session und keine Design-Datei mehr verweist.", orphanedFiles.length, formatFileSize(sumSize(orphanedFiles)))
          : t("Anhänge, generierte Bilder und Memory-Dateien aus allen Projekten.")
      }
      action={
        orphanedFiles.length > 0 && (
          <Button size="sm" variant="secondary" className="gap-1.5" onClick={() => void deleteFiles(orphanedFiles, t("{0} verwaiste Dateien löschen?", orphanedFiles.length))}>
            <Sparkles className="size-3.5" /> {t("Verwaiste aufräumen")}
          </Button>
        )
      }
    />
  ) : (
    <div key={selectedFile.id} className="flex h-full animate-in flex-col fade-in duration-200">
      <div className="flex items-center gap-2 border-b px-4 py-2">
        <span className="truncate font-mono text-[12.5px]">{selectedFile.path}</span>
        <span className="text-[11.5px] text-muted-foreground">{selectedFile.ownerName}</span>
        <div className="ml-auto flex items-center gap-1">
          <Button size="icon" variant="ghost" className="size-7 text-muted-foreground" asChild>
            <a href={api.managedFileUrl(selectedFile.id)} target="_blank" rel="noreferrer" aria-label={t("In neuem Tab öffnen")}>
              <ExternalLink className="size-3.5" />
            </a>
          </Button>
          {selectedFile.kind !== "memory" && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="secondary" className="h-7 gap-1.5 px-2 text-[12px]">
                  <BookmarkPlus className="size-3.5" /> {t("Als Kontext")}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {selectedFile.projectId && (
                  <DropdownMenuItem className="text-[13px]" onSelect={() => void copyToMemory(selectedFile, "project")}>
                    {t("Projekt-Gedächtnis")}
                  </DropdownMenuItem>
                )}
                {environmentOfProject(selectedFile.projectId) && (
                  <DropdownMenuItem className="text-[13px]" onSelect={() => void copyToMemory(selectedFile, "environment")}>
                    {t("Umgebung „")}{environmentOfProject(selectedFile.projectId)?.name}“
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem className="text-[13px]" onSelect={() => void copyToMemory(selectedFile, "workspace")}>
                  {t("Workspace-Gedächtnis")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Button
            size="icon"
            variant="ghost"
            className="size-7 text-muted-foreground hover:text-destructive"
            aria-label={t("Löschen")}
            onClick={() => void deleteFiles([selectedFile], t("„{0}“ löschen?", selectedFile.name))}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto bg-muted/30">
        {isImagePath(selectedFile.name) ? (
          <img src={api.managedFileUrl(selectedFile.id)} alt={selectedFile.name} className="mx-auto max-h-full max-w-full object-contain p-6" />
        ) : selectedFile.mimeType === "application/pdf" || selectedFile.mimeType.startsWith("text/") ? (
          <iframe src={api.managedFileUrl(selectedFile.id)} title={selectedFile.name} className="size-full border-0 bg-background" />
        ) : (
          <EmptyState title={t("Keine Vorschau")} description={t("Über das Pfeil-Symbol oben öffnen.")} />
        )}
      </div>

      <dl className="grid shrink-0 grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 border-t px-4 py-3 text-[12.5px]">
        <dt className="text-muted-foreground">{t("Art · Größe")}</dt>
        <dd>
          {kindLabels[selectedFile.kind]} · {formatFileSize(selectedFile.size)} · {formatRelativeTime(selectedFile.modifiedAt)}
        </dd>
        {selectedFile.kind !== "memory" && (
          <>
            <dt className="text-muted-foreground">{t("Aus Session")}</dt>
            <dd className="flex flex-wrap gap-1">
              {selectedFile.sessions.length ? (
                selectedFile.sessions.map((session) => (
                  <button
                    key={session.id}
                    type="button"
                    onClick={() => selectedFile.projectId && props.onOpenSession(selectedFile.projectId, session.id)}
                    className="inline-flex max-w-56 items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[12px] transition-colors duration-150 hover:bg-foreground/[0.08]"
                  >
                    <MessageSquare className="size-3 shrink-0" /> <span className="truncate">{session.title}</span>
                  </button>
                ))
              ) : (
                <span className="text-muted-foreground">{t("keine mehr – Session gelöscht")}</span>
              )}
            </dd>
            <dt className="text-muted-foreground">{t("Verwendet in")}</dt>
            <dd>{selectedFile.usedIn.length ? selectedFile.usedIn.join(", ") : <span className="text-muted-foreground">nirgends</span>}</dd>
          </>
        )}
        {selectedFile.duplicateGroup && (
          <>
            <dt className="text-muted-foreground">{t("Doppelt")}</dt>
            <dd className="flex flex-wrap gap-1">
              {allFiles
                .filter((file) => file.duplicateGroup === selectedFile.duplicateGroup && file.id !== selectedFile.id)
                .map((duplicateFile) => (
                  <button
                    key={duplicateFile.id}
                    type="button"
                    onClick={() => setSelectedFileId(duplicateFile.id)}
                    className="inline-flex max-w-56 items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[12px] transition-colors duration-150 hover:bg-foreground/[0.08]"
                  >
                    <Copy className="size-3 shrink-0" /> <span className="truncate">{duplicateFile.ownerName}: {duplicateFile.path}</span>
                  </button>
                ))}
            </dd>
          </>
        )}
      </dl>
    </div>
  );

  return (
    <ScreenLayout
      title={t("Dateien")}
      tabs={
        <OptionSelect
          quiet
          ariaLabel={t("Art")}
          options={[
            { value: "all", label: t("Alle Arten") },
            { value: "attachment", label: t("Anhänge") },
            { value: "generated", label: t("Generiert") },
            { value: "memory", label: t("Memory") },
          ]}
          value={kindFilter}
          onValueChange={setKindFilter}
        />
      }
      actions={
        <Button size="sm" variant="ghost" className="gap-1.5 text-muted-foreground" disabled={loading} aria-label={t("Aktualisieren")} onClick={reload}>
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} /> <span className="max-md:hidden">{t("Aktualisieren")}</span>
        </Button>
      }
    >
      <MasterDetail list={list} detail={detail} listClassName="w-96 overflow-hidden p-0" detailOpen={Boolean(selectedFile)} onBack={() => setSelectedFileId(null)} />
    </ScreenLayout>
  );
}
