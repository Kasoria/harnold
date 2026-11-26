import { useEffect, useState } from "react";
import { GitBranch, GitMerge, Loader2, Trash2 } from "lucide-react";
import { api } from "@/api";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { confirmWithOption } from "@/components/confirm-dialog";
import { repositoryRoots, useProjectRoots } from "@/components/workspace/project-roots";
import { t } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import type { Project, Session, WorktreeStatus } from "@/types";

/**
 * Own worktree per chat: before the first message the chat can get its own checkout on its own branch,
 * so parallel chats don't overwrite each other. Afterwards: apply (merge back) or remove.
 */
export function WorktreeControl(props: { project: Project; session: Session; hasMessages: boolean; running: boolean }) {
  const { project, session } = props;
  const roots = useProjectRoots(project, session.id);
  const repositories = repositoryRoots(roots.filter((root) => root.kind !== "worktree"));
  const [menuOpen, setMenuOpen] = useState(false);
  const [status, setStatus] = useState<WorktreeStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (menuOpen && session.worktree) api.sessionWorktree(session.id).then(({ worktree }) => setStatus(worktree)).catch(() => setStatus(null));
  }, [menuOpen, session.id, session.worktree]);

  const run = async (action: () => Promise<unknown>, successMessage: string) => {
    setBusy(true);
    try {
      await action();
      toast.success(successMessage);
    } catch (actionError) {
      toast.error(actionError instanceof Error ? actionError.message : String(actionError));
    } finally {
      setBusy(false);
    }
  };

  const removeWorktree = async () => {
    const result = await confirmWithOption({
      title: t("Worktree entfernen?"),
      description: t("Offene Änderungen werden vorher auf dem Branch {0} committet, nichts geht verloren. Der Chat arbeitet danach wieder direkt im Ordner.", session.worktree?.branch ?? ""),
      confirmLabel: t("Entfernen"),
      option: { label: t("Branch auch löschen"), hint: t("Verwirft die Arbeit dieses Chats, wenn sie nicht übernommen wurde.") },
    });
    if (result.confirmed) await run(() => api.removeSessionWorktree(session.id, result.optionChecked), t("Worktree entfernt"));
  };

  if (session.worktree) {
    const worktree = session.worktree;
    return (
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-7 max-w-56 gap-1.5 px-2 text-[12px] text-muted-foreground" title={worktree.path}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <GitBranch className="size-3.5" />}
            <span className="truncate">{worktree.branch}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          <DropdownMenuLabel className="text-[11.5px] font-normal text-muted-foreground">
            {t("Eigener Worktree, abgezweigt von {0}", worktree.baseBranch ?? "HEAD")}
            {status && (
              <span className="mt-0.5 block">
                {status.commitsAhead > 0 && t("{0} Commits", String(status.commitsAhead))}
                {status.commitsAhead > 0 && status.uncommittedChanges && " · "}
                {status.uncommittedChanges && t("offene Änderungen")}
                {!status.commitsAhead && !status.uncommittedChanges && t("noch keine Änderungen")}
              </span>
            )}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-[12.5px]"
            disabled={busy || props.running}
            onSelect={() => void run(() => api.applySessionWorktree(session.id), t("In {0} übernommen", worktree.baseBranch ?? "HEAD"))}
          >
            <GitMerge className="size-3.5" /> {t("In {0} übernehmen", worktree.baseBranch ?? "HEAD")}
          </DropdownMenuItem>
          <DropdownMenuItem className="text-[12.5px]" disabled={busy || props.running} onSelect={() => void removeWorktree()}>
            <Trash2 className="size-3.5" /> {t("Worktree entfernen …")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  // Only before the first message: the agent's conversation is tied to its working folder.
  if (props.hasMessages || !repositories.length) return null;
  const createIn = (folder: string) => void run(() => api.createSessionWorktree(session.id, folder), t("Worktree angelegt"));

  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-[12px] text-muted-foreground" disabled={busy} title={t("In eigenem Worktree arbeiten")}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <GitBranch className="size-3.5" />}
          {t("Worktree")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel className="text-[11.5px] font-normal text-muted-foreground">
          {t("Der Chat arbeitet auf einem eigenen Branch in einer eigenen Kopie. Parallele Chats kommen sich so nicht in die Quere.")}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {repositories.map((root) => (
          <DropdownMenuItem key={root.path} className="text-[12.5px]" onSelect={() => createIn(root.path)}>
            <GitBranch className="size-3.5" />
            <span className="truncate">{repositories.length > 1 ? t("Worktree von {0}", root.label) : t("Eigenen Worktree anlegen")}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
