import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { database, projectStore, sessionStore } from "./db.ts";
import { agentRuntime } from "./agent.ts";
import { eventHub } from "./events.ts";
import { currentLanguage, t } from "./i18n.ts";

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

export type Task = {
  id: string;
  projectId: string;
  name: string;
  prompt: string;
  schedule: string;
  enabled: boolean;
  permissionMode: PermissionMode;
  model: string | null;
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
    const task: Task = { ...taskInput, id: existing?.id ?? randomUUID(), createdAt: existing?.createdAt ?? Date.now() };
    database
      .prepare(
        `INSERT INTO tasks (id, project_id, name, prompt, schedule, enabled, permission_mode, model, notify_channel_id, notify_chat_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, name = excluded.name, prompt = excluded.prompt,
           schedule = excluded.schedule, enabled = excluded.enabled, permission_mode = excluded.permission_mode, model = excluded.model,
           notify_channel_id = excluded.notify_channel_id, notify_chat_id = excluded.notify_chat_id`,
      )
      .run(task.id, task.projectId, task.name, task.prompt, task.schedule, task.enabled ? 1 : 0, task.permissionMode, task.model, task.notifyChannelId, task.notifyChatId, task.createdAt);
    return task;
  },
  remove(taskId: string): void {
    database.prepare("DELETE FROM task_runs WHERE task_id = ?").run(taskId);
    database.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
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

export async function runTask(taskId: string): Promise<TaskRun> {
  const task = taskStore.get(taskId);
  if (!task) throw new Error(t("Task nicht gefunden"));
  if (!projectStore.get(task.projectId)) throw new Error(t("Projekt des Tasks existiert nicht mehr"));

  const startedAt = Date.now();
  const session = sessionStore.create(task.projectId, `Task · ${task.name} · ${new Date(startedAt).toLocaleString(currentLanguage() === "en" ? "en-US" : "de-DE", { dateStyle: "short", timeStyle: "short" })}`);
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
