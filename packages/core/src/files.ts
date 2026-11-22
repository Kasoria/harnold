import fs from "node:fs";
import path from "node:path";
import { eventHub } from "./events.ts";
import type { Project } from "./db.ts";
import { t } from "./i18n.ts";

const ignoredNames = new Set(["node_modules", ".git", "dist", ".next", ".DS_Store", ".turbo"]);

export type FileNode = { name: string; path: string; type: "file" | "directory"; children?: FileNode[] };

/** Resolves a project-relative path and refuses anything outside the project. */
export function resolveInsideProject(project: Project, relativePath: string): string {
  const absolutePath = path.resolve(project.path, relativePath.replace(/^\/+/, ""));
  const projectRoot = path.resolve(project.path);
  if (absolutePath !== projectRoot && !absolutePath.startsWith(projectRoot + path.sep)) {
    throw new Error(t("Pfad liegt außerhalb des Projekts"));
  }
  return absolutePath;
}

export function readFileTree(project: Project, relativeDirectory = "", depthLimit = 8): FileNode[] {
  if (depthLimit < 0) return [];
  const absoluteDirectory = resolveInsideProject(project, relativeDirectory);
  const directoryEntries = fs.readdirSync(absoluteDirectory, { withFileTypes: true });
  return directoryEntries
    .filter((entry) => !ignoredNames.has(entry.name))
    .sort((first, second) =>
      first.isDirectory() === second.isDirectory() ? first.name.localeCompare(second.name) : first.isDirectory() ? -1 : 1,
    )
    .map((entry) => {
      const entryPath = path.posix.join(relativeDirectory, entry.name);
      return entry.isDirectory()
        ? { name: entry.name, path: entryPath, type: "directory" as const, children: readFileTree(project, entryPath, depthLimit - 1) }
        : { name: entry.name, path: entryPath, type: "file" as const };
    });
}

const activeWatchers = new Map<string, fs.FSWatcher>();

/** Watches a project folder and publishes debounced change events (drives live preview reload). */
export function watchProject(project: Project): void {
  if (activeWatchers.has(project.id)) return;
  let pendingPaths = new Set<string>();
  let debounceTimer: NodeJS.Timeout | undefined;
  try {
    const watcher = fs.watch(project.path, { recursive: true }, (_eventType, changedName) => {
      if (!changedName) return;
      const changedPath = changedName.toString().split(path.sep).join("/");
      if (changedPath.split("/").some((segment) => ignoredNames.has(segment))) return;
      pendingPaths.add(changedPath);
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        eventHub.publish({ type: "files_changed", projectId: project.id, paths: [...pendingPaths] });
        pendingPaths = new Set();
      }, 150);
    });
    activeWatchers.set(project.id, watcher);
  } catch (watchError) {
    console.warn(`[files] watch failed for ${project.path}:`, watchError);
  }
}

export function unwatchProject(projectId: string): void {
  activeWatchers.get(projectId)?.close();
  activeWatchers.delete(projectId);
}
