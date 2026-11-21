import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chatItemStore, projectStore, sessionStore } from "./db.ts";
import { eventHub } from "./events.ts";
import { config } from "./config.ts";
import { agentRuntime } from "./agent.ts";
import { environmentStore } from "./environments.ts";
import { claudeProfileForEnvironment } from "./claude-auth.ts";

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
  if (!session) throw new Error("Session nicht gefunden");
  return session;
}

function moveNow(sessionId: string, targetProjectId: string): void {
  const session = requireSession(sessionId);
  const fromProject = projectStore.get(session.projectId);
  const toProject = projectStore.get(targetProjectId);
  if (!fromProject || !toProject) throw new Error("Projekt nicht gefunden");
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

export const sessionActions = {
  /** Moves a session (and its agent context) into another project – and thereby into that project's environment. */
  move(sessionId: string, targetProjectId: string): { deferred: boolean } {
    requireSession(sessionId);
    if (!projectStore.get(targetProjectId)) throw new Error("Projekt nicht gefunden");
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
    if (agentRuntime.isRunning(sessionId)) throw new Error("Erst den laufenden Durchlauf stoppen");
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
};
