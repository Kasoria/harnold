import { useEffect, useState } from "react";
import { api } from "@/api";
import type { DevServer, Project, ProjectRoot } from "@/types";
import { t } from "@/lib/i18n";

/** The project's folders (project folder, attached folders, chat worktrees); reloads when refreshKey changes. */
export function useProjectRoots(project: Project, refreshKey: unknown): ProjectRoot[] {
  const [roots, setRoots] = useState<ProjectRoot[]>([]);
  useEffect(() => {
    let cancelled = false;
    api
      .listProjectRoots(project.id)
      .then((loadedRoots) => !cancelled && setRoots(loadedRoots))
      .catch(() => !cancelled && setRoots([]));
    return () => {
      cancelled = true;
    };
  }, [project.id, refreshKey]);
  return roots;
}

/** Where the code lives: the project folder if it is a repository, else the first attached repository, else the project folder. */
export function preferredCodeRoot(roots: ProjectRoot[], project: Project): string {
  const repositoryRoots = roots.filter((root) => root.kind !== "worktree" && root.repositoryPath);
  return (repositoryRoots.find((root) => root.kind === "project") ?? repositoryRoots.find((root) => root.kind === "project-folder") ?? repositoryRoots[0])?.path ?? project.path;
}

/** Roots that are distinct repositories (one entry per repository, worktrees included). */
export function repositoryRoots(roots: ProjectRoot[]): ProjectRoot[] {
  const seenRepositories = new Set<string>();
  return roots.filter((root) => {
    if (!root.repositoryPath || seenRepositories.has(root.repositoryPath)) return false;
    seenRepositories.add(root.repositoryPath);
    return true;
  });
}

export function rootKindLabel(root: ProjectRoot): string {
  switch (root.kind) {
    case "project":
      return t("Projektordner");
    case "project-folder":
      return t("Ordner des Projekts");
    case "environment-folder":
      return t("Ordner der Umgebung");
    case "workspace-folder":
      return t("Ordner des Workspace");
    case "worktree":
      return t("Worktree eines Chats");
  }
}

/** macOS reports /private/var for /var and the like. */
export const normalizedPath = (folderPath: string) => folderPath.replace(/^\/private(?=\/)/, "").replace(/\/+$/, "");

export function isInsideFolder(candidatePath: string, folderPath: string): boolean {
  const candidate = normalizedPath(candidatePath);
  const folder = normalizedPath(folderPath);
  return candidate === folder || candidate.startsWith(folder + "/");
}

/** A dev server belongs to the project when it runs in one of its folders (workspace-wide folders don't count). */
export function serverBelongsToProject(devServer: DevServer, project: Project, roots: ProjectRoot[]): boolean {
  if (!devServer.workingDirectory) return false;
  const ownFolders = [project.path, ...roots.filter((root) => root.kind === "project-folder" || root.kind === "environment-folder" || root.kind === "worktree").map((root) => root.path)];
  return ownFolders.some((folderPath) => isInsideFolder(devServer.workingDirectory!, folderPath));
}
