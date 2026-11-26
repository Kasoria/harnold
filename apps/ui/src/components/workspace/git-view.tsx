import { useCallback, useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Bot, Check, ChevronDown, ChevronRight, GitBranch, Loader2, Minus, Plus, RotateCcw, RotateCw, Undo2 } from "lucide-react";
import { api } from "@/api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { confirmAction } from "@/components/confirm-dialog";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import type { GitBranches, GitCommit, GitFileChange, GitStatus, Project, ProjectRoot } from "@/types";
import { repositoryRoots, rootKindLabel } from "./project-roots";

/** Folders outside the project folder aren't watched; the view checks on its own while open. */
const statusPollMs = 5000;

/** Branch name with a menu: switch to another branch or create one from the current state. */
function BranchMenu(props: { project: Project; root: string; branch: string | null; disabled: boolean; onSwitched: (status: GitStatus) => void }) {
  const [branches, setBranches] = useState<GitBranches | null>(null);
  const [newBranchName, setNewBranchName] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    api.gitBranches(props.project.id, props.root).then(setBranches).catch(() => setBranches(null));
  }, [menuOpen, props.project.id, props.root]);

  const switchTo = async (branchName: string, create: boolean) => {
    setMenuOpen(false);
    try {
      props.onSwitched(await api.gitSwitchBranch(props.project.id, branchName, create, props.root));
      setNewBranchName("");
      toast.success(create ? t("Branch {0} angelegt", branchName) : t("Gewechselt zu {0}", branchName));
    } catch (switchError) {
      toast.error(switchError instanceof Error ? switchError.message : String(switchError));
    }
  };

  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild disabled={props.disabled}>
        <button type="button" className="flex min-w-0 items-center gap-1 rounded px-1 py-0.5 hover:bg-muted" title={t("Branch wechseln")}>
          <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium">{props.branch ?? t("kein Branch")}</span>
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-96 w-64 overflow-y-auto">
        <div className="p-1">
          <input
            className="h-7 w-full rounded-md border bg-background px-2 text-[12px] outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
            placeholder={t("Neuer Branch …")}
            value={newBranchName}
            onChange={(changeEvent) => setNewBranchName(changeEvent.target.value)}
            onKeyDown={(keyboardEvent) => {
              keyboardEvent.stopPropagation(); // the menu's type-ahead would swallow the letters
              if (keyboardEvent.key === "Enter" && newBranchName.trim()) void switchTo(newBranchName.trim(), true);
            }}
          />
        </div>
        {!branches && (
          <div className="flex justify-center p-2">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        )}
        {branches && branches.local.length > 0 && (
          <>
            <DropdownMenuLabel className="text-[11px] text-muted-foreground">{t("Branches")}</DropdownMenuLabel>
            {branches.local.map((branchName) => (
              <DropdownMenuItem key={branchName} className="text-[12.5px]" disabled={branchName === branches.current} onSelect={() => void switchTo(branchName, false)}>
                <span className="truncate">{branchName}</span>
                {branchName === branches.current && <Check className="ml-auto size-3.5" />}
              </DropdownMenuItem>
            ))}
          </>
        )}
        {branches && branches.remote.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[11px] text-muted-foreground">{t("Auf dem Remote")}</DropdownMenuLabel>
            {branches.remote.map((branchName) => (
              <DropdownMenuItem key={branchName} className="text-[12.5px]" onSelect={() => void switchTo(branchName, false)}>
                <span className="truncate">{branchName}</span>
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Which repository the view shows, when the project has more than one (attached folders, chat worktrees). */
function RepositoryPicker(props: { roots: ProjectRoot[]; selectedRoot: string; onSelectRoot: (rootPath: string) => void }) {
  const choices = repositoryRoots(props.roots);
  if (choices.length < 2) return null;
  const selectedChoice = choices.find((root) => root.path === props.selectedRoot || root.repositoryPath === props.selectedRoot);
  return (
    <div className="shrink-0 border-b p-1.5">
      <Select value={selectedChoice?.path ?? props.selectedRoot} onValueChange={props.onSelectRoot}>
        <SelectTrigger className="h-7 w-full text-[12px]" aria-label={t("Repository")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {choices.map((root) => (
            <SelectItem key={root.path} value={root.path} className="text-[12.5px]">
              <span className="truncate">{root.label}</span>
              <span className="ml-1.5 text-[11px] text-muted-foreground">{rootKindLabel(root)}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

type SelectedFile = { path: string; staged: boolean };

const statusLabels: Record<string, string> = { M: "M", A: "A", D: "D", R: "R", C: "C", U: "U", T: "T", "?": "U" };

function statusColor(statusLetter: string): string {
  if (statusLetter === "A" || statusLetter === "?") return "text-emerald-600 dark:text-emerald-400";
  if (statusLetter === "D") return "text-red-600 dark:text-red-400";
  if (statusLetter === "U") return "text-orange-600 dark:text-orange-400";
  return "text-amber-600 dark:text-amber-400";
}

function statusTitle(statusLetter: string): string {
  const titles: Record<string, string> = {
    M: t("Geändert"),
    A: t("Neu"),
    "?": t("Neu (nicht versioniert)"),
    D: t("Gelöscht"),
    R: t("Umbenannt"),
    U: t("Konflikt"),
  };
  return titles[statusLetter] ?? statusLetter;
}

function relativeTime(timestamp: number): string {
  const minutes = Math.round((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return t("gerade eben");
  if (minutes < 60) return t("vor {0} Min.", String(minutes));
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("vor {0} Std.", String(hours));
  return new Date(timestamp).toLocaleDateString();
}

/** Unified diff with colored lines; git's file headers are left out (the file is named above). */
function UnifiedDiff({ diff }: { diff: string }) {
  const lines = diff.split("\n");
  const firstHunkIndex = lines.findIndex((line) => line.startsWith("@@"));
  const visibleLines = firstHunkIndex >= 0 ? lines.slice(firstHunkIndex) : lines;
  if (/^Binary files/m.test(diff)) return <p className="p-4 text-[13px] text-muted-foreground">{t("Binärdatei, keine Vorschau.")}</p>;
  return (
    <div className="font-mono text-[12px] leading-[1.6]">
      {visibleLines.map((line, lineIndex) => (
        <div
          key={lineIndex}
          className={cn(
            "px-3 whitespace-pre-wrap break-all",
            line.startsWith("@@") && "mt-2 bg-muted/60 text-muted-foreground first:mt-0",
            line.startsWith("+") && "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300",
            line.startsWith("-") && "bg-red-500/10 text-red-800 dark:text-red-300",
            line.startsWith("\\") && "text-muted-foreground italic",
          )}
        >
          {line || " "}
        </div>
      ))}
    </div>
  );
}

function FileRow(props: {
  file: GitFileChange;
  statusLetter: string;
  selected: boolean;
  onSelect: () => void;
  actions: { label: string; icon: React.ReactNode; onClick: () => void }[];
}) {
  const fileName = props.file.path.split("/").pop() ?? props.file.path;
  const directory = props.file.path.slice(0, props.file.path.length - fileName.length).replace(/\/$/, "");
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={props.onSelect}
      onKeyDown={(keyboardEvent) => keyboardEvent.key === "Enter" && props.onSelect()}
      className={cn("group flex h-7 cursor-default items-center gap-1.5 rounded-md px-2 text-[12.5px] hover:bg-muted", props.selected && "bg-muted")}
      title={props.file.originalPath ? `${props.file.originalPath} → ${props.file.path}` : props.file.path}
    >
      <span className="truncate">{fileName}</span>
      {directory && <span className="min-w-0 truncate text-[11.5px] text-muted-foreground">{directory}</span>}
      <span className="ml-auto flex shrink-0 items-center">
        {props.actions.map((action) => (
          <button
            key={action.label}
            type="button"
            title={action.label}
            aria-label={action.label}
            className="hidden rounded p-0.5 text-muted-foreground group-hover:block hover:bg-background hover:text-foreground"
            onClick={(clickEvent) => {
              clickEvent.stopPropagation();
              action.onClick();
            }}
          >
            {action.icon}
          </button>
        ))}
        <span className={cn("w-4 text-center font-mono text-[11px] font-semibold", statusColor(props.statusLetter))} title={statusTitle(props.statusLetter)}>
          {statusLabels[props.statusLetter] ?? props.statusLetter}
        </span>
      </span>
    </div>
  );
}

/** Workspace → Git: changes with diff, stage, commit, push/pull – like the source control panel of an editor. */
export function GitView(props: {
  project: Project;
  roots: ProjectRoot[];
  /** Folder whose repository is shown (ProjectRoot.path). */
  root: string;
  onSelectRoot: (rootPath: string) => void;
  fileChangeCounter: number;
  onAskAgent: (prompt: string) => void;
  onStatusChange?: (changedFileCount: number) => void;
}) {
  const { project, root, onStatusChange } = props;
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [selectedFile, setSelectedFile] = useState<SelectedFile | null>(null);
  const [diff, setDiff] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);

  const applyStatus = useCallback(
    (nextStatus: GitStatus) => {
      setStatus(nextStatus);
      onStatusChange?.(nextStatus.isRepository ? nextStatus.files.length : 0);
    },
    [onStatusChange],
  );

  const refresh = useCallback(
    (quiet = false) => {
      api
        .gitStatus(project.id, root)
        .then(applyStatus)
        .catch((statusError) => !quiet && toast.error(String(statusError instanceof Error ? statusError.message : statusError)));
    },
    [project.id, root, applyStatus],
  );

  // Another repository: start fresh.
  useEffect(() => {
    setStatus(null);
    setSelectedFile(null);
  }, [root]);

  useEffect(() => refresh(), [refresh, props.fileChangeCounter]);

  useEffect(() => {
    const pollTimer = window.setInterval(() => document.visibilityState === "visible" && refresh(true), statusPollMs);
    return () => window.clearInterval(pollTimer);
  }, [refresh]);

  useEffect(() => {
    if (historyOpen) api.gitLog(project.id, root).then(setCommits).catch(() => setCommits([]));
  }, [historyOpen, project.id, root, status]);

  // The selected file disappears from the list once committed or discarded.
  const files = status?.isRepository ? status.files : [];
  const stagedFiles = files.filter((file) => file.staged !== "." && file.staged !== "?");
  const unstagedFiles = files.filter((file) => file.unstaged !== ".");
  const selectionStillListed = selectedFile && (selectedFile.staged ? stagedFiles : unstagedFiles).some((file) => file.path === selectedFile.path);

  useEffect(() => {
    if (!selectedFile || !selectionStillListed) {
      setDiff("");
      return;
    }
    let cancelled = false;
    api
      .gitDiff(project.id, selectedFile.path, selectedFile.staged, root)
      .then(({ diff: fileDiff }) => !cancelled && setDiff(fileDiff))
      .catch(() => !cancelled && setDiff(""));
    return () => {
      cancelled = true;
    };
  }, [project.id, root, selectedFile, selectionStillListed, status]);

  const run = async (actionName: string, action: () => Promise<GitStatus | void>, successMessage?: string) => {
    setBusyAction(actionName);
    try {
      const nextStatus = await action();
      if (nextStatus) applyStatus(nextStatus);
      if (successMessage) toast.success(successMessage);
    } catch (actionError) {
      toast.error(actionError instanceof Error ? actionError.message : String(actionError));
    } finally {
      setBusyAction(null);
    }
  };

  const fileAction = (action: "stage" | "unstage" | "discard", paths: string[]) => run(action, () => api.gitFileAction(project.id, action, paths, root));

  const discard = async (paths: string[]) => {
    const confirmed = await confirmAction({
      title: paths.length === 1 ? t("Änderungen an {0} verwerfen?", paths[0].split("/").pop() ?? paths[0]) : t("{0} Änderungen verwerfen?", String(paths.length)),
      description: t("Neue Dateien werden gelöscht. Das lässt sich nicht rückgängig machen."),
      confirmLabel: t("Verwerfen"),
    });
    if (confirmed) await fileAction("discard", paths);
  };

  const commit = () =>
    run("commit", async () => {
      const { commit: createdCommit, status: nextStatus } = await api.gitCommit(project.id, commitMessage, root);
      setCommitMessage("");
      toast.success(t("Committet: {0}", createdCommit.subject));
      return nextStatus;
    });

  if (!status) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!status.isRepository) {
    const rootLabel = props.roots.find((candidate) => candidate.path === root)?.label ?? project.name;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-[13px] text-muted-foreground">
        <GitBranch className="size-6 opacity-60" />
        {status.gitAvailable ? (
          <>
            <p>{t("{0} ist noch kein Git-Repository.", rootLabel)}</p>
            <Button size="sm" variant="secondary" disabled={busyAction !== null} onClick={() => run("init", () => api.gitRemoteAction(project.id, "init", root))}>
              {t("Repository anlegen")}
            </Button>
          </>
        ) : (
          <p>{t("Git ist auf diesem Rechner nicht installiert.")}</p>
        )}
      </div>
    );
  }

  const nothingStaged = stagedFiles.length === 0;

  return (
    <div className="absolute inset-0 flex min-h-0">
      <aside className="flex w-72 shrink-0 flex-col border-r bg-background">
        <RepositoryPicker roots={props.roots} selectedRoot={root} onSelectRoot={props.onSelectRoot} />
        <div className="flex h-10 shrink-0 items-center gap-1 border-b px-2 text-[12.5px]">
          <BranchMenu project={project} root={root} branch={status.branch} disabled={busyAction !== null} onSwitched={applyStatus} />
          {status.operationInProgress && <span className="rounded bg-orange-500/15 px-1.5 text-[11px] text-orange-700 dark:text-orange-300">{status.operationInProgress}</span>}
          <span className="ml-auto flex items-center">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-1.5 text-[12px] text-muted-foreground"
              title={t("Pull")}
              disabled={busyAction !== null || !status.upstream}
              onClick={() => run("pull", () => api.gitRemoteAction(project.id, "pull", root), t("Auf dem neuesten Stand"))}
            >
              {busyAction === "pull" ? <Loader2 className="size-3.5 animate-spin" /> : <ArrowDown className="size-3.5" />}
              {status.behind > 0 && <span className="tabular-nums">{status.behind}</span>}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-1.5 text-[12px] text-muted-foreground"
              title={status.upstream ? t("Push") : t("Push (Branch veröffentlichen)")}
              disabled={busyAction !== null || !status.branch}
              onClick={() => run("push", () => api.gitRemoteAction(project.id, "push", root), t("Gepusht"))}
            >
              {busyAction === "push" ? <Loader2 className="size-3.5 animate-spin" /> : <ArrowUp className="size-3.5" />}
              {status.ahead > 0 && <span className="tabular-nums">{status.ahead}</span>}
            </Button>
            <Button variant="ghost" size="icon" className="size-7 text-muted-foreground" title={t("Aktualisieren")} aria-label={t("Aktualisieren")} onClick={() => refresh()}>
              <RotateCw className="size-3.5" />
            </Button>
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {!files.length && <p className="p-2 text-[12.5px] text-muted-foreground">{t("Keine Änderungen.")}</p>}
          {stagedFiles.length > 0 && (
            <section className="mb-2">
              <div className="group flex h-6 items-center px-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                {t("Vorgemerkt")} · {stagedFiles.length}
                <button type="button" className="ml-auto hidden rounded p-0.5 group-hover:block hover:bg-muted" title={t("Alle zurücknehmen")} onClick={() => fileAction("unstage", stagedFiles.map((file) => file.path))}>
                  <Minus className="size-3.5" />
                </button>
              </div>
              {stagedFiles.map((file) => (
                <FileRow
                  key={`staged-${file.path}`}
                  file={file}
                  statusLetter={file.staged}
                  selected={selectedFile?.staged === true && selectedFile.path === file.path}
                  onSelect={() => setSelectedFile({ path: file.path, staged: true })}
                  actions={[{ label: t("Zurücknehmen"), icon: <Minus className="size-3.5" />, onClick: () => fileAction("unstage", [file.path]) }]}
                />
              ))}
            </section>
          )}
          {unstagedFiles.length > 0 && (
            <section>
              <div className="group flex h-6 items-center px-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                {t("Änderungen")} · {unstagedFiles.length}
                <span className="ml-auto hidden items-center group-hover:flex">
                  <button type="button" className="rounded p-0.5 hover:bg-muted" title={t("Alle verwerfen")} onClick={() => discard(unstagedFiles.map((file) => file.path))}>
                    <Undo2 className="size-3.5" />
                  </button>
                  <button type="button" className="rounded p-0.5 hover:bg-muted" title={t("Alle vormerken")} onClick={() => fileAction("stage", unstagedFiles.map((file) => file.path))}>
                    <Plus className="size-3.5" />
                  </button>
                </span>
              </div>
              {unstagedFiles.map((file) => (
                <FileRow
                  key={`unstaged-${file.path}`}
                  file={file}
                  statusLetter={file.unstaged}
                  selected={selectedFile?.staged === false && selectedFile.path === file.path}
                  onSelect={() => setSelectedFile({ path: file.path, staged: false })}
                  actions={[
                    { label: t("Verwerfen"), icon: <Undo2 className="size-3.5" />, onClick: () => discard([file.path]) },
                    { label: t("Vormerken"), icon: <Plus className="size-3.5" />, onClick: () => fileAction("stage", [file.path]) },
                  ]}
                />
              ))}
            </section>
          )}
        </div>

        <div className="shrink-0 border-t p-2">
          <Textarea
            value={commitMessage}
            onChange={(changeEvent) => setCommitMessage(changeEvent.target.value)}
            placeholder={t("Commit-Nachricht")}
            className="min-h-16 text-[12.5px]"
            onKeyDown={(keyboardEvent) => {
              if ((keyboardEvent.metaKey || keyboardEvent.ctrlKey) && keyboardEvent.key === "Enter" && commitMessage.trim() && files.length) {
                keyboardEvent.preventDefault();
                void commit();
              }
            }}
          />
          <div className="mt-2 flex gap-1.5">
            <Button size="sm" className="h-7 flex-1 text-[12px]" disabled={!commitMessage.trim() || !files.length || busyAction !== null} onClick={commit} title="⌘↵">
              {busyAction === "commit" && <Loader2 className="size-3.5 animate-spin" />}
              {nothingStaged ? t("Alles committen") : t("Committen")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-[12px]"
              disabled={!files.length}
              title={t("Der Agent prüft die Änderungen und committet mit passender Nachricht")}
              onClick={() =>
                props.onAskAgent(
                  (root === project.path ? "" : t("Im Repository {0}: ", root)) +
                  (nothingStaged
                    ? t("Sieh dir die aktuellen Git-Änderungen an und committe sie mit einer passenden Commit-Nachricht (bei Bedarf in sinnvolle einzelne Commits aufgeteilt). Nicht pushen.")
                    : t("Sieh dir die vorgemerkten Git-Änderungen an und committe sie mit einer passenden Commit-Nachricht. Nicht pushen.")),
                )
              }
            >
              <Bot className="size-3.5" /> {t("Agent")}
            </Button>
          </div>
        </div>

        <Collapsible open={historyOpen} onOpenChange={setHistoryOpen} className="shrink-0 border-t">
          <CollapsibleTrigger className="flex h-8 w-full items-center gap-1.5 px-3 text-[12px] text-muted-foreground hover:text-foreground">
            <ChevronRight className={cn("size-3.5 transition-transform", historyOpen && "rotate-90")} />
            {t("Verlauf")}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="max-h-56 overflow-y-auto px-1.5 pb-1.5">
              {commits.map((gitCommit) => (
                <li key={gitCommit.hash} className="rounded-md px-2 py-1 text-[12px] hover:bg-muted" title={`${gitCommit.hash.slice(0, 7)} · ${gitCommit.author}`}>
                  <div className="truncate">{gitCommit.subject}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {gitCommit.hash.slice(0, 7)} · {gitCommit.author} · {relativeTime(gitCommit.date)}
                  </div>
                </li>
              ))}
              {!commits.length && <li className="px-2 py-1 text-[12px] text-muted-foreground">{t("Noch keine Commits.")}</li>}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      </aside>

      <div className="min-w-0 flex-1 overflow-auto bg-background">
        {selectedFile && selectionStillListed ? (
          <>
            <div className="sticky top-0 z-10 flex h-10 items-center gap-2 border-b bg-background px-3 text-[12.5px]">
              <span className="truncate font-medium">{selectedFile.path}</span>
              <span className="text-muted-foreground">{selectedFile.staged ? t("vorgemerkt") : t("nicht vorgemerkt")}</span>
              {!selectedFile.staged && (
                <Button variant="ghost" size="sm" className="ml-auto h-7 text-[12px] text-muted-foreground" onClick={() => discard([selectedFile.path])}>
                  <RotateCcw className="size-3.5" /> {t("Verwerfen")}
                </Button>
              )}
            </div>
            <div className="py-2">{diff ? <UnifiedDiff diff={diff} /> : <p className="p-4 text-[13px] text-muted-foreground">{t("Keine Unterschiede.")}</p>}</div>
          </>
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-center text-[13px] text-muted-foreground">
            {files.length ? t("Datei wählen, um die Änderungen zu sehen.") : t("Alles committet.")}
          </div>
        )}
      </div>
    </div>
  );
}
