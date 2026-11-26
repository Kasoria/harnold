import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { environmentStore } from "./environments.ts";
import { t } from "./i18n.ts";

/**
 * Git view of a project (status, diff, stage, commit, push/pull) via the git CLI. Runs with the project's
 * environment, so commits carry its identity and pushes use its GitHub token, exactly like the agent's.
 */

const execFileAsync = promisify(execFile);

export type GitFileChange = {
  path: string;
  /** Previous path of a rename. */
  originalPath?: string;
  /** Porcelain v2 letters: index (staged) and worktree; "?" = untracked. */
  staged: string;
  unstaged: string;
};

export type GitStatus =
  | { isRepository: false; gitAvailable: boolean }
  | {
      isRepository: true;
      branch: string | null;
      upstream: string | null;
      ahead: number;
      behind: number;
      files: GitFileChange[];
      /** Merge/rebase in progress: commit from the view would be wrong. */
      operationInProgress: string | null;
    };

export type GitCommit = { hash: string; subject: string; author: string; date: number };

type ProjectRef = { id: string; path: string };

const gitOutputLimit = 20 * 1024 * 1024;

async function runGit(project: ProjectRef, gitArguments: string[], options: { allowFailure?: boolean; timeoutMs?: number } = {}): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", gitArguments, {
      cwd: project.path,
      env: { ...process.env, ...environmentStore.variablesForProject(project.id), GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
      maxBuffer: gitOutputLimit,
      timeout: options.timeoutMs ?? 15_000,
    });
    return stdout;
  } catch (gitError) {
    if (options.allowFailure) return "";
    const failure = gitError as { stderr?: string; message?: string; code?: string };
    if (failure.code === "ENOENT") throw new Error(t("Git ist auf diesem Rechner nicht installiert."));
    throw new Error((failure.stderr || failure.message || String(gitError)).trim().split("\n").slice(-4).join("\n"));
  }
}

async function gitInstalled(): Promise<boolean> {
  try {
    await execFileAsync("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

/** Paths from the UI stay inside the project. */
function safePaths(project: ProjectRef, filePaths: string[]): string[] {
  return filePaths.map((filePath) => {
    const resolvedPath = path.resolve(project.path, filePath);
    if (resolvedPath !== project.path && !resolvedPath.startsWith(project.path + path.sep)) throw new Error(t("Pfad liegt außerhalb des Projekts"));
    return path.relative(project.path, resolvedPath) || ".";
  });
}

export async function gitStatus(project: ProjectRef): Promise<GitStatus> {
  const insideWorkTree = (await runGit(project, ["rev-parse", "--is-inside-work-tree"], { allowFailure: true })).trim() === "true";
  if (!insideWorkTree) return { isRepository: false, gitAvailable: await gitInstalled() };
  const porcelain = await runGit(project, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]);
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const files: GitFileChange[] = [];
  const entries = porcelain.split("\0");
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
    const entry = entries[entryIndex];
    if (entry.startsWith("# branch.head ")) branch = entry.slice(14) === "(detached)" ? null : entry.slice(14);
    else if (entry.startsWith("# branch.upstream ")) upstream = entry.slice(18);
    else if (entry.startsWith("# branch.ab ")) {
      const [aheadText, behindText] = entry.slice(12).split(" ");
      ahead = Number(aheadText.replace("+", ""));
      behind = Number(behindText.replace("-", ""));
    } else if (entry.startsWith("1 ")) {
      const fields = entry.split(" ");
      files.push({ staged: fields[1][0], unstaged: fields[1][1], path: fields.slice(8).join(" ") });
    } else if (entry.startsWith("2 ")) {
      const fields = entry.split(" ");
      // Renames: the original path follows as its own NUL-separated entry.
      files.push({ staged: fields[1][0], unstaged: fields[1][1], path: fields.slice(9).join(" "), originalPath: entries[++entryIndex] });
    } else if (entry.startsWith("u ")) {
      files.push({ staged: "U", unstaged: "U", path: entry.split(" ").slice(10).join(" ") });
    } else if (entry.startsWith("? ")) {
      files.push({ staged: ".", unstaged: "?", path: entry.slice(2) });
    }
  }
  const gitDirectory = (await runGit(project, ["rev-parse", "--absolute-git-dir"])).trim();
  const operationMarkers: [string, string][] = [["MERGE_HEAD", "merge"], ["rebase-merge", "rebase"], ["rebase-apply", "rebase"], ["CHERRY_PICK_HEAD", "cherry-pick"]];
  const operationInProgress = operationMarkers.find(([marker]) => fs.existsSync(path.join(gitDirectory, marker)))?.[1] ?? null;
  return { isRepository: true, branch, upstream, ahead, behind, files, operationInProgress };
}

/** Unified diff of one file: staged (index vs HEAD) or working tree (vs index); untracked files as all-new. */
export async function gitDiff(project: ProjectRef, filePath: string, staged: boolean): Promise<string> {
  const [safePath] = safePaths(project, [filePath]);
  const tracked = (await runGit(project, ["ls-files", "--", safePath], { allowFailure: true })).trim() !== "";
  if (!tracked && !staged) {
    // git diff --no-index exits with 1 when there are differences.
    try {
      await execFileAsync("git", ["diff", "--no-index", "--no-color", "--", "/dev/null", safePath], { cwd: project.path, maxBuffer: gitOutputLimit });
      return "";
    } catch (diffResult) {
      return (diffResult as { stdout?: string }).stdout ?? "";
    }
  }
  return runGit(project, ["diff", "--no-color", "--find-renames", ...(staged ? ["--cached"] : []), "--", safePath]);
}

export async function gitStage(project: ProjectRef, filePaths: string[]) {
  await runGit(project, ["add", "--all", "--", ...safePaths(project, filePaths)]);
}

export async function gitUnstage(project: ProjectRef, filePaths: string[]) {
  const hasHead = (await runGit(project, ["rev-parse", "--verify", "HEAD"], { allowFailure: true })).trim() !== "";
  // Before the first commit there is no HEAD to reset to.
  if (hasHead) await runGit(project, ["reset", "--quiet", "HEAD", "--", ...safePaths(project, filePaths)]);
  else await runGit(project, ["rm", "--cached", "--quiet", "-r", "--", ...safePaths(project, filePaths)]);
}

/** Throws away working-tree changes; new (untracked) files are deleted. */
export async function gitDiscard(project: ProjectRef, filePaths: string[]) {
  const paths = safePaths(project, filePaths);
  const untrackedPaths = (await runGit(project, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...paths])).split("\0").filter(Boolean);
  const trackedPaths = paths.filter((filePath) => !untrackedPaths.includes(filePath));
  if (untrackedPaths.length) await runGit(project, ["clean", "-f", "-q", "--", ...untrackedPaths]);
  if (trackedPaths.length) await runGit(project, ["checkout", "--", ...trackedPaths]);
}

/** Commits what is staged; with nothing staged, all changes (like "commit all" in desktop git clients). */
export async function gitCommit(project: ProjectRef, message: string): Promise<GitCommit> {
  const status = await gitStatus(project);
  if (!status.isRepository) throw new Error(t("Kein Git-Repository"));
  const hasStagedChanges = status.files.some((file) => file.staged !== "." && file.staged !== "?");
  if (!hasStagedChanges) {
    if (!status.files.length) throw new Error(t("Keine Änderungen zum Committen"));
    await runGit(project, ["add", "--all"]);
  }
  await runGit(project, ["commit", "--quiet", "-m", message]);
  return (await gitLog(project, 1))[0];
}

export async function gitLog(project: ProjectRef, limit = 30): Promise<GitCommit[]> {
  const output = await runGit(project, ["log", `-${limit}`, "--format=%H%x1f%s%x1f%an%x1f%at%x1e"], { allowFailure: true });
  return output
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash, subject, author, timestamp] = record.split("\x1f");
      return { hash, subject, author, date: Number(timestamp) * 1000 };
    });
}

export async function gitPush(project: ProjectRef) {
  const status = await gitStatus(project);
  if (!status.isRepository || !status.branch) throw new Error(t("Kein Branch zum Pushen"));
  // First push of a branch: set its upstream on origin.
  const pushArguments = status.upstream ? ["push"] : ["push", "--set-upstream", "origin", status.branch];
  await runGit(project, pushArguments, { timeoutMs: 120_000 });
}

export async function gitPull(project: ProjectRef) {
  await runGit(project, ["pull", "--ff-only"], { timeoutMs: 120_000 });
}

export async function gitInit(project: ProjectRef) {
  await runGit(project, ["init", "--quiet"]);
}
