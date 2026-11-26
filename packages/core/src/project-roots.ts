import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { database, sessionStore, type Project, type SessionWorktree } from "./db.ts";
import { folderStore } from "./folders.ts";
import { resolveInsideRoot } from "./paths.ts";
import { t } from "./i18n.ts";

/**
 * The folders a project consists of: its own folder, the folders attached as context (project, environment,
 * workspace level) and the worktrees of its chats. The code often lives in an attached folder, not in the
 * project folder – file tree, editor, Git, terminal and the dev-server list work on all of them.
 */

const execFileAsync = promisify(execFile);

export type ProjectRootKind = "project" | "project-folder" | "environment-folder" | "workspace-folder" | "worktree";

export type ProjectRoot = {
  path: string;
  label: string;
  kind: ProjectRootKind;
  /** Top level of the Git repository the folder is in; null = no repository. */
  repositoryPath: string | null;
  /** Worktree roots: the chat they belong to and their branch. */
  sessionId?: string;
  branch?: string;
};

const kindByScope = { project: "project-folder", environment: "environment-folder", workspace: "workspace-folder" } as const;

/** Worktrees of the project's chats (only those that still exist on disk). */
function projectWorktrees(projectId: string): { sessionId: string; worktree: SessionWorktree }[] {
  const rows = database.prepare("SELECT id, worktree FROM sessions WHERE project_id = ? AND worktree IS NOT NULL").all(projectId) as { id: string; worktree: string }[];
  return rows
    .map((row) => ({ sessionId: row.id, worktree: JSON.parse(row.worktree) as SessionWorktree }))
    .filter(({ worktree }) => fs.existsSync(worktree.path));
}

/** Folders without repository info (cheap; for access checks). */
export function projectRootPaths(project: Project): string[] {
  return [...new Set([project.path, ...folderStore.forProject(project.id).map((folder) => folder.path), ...projectWorktrees(project.id).map(({ worktree }) => worktree.path)])];
}

export async function repositoryTopLevel(folderPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: folderPath, timeout: 5000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function listProjectRoots(project: Project): Promise<ProjectRoot[]> {
  const roots: Omit<ProjectRoot, "repositoryPath">[] = [{ path: project.path, label: project.name, kind: "project" }];
  for (const folder of folderStore.forProject(project.id)) {
    if (roots.some((root) => root.path === folder.path)) continue;
    roots.push({ path: folder.path, label: folder.label, kind: kindByScope[folder.scope] });
  }
  for (const { sessionId, worktree } of projectWorktrees(project.id)) {
    const sessionTitle = sessionStore.get(sessionId)?.title;
    roots.push({ path: worktree.path, label: sessionTitle ? `${sessionTitle} (${worktree.branch})` : worktree.branch, kind: "worktree", sessionId, branch: worktree.branch });
  }
  return Promise.all(roots.filter((root) => fs.existsSync(root.path)).map(async (root) => ({ ...root, repositoryPath: await repositoryTopLevel(root.path) })));
}

/**
 * Folder a request works in: one of the project's roots (default: the project folder).
 * Anything else is refused, so the API can't be pointed at arbitrary folders.
 */
export function resolveProjectRoot(project: Project, requestedRoot: string | undefined | null): string {
  if (!requestedRoot) return project.path;
  const normalizedRoot = path.resolve(requestedRoot);
  if (!projectRootPaths(project).includes(normalizedRoot)) throw new Error(t("Ordner gehört nicht zum Projekt"));
  return normalizedRoot;
}

/** A path inside one of the project's roots (symlinks included). */
export function resolveInsideProjectRoot(project: Project, requestedRoot: string | undefined | null, relativePath: string): string {
  return resolveInsideRoot(resolveProjectRoot(project, requestedRoot), relativePath, new Error(t("Pfad liegt außerhalb des Projekts")));
}

/** The repository the project's code lives in: the project folder if it is one, else the first attached repository. */
export async function preferredRepository(project: Project): Promise<string | null> {
  const roots = await listProjectRoots(project);
  const candidates = roots.filter((root) => root.kind !== "worktree" && root.repositoryPath);
  return (candidates.find((root) => root.kind === "project") ?? candidates.find((root) => root.kind === "project-folder") ?? candidates[0])?.repositoryPath ?? null;
}

const hiddenEntryNames = new Set([".git", ".DS_Store"]);
/** Folders shown collapsed and never expanded automatically (large, generated). */
const heavyDirectoryNames = new Set(["node_modules", "dist", "build", ".next", ".turbo", "target", ".venv", "__pycache__"]);

export type DirectoryEntry = { name: string; path: string; type: "file" | "directory"; heavy?: boolean };

/** One level of a folder, directories first. */
export function readRootDirectory(rootPath: string, relativeDirectory: string): DirectoryEntry[] {
  const absoluteDirectory = resolveInsideRoot(rootPath, relativeDirectory, new Error(t("Pfad liegt außerhalb des Projekts")));
  return fs
    .readdirSync(absoluteDirectory, { withFileTypes: true })
    .filter((entry) => !hiddenEntryNames.has(entry.name))
    .map((entry) => {
      const isDirectory = entry.isDirectory() || (entry.isSymbolicLink() && (fs.statSync(path.join(absoluteDirectory, entry.name), { throwIfNoEntry: false })?.isDirectory() ?? false));
      return {
        name: entry.name,
        path: path.posix.join(relativeDirectory, entry.name),
        type: isDirectory ? ("directory" as const) : ("file" as const),
        ...(isDirectory && heavyDirectoryNames.has(entry.name) ? { heavy: true } : {}),
      };
    })
    .sort((first, second) => (first.type === second.type ? first.name.localeCompare(second.name) : first.type === "directory" ? -1 : 1));
}
