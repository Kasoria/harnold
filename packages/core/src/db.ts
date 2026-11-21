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

export type Project = { id: string; name: string; path: string; createdAt: number };
export type Session = {
  id: string;
  projectId: string;
  title: string;
  agentSessionId: string | null;
  createdAt: number;
  updatedAt: number;
};

/** Normalized, UI-facing chat entries (independent of the model provider). */
export type ChatItemPayload =
  | { kind: "user_text"; text: string }
  | { kind: "assistant_text"; text: string }
  | { kind: "tool_use"; toolUseId: string; toolName: string; input: unknown }
  | { kind: "tool_result"; toolUseId: string; content: string; isError: boolean }
  | { kind: "turn_result"; success: boolean; costUsd: number; durationMs: number; errorText?: string };

export type ChatItem = ChatItemPayload & { id: string; sessionId: string; createdAt: number };

type Row = Record<string, unknown>;

const mapProject = (row: Row): Project => ({
  id: String(row.id),
  name: String(row.name),
  path: String(row.path),
  createdAt: Number(row.created_at),
});

const mapSession = (row: Row): Session => ({
  id: String(row.id),
  projectId: String(row.project_id),
  title: String(row.title),
  agentSessionId: row.agent_session_id ? String(row.agent_session_id) : null,
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
  create(name: string, projectPath: string): Project {
    const project: Project = { id: randomUUID(), name, path: projectPath, createdAt: Date.now() };
    database
      .prepare("INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)")
      .run(project.id, project.name, project.path, project.createdAt);
    return project;
  },
  remove(projectId: string): void {
    database.prepare("DELETE FROM chat_items WHERE session_id IN (SELECT id FROM sessions WHERE project_id = ?)").run(projectId);
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
  create(projectId: string, title: string): Session {
    const now = Date.now();
    const session: Session = { id: randomUUID(), projectId, title, agentSessionId: null, createdAt: now, updatedAt: now };
    database
      .prepare("INSERT INTO sessions (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(session.id, projectId, title, now, now);
    return session;
  },
  update(sessionId: string, changes: { title?: string; agentSessionId?: string }): void {
    const current = sessionStore.get(sessionId);
    if (!current) return;
    database
      .prepare("UPDATE sessions SET title = ?, agent_session_id = ?, updated_at = ? WHERE id = ?")
      .run(changes.title ?? current.title, changes.agentSessionId ?? current.agentSessionId, Date.now(), sessionId);
  },
  remove(sessionId: string): void {
    database.prepare("DELETE FROM chat_items WHERE session_id = ?").run(sessionId);
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
  append(sessionId: string, payload: ChatItemPayload): ChatItem {
    const chatItem: ChatItem = { ...payload, id: randomUUID(), sessionId, createdAt: Date.now() };
    database
      .prepare("INSERT INTO chat_items (id, session_id, payload, created_at) VALUES (?, ?, ?, ?)")
      .run(chatItem.id, sessionId, JSON.stringify(payload), chatItem.createdAt);
    return chatItem;
  },
};
