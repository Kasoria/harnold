import fs from "node:fs";
import path from "node:path";
import { config } from "./config.ts";
import { projectStore, sessionStore, type Project, type Session } from "./db.ts";
import { eventHub } from "./events.ts";
import { settingsStore } from "./settings.ts";
import { agentRuntime } from "./agent.ts";

/** Chats without a project live in one built-in project of kind "quick". */
export function quickChatProject(): Project {
  const existing = projectStore.list().find((project) => project.kind === "quick");
  if (existing) return existing;
  const quickChatsDirectory = path.join(config.dataDirectory, "quick-chats");
  fs.mkdirSync(quickChatsDirectory, { recursive: true });
  return projectStore.create("Quick Chats", quickChatsDirectory, "quick");
}

export type QuickChatSettings = { autoDeleteDays: number | null };

export const quickChatSettings = {
  read: (): QuickChatSettings => settingsStore.read<QuickChatSettings>("quickChats", { autoDeleteDays: null }),
  write: (settings: QuickChatSettings) => settingsStore.write("quickChats", settings),
};

/** Deletes Quick Chats whose whole conversation (all versions) was untouched for longer than the configured days. */
export function deleteExpiredQuickChats(): number {
  const { autoDeleteDays } = quickChatSettings.read();
  if (!autoDeleteDays) return 0;
  const project = quickChatProject();
  const cutoff = Date.now() - autoDeleteDays * 24 * 60 * 60 * 1000;
  const sessions = sessionStore.listByProject(project.id);
  const lastActivityOf = (session: Session): number =>
    Math.max(session.updatedAt, ...sessions.filter((candidate) => candidate.forkOriginSessionId === session.id).map(lastActivityOf));
  const expiredRoots = sessions.filter(
    (session) => !session.forkOriginSessionId && lastActivityOf(session) < cutoff && !agentRuntime.isRunning(session.id),
  );
  for (const session of expiredRoots) sessionStore.remove(session.id);
  if (expiredRoots.length > 0) eventHub.publish({ type: "sessions_changed", projectId: project.id });
  return expiredRoots.length;
}

export function startQuickChatCleanup(): void {
  quickChatProject();
  deleteExpiredQuickChats();
  setInterval(deleteExpiredQuickChats, 60 * 60 * 1000).unref();
}
