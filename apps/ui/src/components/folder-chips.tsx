import { Folder, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { pickFolder } from "@/lib/folder-picker";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export type FolderChip = { path: string; scope?: "project" | "environment" | "workspace"; exists?: boolean };

const scopeLabels: Record<"project" | "environment" | "workspace", string> = {
  project: t("Projekt"),
  environment: t("Umgebung"),
  workspace: t("Workspace"),
};

/**
 * Folders Harnold may work in, as chips with an add button. Removing a chip takes the folder
 * out of this list only – nothing on disk changes.
 */
export function FolderChips(props: {
  folders: FolderChip[];
  /** Omit to hide the add button. */
  onAdd?: (folderPath: string) => void | Promise<void>;
  onRemove?: (folderPath: string) => void | Promise<void>;
  addTitle?: string;
  className?: string;
}) {
  const addFolder = async () => {
    const pickedFolder = await pickFolder(props.addTitle ?? t("Ordner hinzufügen"));
    if (pickedFolder) await props.onAdd?.(pickedFolder);
  };
  const removable = Boolean(props.onRemove);
  if (!props.folders.length && !props.onAdd) return null;
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", props.className)}>
      {props.folders.map((folder) => (
        <span
          key={folder.path}
          title={folder.scope ? `${folder.path} · ${scopeLabels[folder.scope]}` : folder.path}
          className={cn(
            "flex max-w-64 items-center gap-1.5 rounded-md border bg-foreground/[0.03] py-0.5 pr-1 pl-2 text-[12px]",
            folder.exists === false && "border-destructive/40 text-destructive",
          )}
        >
          <Folder className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-mono">{folder.path.replace(/^\/Users\/[^/]+/, "~")}</span>
          {folder.scope && props.onRemove && <span className="shrink-0 text-[10.5px] text-muted-foreground">{scopeLabels[folder.scope]}</span>}
          {removable && (
            <button
              type="button"
              className="rounded p-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
              aria-label={t("Ordner entfernen")}
              onClick={() => props.onRemove?.(folder.path)}
            >
              <X className="size-3" />
            </button>
          )}
        </span>
      ))}
      {props.onAdd && (
        <Button size="sm" variant="ghost" className="h-6 gap-1 px-1.5 text-[12px] text-muted-foreground hover:text-foreground" onClick={() => void addFolder()}>
          <Plus className="size-3.5" /> {t("Ordner")}
        </Button>
      )}
    </div>
  );
}
