import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import type { PermissionMode } from "./backends/types.ts";
import { chatItemStore, database, projectStore, sessionStore } from "./db.ts";
import { agentRuntime } from "./agent.ts";
import { eventHub } from "./events.ts";
import { teamStore } from "./agents.ts";
import { currentLanguage, t } from "./i18n.ts";
import { checkTaskDirectories } from "./folders.ts";

database.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    schedule TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    permission_mode TEXT NOT NULL DEFAULT 'acceptEdits',
    model TEXT,
    notify_channel_id TEXT,
    notify_chat_id TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS task_runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    session_id TEXT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    status TEXT NOT NULL,
    summary TEXT
  );
  CREATE INDEX IF NOT EXISTS task_runs_by_task ON task_runs(task_id, started_at);
`);
const taskColumns = new Set((database.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((column) => column.name));
if (!taskColumns.has("agent_id")) database.exec("ALTER TABLE tasks ADD COLUMN agent_id TEXT");
if (!taskColumns.has("session_mode")) database.exec("ALTER TABLE tasks ADD COLUMN session_mode TEXT NOT NULL DEFAULT 'new'");
if (!taskColumns.has("continued_session_id")) database.exec("ALTER TABLE tasks ADD COLUMN continued_session_id TEXT");
if (!taskColumns.has("cleanup_after_days")) database.exec("ALTER TABLE tasks ADD COLUMN cleanup_after_days INTEGER");
if (!taskColumns.has("context_reset_runs")) database.exec("ALTER TABLE tasks ADD COLUMN context_reset_runs INTEGER");
if (!taskColumns.has("runs_since_reset")) database.exec("ALTER TABLE tasks ADD COLUMN runs_since_reset INTEGER NOT NULL DEFAULT 0");
if (!taskColumns.has("directories")) database.exec("ALTER TABLE tasks ADD COLUMN directories TEXT");
// Sessions of earlier runs belong to their task too.
database.exec(
  "UPDATE sessions SET task_id = (SELECT task_id FROM task_runs WHERE task_runs.session_id = sessions.id LIMIT 1) WHERE task_id IS NULL AND id IN (SELECT session_id FROM task_runs WHERE session_id IS NOT NULL)",
);

/** "new": every run gets its own session; "continue": all runs in one session, so the agent knows earlier runs. */
export type TaskSessionMode = "new" | "continue";

export type Task = {
  id: string;
  projectId: string;
  name: string;
  prompt: string;
  schedule: string;
  enabled: boolean;
  permissionMode: PermissionMode;
  model: string | null;
  /** Team member that runs the task (null = default agent). */
  agentId: string | null;
  sessionMode: TaskSessionMode;
  /** "new" mode, opt-in: run sessions older than this are deleted after the next run. null = keep all. */
  cleanupAfterDays: number | null;
  /** "continue" mode, opt-in: the agent starts with a fresh context after this many runs; the history stays. null = never. */
  contextResetRuns: number | null;
  /** Folders the runs may work in, besides the project folder and the project's folder context. */
  directories: string[];
  notifyChannelId: string | null;
  notifyChatId: string | null;
  createdAt: number;
};

export type TaskRun = {
  id: string;
  taskId: string;
  sessionId: string | null;
  startedAt: number;
  finishedAt: number | null;
  status: "running" | "success" | "error";
  summary: string | null;
};

export type TaskInput = Omit<Task, "id" | "createdAt">;

type Row = Record<string, unknown>;

const mapTask = (row: Row): Task => ({
  id: String(row.id),
  projectId: String(row.project_id),
  name: String(row.name),
  prompt: String(row.prompt),
  schedule: String(row.schedule),
  enabled: Boolean(row.enabled),
  permissionMode: String(row.permission_mode) as PermissionMode,
  model: row.model ? String(row.model) : null,
  agentId: row.agent_id ? String(row.agent_id) : null,
  sessionMode: row.session_mode === "continue" ? "continue" : "new",
  cleanupAfterDays: row.cleanup_after_days ? Number(row.cleanup_after_days) : null,
  contextResetRuns: row.context_reset_runs ? Number(row.context_reset_runs) : null,
  directories: row.directories ? (JSON.parse(String(row.directories)) as string[]) : [],
  notifyChannelId: row.notify_channel_id ? String(row.notify_channel_id) : null,
  notifyChatId: row.notify_chat_id ? String(row.notify_chat_id) : null,
  createdAt: Number(row.created_at),
});

const mapTaskRun = (row: Row): TaskRun => ({
  id: String(row.id),
  taskId: String(row.task_id),
  sessionId: row.session_id ? String(row.session_id) : null,
  startedAt: Number(row.started_at),
  finishedAt: row.finished_at ? Number(row.finished_at) : null,
  status: String(row.status) as TaskRun["status"],
  summary: row.summary ? String(row.summary) : null,
});

export function validateSchedule(schedule: string): void {
  try {
    new Cron(schedule, { paused: true }).stop();
  } catch {
    throw new Error(t("Ungültiger Zeitplan: {0}", schedule));
  }
}

/**
 * A run session exists only for its run – unless the task continues in it (`sessionMode` "continue")
 * or another run still points to it.
 */
function removeRunSession(sessionId: string | null): void {
  if (!sessionId) return;
  const stillUsed =
    database.prepare("SELECT 1 FROM task_runs WHERE session_id = ? LIMIT 1").get(sessionId) ?? database.prepare("SELECT 1 FROM tasks WHERE continued_session_id = ? LIMIT 1").get(sessionId);
  const session = sessionStore.get(sessionId);
  if (stillUsed || !session || agentRuntime.isRunning(sessionId)) return;
  sessionStore.remove(sessionId);
  eventHub.publish({ type: "sessions_changed", projectId: session.projectId });
}

export const taskStore = {
  list(): Task[] {
    return database.prepare("SELECT * FROM tasks ORDER BY created_at DESC").all().map(mapTask);
  },
  get(taskId: string): Task | undefined {
    const row = database.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    return row ? mapTask(row) : undefined;
  },
  save(taskInput: TaskInput, taskId?: string): Task {
    validateSchedule(taskInput.schedule);
    const existing = taskId ? taskStore.get(taskId) : undefined;
    const task: Task = { ...taskInput, directories: checkTaskDirectories(taskInput.directories ?? []), id: existing?.id ?? randomUUID(), createdAt: existing?.createdAt ?? Date.now() };
    database
      .prepare(
        `INSERT INTO tasks (id, project_id, name, prompt, schedule, enabled, permission_mode, model, agent_id, session_mode, cleanup_after_days, context_reset_runs, directories, notify_channel_id, notify_chat_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, name = excluded.name, prompt = excluded.prompt,
           schedule = excluded.schedule, enabled = excluded.enabled, permission_mode = excluded.permission_mode, model = excluded.model,
           agent_id = excluded.agent_id, session_mode = excluded.session_mode,
           cleanup_after_days = excluded.cleanup_after_days, context_reset_runs = excluded.context_reset_runs,
           directories = excluded.directories,
           notify_channel_id = excluded.notify_channel_id, notify_chat_id = excluded.notify_chat_id`,
      )
      .run(
        task.id,
        task.projectId,
        task.name,
        task.prompt,
        task.schedule,
        task.enabled ? 1 : 0,
        task.permissionMode,
        task.model,
        task.agentId,
        task.sessionMode,
        task.cleanupAfterDays,
        task.contextResetRuns,
        task.directories.length ? JSON.stringify(task.directories) : null,
        task.notifyChannelId,
        task.notifyChatId,
        task.createdAt,
      );
    return task;
  },
  remove(taskId: string): void {
    database.prepare("DELETE FROM task_runs WHERE task_id = ?").run(taskId);
    database.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
  },
  /** Removes one result; its session goes with it unless the task or another run still uses it. */
  removeRun(runId: string): boolean {
    const row = database.prepare("SELECT * FROM task_runs WHERE id = ?").get(runId) as Row | undefined;
    if (!row) return false;
    const taskRun = mapTaskRun(row);
    if (taskRun.status === "running") return false;
    database.prepare("DELETE FROM task_runs WHERE id = ?").run(runId);
    removeRunSession(taskRun.sessionId);
    return true;
  },
  /** Removes all finished results of a task (e.g. to empty the list). */
  removeFinishedRuns(taskId: string): number {
    const runIds = (database.prepare("SELECT * FROM task_runs WHERE task_id = ? AND status != 'running'").all(taskId) as Row[]).map((row) => mapTaskRun(row));
    for (const taskRun of runIds) {
      database.prepare("DELETE FROM task_runs WHERE id = ?").run(taskRun.id);
      removeRunSession(taskRun.sessionId);
    }
    return runIds.length;
  },
  listRuns(taskId: string, limit = 20): TaskRun[] {
    return database.prepare("SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT ?").all(taskId, limit).map(mapTaskRun);
  },
  /** Finished or running runs of all tasks since a point in time, newest first. */
  listRecentRuns(sinceMs: number, limit = 10): TaskRun[] {
    return database.prepare("SELECT * FROM task_runs WHERE started_at >= ? ORDER BY started_at DESC LIMIT ?").all(sinceMs, limit).map(mapTaskRun);
  },
  lastRun(taskId: string): TaskRun | undefined {
    return taskStore.listRuns(taskId, 1)[0];
  },
};

/** Delivers a finished run somewhere outside the app (set by the channel manager to avoid an import cycle). */
type RunNotifier = (task: Task, message: string) => Promise<void>;
let runNotifier: RunNotifier | undefined;
export function setTaskRunNotifier(notifier: RunNotifier): void {
  runNotifier = notifier;
}

const scheduledJobs = new Map<string, Cron>();

function createTaskSession(task: Task, title: string, agentId: string | null) {
  const session = sessionStore.create(task.projectId, title, undefined, agentId);
  database.prepare("UPDATE sessions SET task_id = ? WHERE id = ?").run(task.id, session.id);
  // The run works in the folders of the task (the project's folder context is added on every turn).
  if (task.directories.length && !session.directories.length) sessionStore.update(session.id, { directories: task.directories });
  return session;
}

/**
 * New session per run, or the task's ongoing session (recreated if it was deleted or moved to another project).
 * In the ongoing session the agent optionally starts fresh after `contextResetRuns` runs; the history stays visible.
 */
function sessionForRun(task: Task, startedAt: number) {
  // A deleted team member falls back to the default agent.
  const agentId = task.agentId && teamStore.get(task.agentId) ? task.agentId : null;
  if (task.sessionMode === "continue") {
    const taskRow = database.prepare("SELECT continued_session_id, runs_since_reset FROM tasks WHERE id = ?").get(task.id) as
      | { continued_session_id: string | null; runs_since_reset: number }
      | undefined;
    const continuedSession = taskRow?.continued_session_id ? sessionStore.get(taskRow.continued_session_id) : undefined;
    if (continuedSession && continuedSession.projectId === task.projectId) {
      const resetDue = task.contextResetRuns !== null && (taskRow?.runs_since_reset ?? 0) >= task.contextResetRuns;
      if (continuedSession.agentId !== agentId || resetDue) {
        sessionStore.update(continuedSession.id, { agentId, agentSessionId: null });
        database.prepare("UPDATE tasks SET runs_since_reset = 0 WHERE id = ?").run(task.id);
        if (resetDue) {
          const chatItem = chatItemStore.append(continuedSession.id, { kind: "notice", text: t("Neuer Kontext: Der Agent beginnt ab hier ohne die Läufe davor (nach {0} Läufen).", task.contextResetRuns) });
          eventHub.publish({ type: "chat_item", sessionId: continuedSession.id, chatItem });
        }
      }
      if (task.directories.join("\n") !== continuedSession.directories.join("\n")) sessionStore.update(continuedSession.id, { directories: task.directories });
      database.prepare("UPDATE tasks SET runs_since_reset = runs_since_reset + 1 WHERE id = ?").run(task.id);
      return continuedSession;
    }
    const newSession = createTaskSession(task, `Task · ${task.name}`, agentId);
    database.prepare("UPDATE tasks SET continued_session_id = ?, runs_since_reset = 1 WHERE id = ?").run(newSession.id, task.id);
    return newSession;
  }
  const runTime = new Date(startedAt).toLocaleString(currentLanguage() === "en" ? "en-US" : "de-DE", { dateStyle: "short", timeStyle: "short" });
  return createTaskSession(task, `Task · ${task.name} · ${runTime}`, agentId);
}

/** Opt-in (cleanupAfterDays): removes this task's run sessions older than the limit. Never touches the ongoing session. */
function cleanUpOldRuns(task: Task, currentSessionId: string): void {
  if (task.sessionMode !== "new" || task.cleanupAfterDays === null) return;
  const cutoff = Date.now() - task.cleanupAfterDays * 24 * 60 * 60 * 1000;
  const oldSessionIds = (database.prepare("SELECT id FROM sessions WHERE task_id = ? AND created_at < ? AND id != ?").all(task.id, cutoff, currentSessionId) as { id: string }[]).map(
    (row) => row.id,
  );
  for (const sessionId of oldSessionIds) {
    if (agentRuntime.isRunning(sessionId)) continue;
    sessionStore.remove(sessionId);
    // The result belongs to the session – without it there is nothing left to show.
    database.prepare("DELETE FROM task_runs WHERE session_id = ?").run(sessionId);
  }
  if (oldSessionIds.length) eventHub.publish({ type: "sessions_changed", projectId: task.projectId });
}

export async function runTask(taskId: string): Promise<TaskRun> {
  const task = taskStore.get(taskId);
  if (!task) throw new Error(t("Task nicht gefunden"));
  if (!projectStore.get(task.projectId)) throw new Error(t("Projekt des Tasks existiert nicht mehr"));

  const startedAt = Date.now();
  const session = sessionForRun(task, startedAt);
  eventHub.publish({ type: "sessions_changed", projectId: task.projectId });

  const taskRun: TaskRun = { id: randomUUID(), taskId, sessionId: session.id, startedAt, finishedAt: null, status: "running", summary: null };
  database
    .prepare("INSERT INTO task_runs (id, task_id, session_id, started_at, status) VALUES (?, ?, ?, ?, ?)")
    .run(taskRun.id, taskId, session.id, startedAt, "running");
  eventHub.publish({ type: "tasks_changed" });

  const turnOutcome = await agentRuntime.runTurn({
    sessionId: session.id,
    text: task.prompt,
    permissionMode: task.permissionMode,
    model: task.model ?? undefined,
  });

  taskRun.finishedAt = Date.now();
  taskRun.status = turnOutcome.success ? "success" : "error";
  taskRun.summary = (turnOutcome.success ? turnOutcome.finalText : turnOutcome.errorText || "Fehlgeschlagen").slice(0, 4000);
  database
    .prepare("UPDATE task_runs SET finished_at = ?, status = ?, summary = ? WHERE id = ?")
    .run(taskRun.finishedAt, taskRun.status, taskRun.summary, taskRun.id);
  eventHub.publish({ type: "tasks_changed" });
  cleanUpOldRuns(task, session.id);
  eventHub.publish({ type: "task_run_finished", taskId, taskName: task.name, sessionId: session.id, projectId: task.projectId, success: turnOutcome.success });

  if (task.notifyChannelId && task.notifyChatId && runNotifier) {
    const headline = t("{0} Task „{1}“", turnOutcome.success ? "✅" : "⚠️", task.name);
    await runNotifier(task, `${headline}\n\n${taskRun.summary}`).catch((notifyError) => console.error("[tasks] notify failed:", notifyError));
  }
  return taskRun;
}

export function nextRunOf(task: Task): number | null {
  if (!task.enabled) return null;
  return scheduledJobs.get(task.id)?.nextRun()?.getTime() ?? null;
}

/** (Re)creates the cron job for one task. Overlapping runs are skipped (protect). */
export function scheduleTask(task: Task): void {
  scheduledJobs.get(task.id)?.stop();
  scheduledJobs.delete(task.id);
  if (!task.enabled) return;
  const job = new Cron(task.schedule, { protect: true }, async () => {
    try {
      await runTask(task.id);
    } catch (runError) {
      console.error(`[tasks] run of ${task.name} failed:`, runError);
    }
  });
  scheduledJobs.set(task.id, job);
}

export function unscheduleTask(taskId: string): void {
  scheduledJobs.get(taskId)?.stop();
  scheduledJobs.delete(taskId);
}

export function startScheduler(): void {
  for (const task of taskStore.list()) {
    try {
      scheduleTask(task);
    } catch (scheduleError) {
      console.error(`[tasks] could not schedule ${task.name}:`, scheduleError);
    }
  }
}
