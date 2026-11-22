import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chatItemStore, projectStore, sessionStore, type ChatItem, type PendingFork, type Session } from "./db.ts";
import { eventHub } from "./events.ts";
import { config } from "./config.ts";
import { agentRuntime } from "./agent.ts";
import { environmentStore } from "./environments.ts";
import { claudeProfileForEnvironment } from "./claude-auth.ts";
import { t } from "./i18n.ts";

const userClaudeDirectory = () => process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
const environmentAccountsDirectory = () => path.join(config.dataDirectory, "claude-accounts");

/** Claude config dir the agent of this project writes its transcripts to. */
function claudeDirectoryForProject(projectId: string): string {
  const environment = environmentStore.forProject(projectId);
  return environment?.claudeMode === "subscription" ? claudeProfileForEnvironment(environment.id).configDirectory! : userClaudeDirectory();
}

/** Claude Code keys transcripts by the cwd with every non-alphanumeric character replaced. */
const transcriptFolderName = (projectPath: string) => projectPath.replace(/[^a-zA-Z0-9]/g, "-");

function findTranscript(agentSessionId: string): string | null {
  const accountDirectories = fs.existsSync(environmentAccountsDirectory())
    ? fs.readdirSync(environmentAccountsDirectory()).map((entryName) => path.join(environmentAccountsDirectory(), entryName))
    : [];
  for (const claudeDirectory of [userClaudeDirectory(), ...accountDirectories]) {
    const projectsDirectory = path.join(claudeDirectory, "projects");
    if (!fs.existsSync(projectsDirectory)) continue;
    for (const folderName of fs.readdirSync(projectsDirectory)) {
      const candidate = path.join(projectsDirectory, folderName, `${agentSessionId}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Copies the agent transcript to where the target project's agent looks for it. Returns false when there is none. */
function carryTranscriptOver(agentSessionId: string, fromProjectPath: string, toProjectId: string, toProjectPath: string): boolean {
  const sourcePath = findTranscript(agentSessionId);
  if (!sourcePath) return false;
  let resolvedTargetPath = toProjectPath;
  try {
    resolvedTargetPath = fs.realpathSync(toProjectPath);
  } catch {
    // project folder may not exist yet
  }
  const targetDirectory = path.join(claudeDirectoryForProject(toProjectId), "projects", transcriptFolderName(resolvedTargetPath));
  fs.mkdirSync(targetDirectory, { recursive: true });
  const transcript = fs.readFileSync(sourcePath, "utf8").split(`"cwd":${JSON.stringify(fromProjectPath)}`).join(`"cwd":${JSON.stringify(resolvedTargetPath)}`);
  fs.writeFileSync(path.join(targetDirectory, `${agentSessionId}.jsonl`), transcript);
  return true;
}

function appendNotice(sessionId: string, text: string): void {
  const chatItem = chatItemStore.append(sessionId, { kind: "notice", text });
  eventHub.publish({ type: "chat_item", sessionId, chatItem });
}

function requireSession(sessionId: string) {
  const session = sessionStore.get(sessionId);
  if (!session) throw new Error(t("Session nicht gefunden"));
  return session;
}

function moveNow(sessionId: string, targetProjectId: string): void {
  const session = requireSession(sessionId);
  const fromProject = projectStore.get(session.projectId);
  const toProject = projectStore.get(targetProjectId);
  if (!fromProject || !toProject) throw new Error(t("Projekt nicht gefunden"));
  if (fromProject.id === toProject.id) return;
  const contextKept = session.agentSessionId ? carryTranscriptOver(session.agentSessionId, fromProject.path, toProject.id, toProject.path) : true;
  sessionStore.update(sessionId, { projectId: toProject.id, ...(contextKept ? {} : { agentSessionId: null }) });
  const toEnvironment = environmentStore.forProject(toProject.id);
  appendNotice(
    sessionId,
    `Verschoben von ${fromProject.name} nach ${toProject.name}${toEnvironment ? ` (Umgebung ${toEnvironment.name})` : ""}${contextKept ? "" : " · Agent startet mit neuem Kontext"}`,
  );
  eventHub.publish({ type: "sessions_changed", projectId: fromProject.id });
  eventHub.publish({ type: "sessions_changed", projectId: toProject.id });
  eventHub.publish({ type: "session_moved", sessionId, fromProjectId: fromProject.id, toProjectId: toProject.id });
}

/** Plain-text history for a fork without a known agent fork point. */
function transcriptOf(chatItems: ChatItem[]): string {
  const lines = chatItems.flatMap((chatItem) =>
    chatItem.kind === "user_text" ? [`Nutzer: ${chatItem.text}`] : chatItem.kind === "assistant_text" ? [`Assistent: ${chatItem.text}`] : [],
  );
  return `Bisheriger Verlauf dieser Unterhaltung (zur Orientierung, nicht erneut ausführen):\n\n${lines.join("\n\n").slice(-30_000)}\n\n---\nNeue Nachricht:`;
}

/** Root of a message's versions: an edited message in a version belongs to the versions of the message it replaced. */
function versionRootOf(session: Session, itemId: string): { sessionId: string; itemId: string } {
  if (session.forkItemId === itemId && session.forkOriginSessionId && session.forkOriginItemId) {
    return { sessionId: session.forkOriginSessionId, itemId: session.forkOriginItemId };
  }
  return { sessionId: session.id, itemId };
}

export const sessionActions = {
  /**
   * Editing a sent message creates a new version of the conversation from that point on:
   * a session with the history before the message, whose agent forks off at the same place.
   */
  forkForEdit(sessionId: string, itemId: string): Session {
    const session = requireSession(sessionId);
    const chatItems = chatItemStore.list(sessionId);
    const editedIndex = chatItems.findIndex((chatItem) => chatItem.id === itemId && chatItem.kind === "user_text");
    if (editedIndex < 0) throw new Error(t("Nachricht nicht gefunden"));
    const keptItems = chatItems.slice(0, editedIndex);
    const lastTurnResult = [...keptItems].reverse().find((chatItem) => chatItem.kind === "turn_result");
    let pendingFork: PendingFork | null = null;
    if (lastTurnResult?.kind === "turn_result") {
      pendingFork = lastTurnResult.agentSessionId && lastTurnResult.lastChainUuid
        ? { mode: "resume", agentSessionId: lastTurnResult.agentSessionId, resumeAt: lastTurnResult.lastChainUuid }
        : { mode: "transcript", transcript: transcriptOf(keptItems) };
    }
    const versionRoot = versionRootOf(session, itemId);
    const forkedSession = sessionStore.create(session.projectId, session.title, { originSessionId: versionRoot.sessionId, originItemId: versionRoot.itemId, pendingFork });
    // The fork continues with the agent program its origin used (its conversation id belongs to it).
    if (session.backendId) sessionStore.update(forkedSession.id, { backendId: session.backendId });
    for (const keptItem of keptItems) {
      const { id: _id, sessionId: _sessionId, createdAt, ...payload } = keptItem;
      chatItemStore.append(forkedSession.id, payload, createdAt);
    }
    eventHub.publish({ type: "sessions_changed", projectId: session.projectId });
    return forkedSession;
  },

  /** Moves a session (and its agent context) into another project – and thereby into that project's environment. */
  move(sessionId: string, targetProjectId: string): { deferred: boolean } {
    requireSession(sessionId);
    if (!projectStore.get(targetProjectId)) throw new Error(t("Projekt nicht gefunden"));
    if (agentRuntime.isRunning(sessionId)) {
      agentRuntime.afterTurn(sessionId, () => moveNow(sessionId, targetProjectId));
      return { deferred: true };
    }
    moveNow(sessionId, targetProjectId);
    return { deferred: false };
  },

  /** Like /clear in Claude Code: empty timeline, fresh agent context. */
  clear(sessionId: string): void {
    const session = requireSession(sessionId);
    if (agentRuntime.isRunning(sessionId)) throw new Error(t("Erst den laufenden Durchlauf stoppen"));
    agentRuntime.clearQueue(sessionId);
    chatItemStore.clear(sessionId);
    sessionStore.update(sessionId, { agentSessionId: null });
    eventHub.publish({ type: "session_cleared", sessionId });
    eventHub.publish({ type: "sessions_changed", projectId: session.projectId });
  },

  rename(sessionId: string, title: string): void {
    const session = requireSession(sessionId);
    sessionStore.update(sessionId, { title: title.trim().slice(0, 120) || session.title });
    eventHub.publish({ type: "sessions_changed", projectId: session.projectId });
  },

  /** Deletes a session and its history (like the chat menu). */
  remove(sessionId: string): void {
    const session = requireSession(sessionId);
    agentRuntime.clearQueue(sessionId);
    agentRuntime.interrupt(sessionId);
    sessionStore.remove(sessionId);
    eventHub.publish({ type: "sessions_changed", projectId: session.projectId });
  },
};
