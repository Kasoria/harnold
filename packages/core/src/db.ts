import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { config } from "./config.ts";

export const database = new DatabaseSync(config.databasePath);
database.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    agent_session_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chat_items (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS chat_items_by_session ON chat_items(session_id, created_at);
`);

/** Adds columns to existing databases (CREATE TABLE IF NOT EXISTS does not). */
function addColumnIfMissing(tableName: string, columnName: string, columnDefinition: string): void {
  const existingColumns = database.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => String(row.name));
  if (!existingColumns.includes(columnName)) database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
}
addColumnIfMissing("projects", "icon", "TEXT");
addColumnIfMissing("projects", "kind", "TEXT NOT NULL DEFAULT 'project'");
addColumnIfMissing("sessions", "fork_origin_session_id", "TEXT");
addColumnIfMissing("sessions", "fork_origin_item_id", "TEXT");
addColumnIfMissing("sessions", "fork_item_id", "TEXT");
addColumnIfMissing("sessions", "pending_fork", "TEXT");
addColumnIfMissing("sessions", "agent_id", "TEXT");
addColumnIfMissing("sessions", "task_id", "TEXT");
addColumnIfMissing("sessions", "mail_inbox_id", "TEXT");
addColumnIfMissing("sessions", "backend_id", "TEXT");
addColumnIfMissing("sessions", "directories", "TEXT");
// Conversation history of Harnold's own agent (other agent programs keep theirs themselves).
database.exec(`
  CREATE TABLE IF NOT EXISTS agent_messages (
    session_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (session_id, sequence)
  );
`);

/** "quick" = the built-in home of chats without a project (Quick Chats). */
export type ProjectKind = "project" | "quick";
export type Project = { id: string; name: string; path: string; icon: string | null; kind: ProjectKind; createdAt: number };

/** How a forked session's agent picks up the conversation on its first turn. */
export type PendingFork =
  | { mode: "resume"; agentSessionId: string; resumeAt: string }
  /** No agent fork point known (older history): the prior conversation goes into the first prompt. */
  | { mode: "transcript"; transcript: string };

export type Session = {
  id: string;
  projectId: string;
  title: string;
  agentSessionId: string | null;
  /** Agent program of this conversation (set on the first turn; its agentSessionId belongs to it). null = not started yet. */
  backendId: string | null;
  /** Set on a version created by editing a message: the session/message it is an alternative to. */
  forkOriginSessionId: string | null;
  forkOriginItemId: string | null;
  /** The edited user message in this version. */
  forkItemId: string | null;
  pendingFork: PendingFork | null;
  /** Team member this conversation is with (see agents.ts); null = the default Harnold agent. */
  agentId: string | null;
  /** Set on sessions a task created; they are listed with the task, not as normal sessions. */
  taskId: string | null;
  /** Set on sessions a mailbox (integration) created; hidden from the normal conversation list. */
  mailInboxId: string | null;
  /** Extra local folders the agent may work in for this chat (absolute paths), besides the project folder. */
  directories: string[];
  createdAt: number;
  updatedAt: number;
};

/** A file attached to a chat message; stored in the project under attachments/. */
export type Attachment = { path: string; name: string; mimeType: string; size: number };

/** Normalized, UI-facing chat entries (independent of the model provider). */
export type ChatItemPayload =
  | { kind: "user_text"; text: string; attachments?: Attachment[] }
  | { kind: "assistant_text"; text: string }
  | { kind: "thinking"; text: string }
  /** Harnold's own markers in the timeline (context cleared/compacted, session moved). */
  | { kind: "notice"; text: string }
  | { kind: "tool_use"; toolUseId: string; toolName: string; input: unknown }
  | { kind: "tool_result"; toolUseId: string; content: string; isError: boolean }
  | {
      kind: "turn_result";
      success: boolean;
      costUsd: number;
      durationMs: number;
      errorText?: string;
      /** Agent session + last transcript entry of this turn: where an edited later message forks off. */
      agentSessionId?: string;
      lastChainUuid?: string;
      /** Tokens in the context window after this turn, and the window size (for the context indicator). */
      contextTokens?: number;
      contextWindow?: number;
    };

export type ChatItem = ChatItemPayload & { id: string; sessionId: string; createdAt: number };

type Row = Record<string, unknown>;

const mapProject = (row: Row): Project => ({
  id: String(row.id),
  name: String(row.name),
  path: String(row.path),
  icon: row.icon ? String(row.icon) : null,
  kind: row.kind === "quick" ? "quick" : "project",
  createdAt: Number(row.created_at),
});

const mapSession = (row: Row): Session => ({
  id: String(row.id),
  projectId: String(row.project_id),
  title: String(row.title),
  agentSessionId: row.agent_session_id ? String(row.agent_session_id) : null,
  backendId: row.backend_id ? String(row.backend_id) : null,
  forkOriginSessionId: row.fork_origin_session_id ? String(row.fork_origin_session_id) : null,
  forkOriginItemId: row.fork_origin_item_id ? String(row.fork_origin_item_id) : null,
  forkItemId: row.fork_item_id ? String(row.fork_item_id) : null,
  pendingFork: row.pending_fork ? (JSON.parse(String(row.pending_fork)) as PendingFork) : null,
  agentId: row.agent_id ? String(row.agent_id) : null,
  taskId: row.task_id ? String(row.task_id) : null,
  mailInboxId: row.mail_inbox_id ? String(row.mail_inbox_id) : null,
  directories: row.directories ? (JSON.parse(String(row.directories)) as string[]) : [],
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
});

export const projectStore = {
  list(): Project[] {
    return database.prepare("SELECT * FROM projects ORDER BY created_at DESC").all().map(mapProject);
  },
  get(projectId: string): Project | undefined {
    const row = database.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
    return row ? mapProject(row) : undefined;
  },
  create(name: string, projectPath: string, kind: ProjectKind = "project"): Project {
    const project: Project = { id: randomUUID(), name, path: projectPath, icon: null, kind, createdAt: Date.now() };
    database
      .prepare("INSERT INTO projects (id, name, path, kind, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(project.id, project.name, project.path, project.kind, project.createdAt);
    return project;
  },
  update(projectId: string, changes: { name?: string; icon?: string | null }): void {
    const current = projectStore.get(projectId);
    if (!current) return;
    database
      .prepare("UPDATE projects SET name = ?, icon = ? WHERE id = ?")
      .run(changes.name ?? current.name, changes.icon === undefined ? current.icon : changes.icon, projectId);
  },
  remove(projectId: string): void {
    database.prepare("DELETE FROM chat_items WHERE session_id IN (SELECT id FROM sessions WHERE project_id = ?)").run(projectId);
    database.prepare("DELETE FROM agent_messages WHERE session_id IN (SELECT id FROM sessions WHERE project_id = ?)").run(projectId);
    database.prepare("DELETE FROM sessions WHERE project_id = ?").run(projectId);
    database.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
  },
};

export const sessionStore = {
  listByProject(projectId: string): Session[] {
    return database
      .prepare("SELECT * FROM sessions WHERE project_id = ? ORDER BY updated_at DESC")
      .all(projectId)
      .map(mapSession);
  },
  get(sessionId: string): Session | undefined {
    const row = database.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId);
    return row ? mapSession(row) : undefined;
  },
  create(
    projectId: string,
    title: string,
    fork?: { originSessionId: string; originItemId: string; pendingFork: PendingFork | null },
    agentId: string | null = null,
  ): Session {
    const now = Date.now();
    const directories = fork ? (sessionStore.get(fork.originSessionId)?.directories ?? []) : [];
    const session: Session = {
      id: randomUUID(),
      projectId,
      title,
      agentSessionId: null,
      backendId: null,
      forkOriginSessionId: fork?.originSessionId ?? null,
      forkOriginItemId: fork?.originItemId ?? null,
      forkItemId: null,
      pendingFork: fork?.pendingFork ?? null,
      agentId,
      taskId: null,
      mailInboxId: null,
      directories,
      createdAt: now,
      updatedAt: now,
    };
    database
      .prepare(
        "INSERT INTO sessions (id, project_id, title, fork_origin_session_id, fork_origin_item_id, pending_fork, agent_id, directories, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        session.id,
        projectId,
        title,
        session.forkOriginSessionId,
        session.forkOriginItemId,
        session.pendingFork ? JSON.stringify(session.pendingFork) : null,
        agentId,
        directories.length ? JSON.stringify(directories) : null,
        now,
        now,
      );
    return session;
  },
  /** `agentSessionId: null` starts a fresh agent context on the next turn. */
  update(
    sessionId: string,
    changes: { title?: string; agentSessionId?: string | null; projectId?: string; forkItemId?: string; pendingFork?: null; agentId?: string | null; backendId?: string | null; directories?: string[] },
  ): void {
    const current = sessionStore.get(sessionId);
    if (!current) return;
    const pendingFork = changes.pendingFork === undefined ? current.pendingFork : changes.pendingFork;
    database
      .prepare("UPDATE sessions SET title = ?, agent_session_id = ?, project_id = ?, fork_item_id = ?, pending_fork = ?, agent_id = ?, backend_id = ?, directories = ?, updated_at = ? WHERE id = ?")
      .run(
        changes.title ?? current.title,
        changes.agentSessionId === undefined ? current.agentSessionId : changes.agentSessionId,
        changes.projectId ?? current.projectId,
        changes.forkItemId ?? current.forkItemId,
        pendingFork ? JSON.stringify(pendingFork) : null,
        changes.agentId === undefined ? current.agentId : changes.agentId,
        changes.backendId === undefined ? current.backendId : changes.backendId,
        (changes.directories ?? current.directories).length ? JSON.stringify(changes.directories ?? current.directories) : null,
        Date.now(),
        sessionId,
      );
  },
  /** Versions created by editing a message in this session. */
  listForks(sessionId: string): Session[] {
    return database.prepare("SELECT * FROM sessions WHERE fork_origin_session_id = ?").all(sessionId).map(mapSession);
  },
  /** Removes the session and every version forked from it. */
  remove(sessionId: string): void {
    for (const fork of sessionStore.listForks(sessionId)) sessionStore.remove(fork.id);
    database.prepare("DELETE FROM chat_items WHERE session_id = ?").run(sessionId);
    database.prepare("DELETE FROM agent_messages WHERE session_id = ?").run(sessionId);
    database.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
  },
};

export const chatItemStore = {
  list(sessionId: string): ChatItem[] {
    return database
      .prepare("SELECT * FROM chat_items WHERE session_id = ? ORDER BY created_at, rowid")
      .all(sessionId)
      .map((row) => ({
        ...(JSON.parse(String(row.payload)) as ChatItemPayload),
        id: String(row.id),
        sessionId: String(row.session_id),
        createdAt: Number(row.created_at),
      }));
  },
  clear(sessionId: string): void {
    database.prepare("DELETE FROM chat_items WHERE session_id = ?").run(sessionId);
  },
  append(sessionId: string, payload: ChatItemPayload, createdAt = Date.now()): ChatItem {
    const chatItem: ChatItem = { ...payload, id: randomUUID(), sessionId, createdAt };
    database
      .prepare("INSERT INTO chat_items (id, session_id, payload, created_at) VALUES (?, ?, ?, ?)")
      .run(chatItem.id, sessionId, JSON.stringify(payload), chatItem.createdAt);
    return chatItem;
  },
};

export const agentMessageStore = {
  list(sessionId: string): unknown[] {
    return database.prepare("SELECT payload FROM agent_messages WHERE session_id = ? ORDER BY sequence").all(sessionId).map((row) => JSON.parse(String(row.payload)));
  },
  append(sessionId: string, message: unknown): void {
    const next = database.prepare("SELECT COALESCE(MAX(sequence), -1) + 1 AS next FROM agent_messages WHERE session_id = ?").get(sessionId);
    database.prepare("INSERT INTO agent_messages (session_id, sequence, payload) VALUES (?, ?, ?)").run(sessionId, Number(next?.next ?? 0), JSON.stringify(message));
  },
  /** Replaces the whole history (after trimming). */
  replace(sessionId: string, messages: unknown[]): void {
    database.prepare("DELETE FROM agent_messages WHERE session_id = ?").run(sessionId);
    messages.forEach((message, index) => database.prepare("INSERT INTO agent_messages (session_id, sequence, payload) VALUES (?, ?, ?)").run(sessionId, index, JSON.stringify(message)));
  },
  clear(sessionId: string): void {
    database.prepare("DELETE FROM agent_messages WHERE session_id = ?").run(sessionId);
  },
};
