import fs from "node:fs";
import path from "node:path";
import { config } from "./config.ts";
import { projectStore, sessionRemovalListeners, sessionStore, type Session, type SessionWorktree } from "./db.ts";
import { gitAddWorktree, gitCommitAll, gitCommitsAhead, gitCurrentBranch, gitDeleteBranch, gitHasChanges, gitMergeBranch, gitRemoveWorktree } from "./git.ts";
import { projectRootPaths, repositoryTopLevel } from "./project-roots.ts";
import { t } from "./i18n.ts";

/**
 * A chat can work in its own worktree: a second checkout of the repository on its own branch. Parallel chats
 * then don't overwrite each other's files. "Apply" merges the branch back, "remove" drops the checkout
 * (uncommitted work is committed to the branch first, so nothing is lost).
 */

const worktreesDirectory = path.join(config.dataDirectory, "worktrees");

function slugOf(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "chat"
  );
}

function requireSession(sessionId: string): Session {
  const session = sessionStore.get(sessionId);
  if (!session) throw new Error(t("Session nicht gefunden"));
  return session;
}

/** Sessions that share a worktree (versions of a chat). */
function sessionsUsing(worktreePath: string): Session[] {
  return sessionStore.listAllWithWorktree().filter((session) => session.worktree?.path === worktreePath);
}

export async function createSessionWorktree(sessionId: string, requestedFolder: string): Promise<SessionWorktree> {
  const session = requireSession(sessionId);
  if (session.worktree) throw new Error(t("Dieser Chat hat schon einen Worktree."));
  if (session.agentSessionId) throw new Error(t("Ein Worktree lässt sich nur vor der ersten Nachricht anlegen."));
  const project = projectStore.get(session.projectId);
  if (!project) throw new Error(t("Projekt nicht gefunden"));
  const folder = path.resolve(requestedFolder);
  if (!projectRootPaths(project).includes(folder)) throw new Error(t("Ordner gehört nicht zum Projekt"));
  const realTopLevel = await repositoryTopLevel(folder);
  if (!realTopLevel) throw new Error(t("Kein Git-Repository"));
  // Git reports the real path (/private/tmp …); keep the spelling the project uses, so its folders map onto the worktree.
  const repositoryPath = path.resolve(folder, path.relative(fs.realpathSync(folder), realTopLevel));
  const repository = { id: project.id, path: repositoryPath };
  const baseBranch = await gitCurrentBranch(repository);
  const shortId = session.id.slice(0, 6);
  const branch = `harnold/${slugOf(session.title)}-${shortId}`;
  const worktreePath = path.join(worktreesDirectory, `${path.basename(repositoryPath)}-${shortId}`);
  fs.mkdirSync(worktreesDirectory, { recursive: true });
  await gitAddWorktree(repository, worktreePath, branch);
  const worktree: SessionWorktree = { repositoryPath, path: worktreePath, branch, baseBranch };
  sessionStore.update(sessionId, { worktree });
  for (const fork of sessionStore.listForks(sessionId)) sessionStore.update(fork.id, { worktree });
  return worktree;
}

export type WorktreeStatus = SessionWorktree & { exists: boolean; uncommittedChanges: boolean; commitsAhead: number; repositoryBranch: string | null };

export async function sessionWorktreeStatus(sessionId: string): Promise<WorktreeStatus | null> {
  const session = requireSession(sessionId);
  const worktree = session.worktree;
  if (!worktree) return null;
  const exists = fs.existsSync(worktree.path);
  const repositoryRef = { id: session.projectId, path: worktree.repositoryPath };
  return {
    ...worktree,
    exists,
    uncommittedChanges: exists ? await gitHasChanges({ id: session.projectId, path: worktree.path }) : false,
    commitsAhead: worktree.baseBranch ? await gitCommitsAhead(repositoryRef, worktree.baseBranch, worktree.branch) : 0,
    repositoryBranch: await gitCurrentBranch(repositoryRef),
  };
}

/** Commits the chat's work and merges its branch into the base branch checked out in the repository. */
export async function applySessionWorktree(sessionId: string): Promise<void> {
  const session = requireSession(sessionId);
  const worktree = session.worktree;
  if (!worktree) throw new Error(t("Dieser Chat hat keinen Worktree."));
  const repositoryRef = { id: session.projectId, path: worktree.repositoryPath };
  const repositoryBranch = await gitCurrentBranch(repositoryRef);
  if (worktree.baseBranch && repositoryBranch !== worktree.baseBranch) {
    throw new Error(t("Im Repository ist gerade {0} ausgecheckt, nicht {1}. Bitte erst dorthin wechseln.", repositoryBranch ?? "–", worktree.baseBranch));
  }
  if (fs.existsSync(worktree.path)) await gitCommitAll({ id: session.projectId, path: worktree.path }, `Harnold: ${session.title}`);
  if (!(await gitCommitsAhead(repositoryRef, repositoryBranch ?? "HEAD", worktree.branch))) throw new Error(t("Keine Änderungen zum Übernehmen"));
  await gitMergeBranch(repositoryRef, worktree.branch, t("Übernommen aus Chat „{0}“", session.title));
}

/** Drops the checkout. Work is committed to the branch first; the branch is deleted only when asked. */
export async function removeSessionWorktree(sessionId: string, options: { deleteBranch: boolean }): Promise<void> {
  const session = requireSession(sessionId);
  const worktree = session.worktree;
  if (!worktree) return;
  await dropWorktree(session, worktree, options.deleteBranch);
  // Worktree as working directory (repository = project folder): the agent's conversation belongs to that folder and starts fresh.
  const workingDirectoryChanges = worktree.repositoryPath === projectStore.get(session.projectId)?.path;
  for (const sharingSession of sessionsUsing(worktree.path)) sessionStore.update(sharingSession.id, workingDirectoryChanges ? { worktree: null, agentSessionId: null } : { worktree: null });
}

async function dropWorktree(session: Session, worktree: SessionWorktree, deleteBranch: boolean) {
  const repositoryRef = { id: session.projectId, path: worktree.repositoryPath };
  if (fs.existsSync(worktree.path)) {
    if (!deleteBranch) await gitCommitAll({ id: session.projectId, path: worktree.path }, `Harnold: ${session.title} (gesichert)`).catch(() => false);
    await gitRemoveWorktree(repositoryRef, worktree.path);
    fs.rmSync(worktree.path, { recursive: true, force: true });
  }
  if (deleteBranch) await gitDeleteBranch(repositoryRef, worktree.branch);
}

// A deleted chat takes its worktree along (if no other version of it still uses it); the branch keeps the work.
sessionRemovalListeners.add((session) => {
  const worktree = session.worktree;
  if (!worktree) return;
  if (sessionsUsing(worktree.path).some((other) => other.id !== session.id)) return;
  void dropWorktree(session, worktree, false).catch((dropError) => console.warn("[worktrees] cleanup failed:", dropError));
});
