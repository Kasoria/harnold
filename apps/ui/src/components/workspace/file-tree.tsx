import { useEffect, useState } from "react";
import { AtSign, ChevronRight, File, Folder, FolderGit2, GitBranch, LayoutDashboard, Loader2 } from "lucide-react";
import { canvasDragType, type CanvasAddItem } from "@/components/canvas/project-canvas";
import { api } from "@/api";
import type { DirectoryEntry, Project, ProjectRoot } from "@/types";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { rootKindLabel } from "./project-roots";

/** A file in one of the project's folders: root = ProjectRoot.path, path relative to it. */
export type FileSelection = { root: string; path: string };

type TreeContext = {
  project: Project;
  root: string;
  selected: FileSelection | null;
  refreshKey: number;
  onSelect: (selection: FileSelection) => void;
  onReference: (selection: FileSelection) => void;
  /** Set while the canvas is shown: a button per row places the file/folder on it. */
  onPlaceOnCanvas?: (item: CanvasAddItem) => void;
};

/** Every row can be dragged onto the canvas. */
function dragOntoCanvas(item: CanvasAddItem) {
  return {
    draggable: true,
    onDragStart: (dragEvent: React.DragEvent) => {
      dragEvent.dataTransfer.setData(canvasDragType, JSON.stringify(item));
      dragEvent.dataTransfer.setData("text/plain", item.path);
      dragEvent.dataTransfer.effectAllowed = "copy";
    },
  };
}

function RowAction(props: { label: string; onActivate: () => void; children: React.ReactNode }) {
  return (
    <span
      role="button"
      tabIndex={0}
      title={props.label}
      aria-label={props.label}
      onClick={(clickEvent) => {
        clickEvent.stopPropagation();
        props.onActivate();
      }}
      onKeyDown={(keyboardEvent) => {
        if (keyboardEvent.key === "Enter") {
          keyboardEvent.stopPropagation();
          props.onActivate();
        }
      }}
      className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity duration-150 group-hover/file:opacity-100 hover:bg-foreground/10 hover:text-foreground"
    >
      {props.children}
    </span>
  );
}

const rowClassName =
  "group/file flex h-6 w-full items-center gap-1.5 rounded-md pr-1 text-left text-[12.5px] transition-colors duration-150 hover:bg-foreground/5";

/** One level, loaded when it is shown (and again after file changes). */
function DirectoryLevel(props: TreeContext & { directoryPath: string; depth: number }) {
  const [entries, setEntries] = useState<DirectoryEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .readDirectory(props.project.id, props.root, props.directoryPath)
      .then((loadedEntries) => {
        if (cancelled) return;
        setEntries(loadedEntries);
        setLoadError(null);
      })
      .catch((directoryError) => !cancelled && setLoadError(directoryError instanceof Error ? directoryError.message : String(directoryError)));
    return () => {
      cancelled = true;
    };
  }, [props.project.id, props.root, props.directoryPath, props.refreshKey]);

  const indent = 4 + props.depth * 12;
  if (loadError) return <p className="py-0.5 text-[12px] text-muted-foreground" style={{ paddingLeft: indent + 16 }}>{loadError}</p>;
  if (!entries) {
    return (
      <div className="flex h-6 items-center" style={{ paddingLeft: indent + 16 }}>
        <Loader2 className="size-3 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!entries.length) return <p className="py-0.5 text-[12px] text-muted-foreground" style={{ paddingLeft: indent + 16 }}>{t("Leer")}</p>;
  return (
    <ul>
      {entries.map((entry) => (
        <li key={entry.path}>{entry.type === "directory" ? <DirectoryNode {...props} entry={entry} /> : <FileRow {...props} entry={entry} />}</li>
      ))}
    </ul>
  );
}

function DirectoryNode(props: TreeContext & { entry: DirectoryEntry; depth: number }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={cn(rowClassName, props.entry.heavy && "text-muted-foreground")}
        style={{ paddingLeft: 4 + props.depth * 12 }}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        {...dragOntoCanvas({ root: props.root, path: props.entry.path, kind: "directory" })}
      >
        <ChevronRight className={cn("size-3 shrink-0 text-muted-foreground transition-transform duration-200", open && "rotate-90")} />
        <Folder className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{props.entry.name}</span>
        {props.onPlaceOnCanvas && (
          <span className="ml-auto flex">
            <RowAction label={t("Auf den Canvas legen")} onActivate={() => props.onPlaceOnCanvas?.({ root: props.root, path: props.entry.path, kind: "directory" })}>
              <LayoutDashboard className="size-3" />
            </RowAction>
          </span>
        )}
      </button>
      {open && <DirectoryLevel {...props} directoryPath={props.entry.path} depth={props.depth + 1} />}
    </>
  );
}

function FileRow(props: TreeContext & { entry: DirectoryEntry; depth: number }) {
  const selection = { root: props.root, path: props.entry.path };
  const isSelected = props.selected?.root === props.root && props.selected.path === props.entry.path;
  return (
    <button
      type="button"
      className={cn(rowClassName, isSelected && "bg-foreground/[0.07] font-medium")}
      style={{ paddingLeft: 4 + props.depth * 12 + 16 }}
      onClick={() => props.onSelect(selection)}
      {...dragOntoCanvas({ ...selection, kind: "file" })}
    >
      <File className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{props.entry.name}</span>
      <span className="ml-auto flex">
        {props.onPlaceOnCanvas && (
          <RowAction label={t("Auf den Canvas legen")} onActivate={() => props.onPlaceOnCanvas?.({ ...selection, kind: "file" })}>
            <LayoutDashboard className="size-3" />
          </RowAction>
        )}
        <RowAction label={t("Im Chat referenzieren")} onActivate={() => props.onReference(selection)}>
          <AtSign className="size-3" />
        </RowAction>
      </span>
    </button>
  );
}

/** A project folder as a section: its name on top, its files below. */
function RootSection(props: Omit<TreeContext, "root"> & { root: ProjectRoot; initiallyOpen: boolean }) {
  const [open, setOpen] = useState(props.initiallyOpen);
  const RootIcon = props.root.kind === "worktree" ? GitBranch : props.root.repositoryPath ? FolderGit2 : Folder;
  return (
    <section className="mb-1">
      <button
        type="button"
        className="group/root flex h-7 w-full items-center gap-1.5 rounded-md px-1 text-left text-[12px] font-medium hover:bg-foreground/5"
        title={`${props.root.path} · ${rootKindLabel(props.root)}`}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        <ChevronRight className={cn("size-3 shrink-0 text-muted-foreground transition-transform duration-200", open && "rotate-90")} />
        <RootIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{props.root.label}</span>
      </button>
      {open && <DirectoryLevel {...props} root={props.root.path} directoryPath="" depth={1} />}
    </section>
  );
}

/** Files of all project folders (project folder, attached folders, chat worktrees). */
export function ProjectFiles(props: Omit<TreeContext, "root"> & { roots: ProjectRoot[]; codeRoot: string }) {
  const roots = props.roots.length ? props.roots : [{ path: props.project.path, label: props.project.name, kind: "project" as const, repositoryPath: null }];
  return (
    <div>
      {roots.map((root) => (
        <RootSection key={root.path} {...props} root={root} initiallyOpen={roots.length === 1 || root.path === props.codeRoot} />
      ))}
    </div>
  );
}
