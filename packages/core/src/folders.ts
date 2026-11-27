import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { database, type Project } from "./db.ts";
import { environmentStore } from "./environments.ts";
import type { MemoryScope } from "./memory.ts";
import { t } from "./i18n.ts";

/**
 * Folders Harnold may work in, beyond the project folder itself. They belong to a memory level
 * (project, environment, workspace) and are given to every session of that level – so a folder is
 * unlocked once instead of being re-added per chat, task or run.
 */
export type FolderScope = MemoryScope;

export type ContextFolder = {
  scope: FolderScope;
  /** Project id, environment id, or "" for the workspace. */
  ownerId: string;
  /** Absolute path. */
  path: string;
  /** Last path segment, for display. */
  label: string;
  /** The folder still exists on disk. */
  exists: boolean;
  createdAt: number;
};

database.exec(`
  CREATE TABLE IF NOT EXISTS context_folders (
    scope TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    path TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (scope, owner_id, path)
  );
`);

/** Absolute, without trailing slash; `~` = home. */
export function normalizeFolderPath(rawPath: string): string {
  const expanded = rawPath.trim().replace(/^~(?=$|\/)/, os.homedir());
  const resolved = path.resolve(expanded).replace(/\/+$/, "");
  return resolved || "/";
}

const labelOf = (folderPath: string) => path.basename(folderPath) || folderPath;

const ownerIdOf = (scope: FolderScope, ownerId: string): string => {
  if (scope === "workspace") return "";
  if (!ownerId) throw new Error(t("Projekt fehlt"));
  return ownerId;
};

const mapFolder = (row: Record<string, unknown>): ContextFolder => {
  const folderPath = String(row.path);
  return {
    scope: String(row.scope) as FolderScope,
    ownerId: String(row.owner_id),
    path: folderPath,
    label: labelOf(folderPath),
    exists: fs.statSync(folderPath, { throwIfNoEntry: false })?.isDirectory() ?? false,
    createdAt: Number(row.created_at),
  };
};

/** Normalized, existing folders of a task (duplicates dropped). */
export function checkTaskDirectories(rawPaths: string[]): string[] {
  const normalizedPaths = [...new Set(rawPaths.map((rawPath) => normalizeFolderPath(rawPath)).filter(Boolean))];
  for (const folderPath of normalizedPaths) {
    if (!fs.statSync(folderPath, { throwIfNoEntry: false })?.isDirectory()) throw new Error(t("Ordner nicht gefunden: {0}", folderPath));
  }
  return normalizedPaths;
}

export const folderStore = {
  list(scope: FolderScope, ownerId: string): ContextFolder[] {
    return (database.prepare("SELECT * FROM context_folders WHERE scope = ? AND owner_id = ? ORDER BY created_at").all(scope, ownerIdOf(scope, ownerId)) as Record<string, unknown>[]).map(mapFolder);
  },

  /** All folders, grouped by their level (for the memory screen). */
  listAll(): ContextFolder[] {
    return (database.prepare("SELECT * FROM context_folders ORDER BY created_at").all() as Record<string, unknown>[]).map(mapFolder);
  },

  /** Adds a folder after checking it exists; a path that is already in the same level stays as it is. */
  add(scope: FolderScope, ownerId: string, rawPath: string): ContextFolder {
    const folderPath = normalizeFolderPath(rawPath);
    if (!fs.statSync(folderPath, { throwIfNoEntry: false })?.isDirectory()) throw new Error(t("Ordner nicht gefunden: {0}", folderPath));
    const owner = ownerIdOf(scope, ownerId);
    database.prepare("INSERT OR IGNORE INTO context_folders (scope, owner_id, path, created_at) VALUES (?, ?, ?, ?)").run(scope, owner, folderPath, Date.now());
    return mapFolder(database.prepare("SELECT * FROM context_folders WHERE scope = ? AND owner_id = ? AND path = ?").get(scope, owner, folderPath) as Record<string, unknown>);
  },

  remove(scope: FolderScope, ownerId: string, rawPath: string): void {
    database.prepare("DELETE FROM context_folders WHERE scope = ? AND owner_id = ? AND path = ?").run(scope, ownerIdOf(scope, ownerId), normalizeFolderPath(rawPath));
  },

  /** Called when a project or environment disappears. */
  removeOwner(scope: FolderScope, ownerId: string): void {
    database.prepare("DELETE FROM context_folders WHERE scope = ? AND owner_id = ?").run(scope, ownerIdOf(scope, ownerId));
  },

  /** Folders every session of this project gets: its own, those of its environment, and the workspace ones. */
  forProject(projectId: string): ContextFolder[] {
    const environment = environmentStore.forProject(projectId);
    return [...folderStore.list("project", projectId), ...(environment ? folderStore.list("environment", environment.id) : []), ...folderStore.list("workspace", "")].filter((folder) => folder.exists);
  },

  pathsForProject(projectId: string): string[] {
    return [...new Set(folderStore.forProject(projectId).map((folder) => folder.path))];
  },

  /** For the system prompt: where the agent may work beyond the project folder. */
  contextFor(project: Project): string {
    const folders = folderStore.forProject(project.id);
    if (!folders.length) return "";
    const levels: Record<FolderScope, string> = { project: t("Projekt"), environment: t("Umgebung"), workspace: t("Workspace") };
    const lines = folders.map((folder) => `- ${folder.path} (${levels[folder.scope]})`);
    const missing = folderStore
      .listAll()
      .filter((folder) => !folder.exists && (folder.scope === "workspace" || folder.ownerId === project.id || folder.ownerId === environmentStore.forProject(project.id)?.id))
      .map((folder) => folder.path);
    return `## Ordner mit Zugriff\nDu darfst in diesen Ordnern lesen und arbeiten:\n${lines.join("\n")}${missing.length ? `\nNicht mehr vorhanden: ${missing.join(", ")}` : ""}`;
  },
};

export type FolderBrowseResult = {
  /** The folder being listed (absolute). */
  path: string;
  /** Its parent; null at the top. */
  parent: string | null;
  /** Subfolders (hidden ones left out), sorted by name. */
  folders: { name: string; path: string }[];
  /** Jump targets: home, the folders the server shares (HARNOLD_HOST_FOLDERS), /data. */
  shortcuts: { label: string; path: string }[];
};

/** One level of subfolders, for the folder picker of the browser UI (the server's file system, not the user's computer). */
export function browseFolders(rawPath: string | undefined): FolderBrowseResult {
  const startPath = normalizeFolderPath(rawPath?.trim() || os.homedir());
  let currentPath = startPath;
  while (currentPath !== "/" && !fs.statSync(currentPath, { throwIfNoEntry: false })?.isDirectory()) currentPath = path.dirname(currentPath);
  let folders: { name: string; path: string }[] = [];
  try {
    folders = fs
      .readdirSync(currentPath, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith(".") && (entry.isDirectory() || (entry.isSymbolicLink() && (fs.statSync(path.join(currentPath, entry.name), { throwIfNoEntry: false })?.isDirectory() ?? false))))
      .map((entry) => ({ name: entry.name, path: path.join(currentPath, entry.name) }))
      .sort((first, second) => first.name.localeCompare(second.name));
  } catch {
    // unreadable folder: shown empty
  }
  const sharedFolders = (process.env.HARNOLD_HOST_FOLDERS ?? "").split(/\s+/).filter(Boolean).map((sharedPath) => normalizeFolderPath(sharedPath));
  const shortcutCandidates = [{ label: t("Home"), path: os.homedir() }, ...sharedFolders.map((sharedPath) => ({ label: labelOf(sharedPath), path: sharedPath })), { label: "/data", path: "/data" }];
  const seenPaths = new Set<string>();
  const shortcuts = shortcutCandidates.filter((shortcut) => {
    if (seenPaths.has(shortcut.path) || !fs.statSync(shortcut.path, { throwIfNoEntry: false })?.isDirectory()) return false;
    seenPaths.add(shortcut.path);
    return true;
  });
  return { path: currentPath, parent: currentPath === "/" ? null : path.dirname(currentPath), folders, shortcuts };
}
