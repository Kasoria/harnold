import type { ChatItem } from "./db.ts";
import type { QueuedMessage } from "./agent.ts";
import type { BackgroundTask } from "./backends/types.ts";

/** Everything the core pushes to connected clients. */
export type ServerEvent =
  | { type: "chat_item"; sessionId: string; chatItem: ChatItem }
  | { type: "text_delta"; sessionId: string; text: string }
  | { type: "thinking_delta"; sessionId: string; text: string }
  | { type: "session_cleared"; sessionId: string }
  | { type: "session_moved"; sessionId: string; fromProjectId: string; toProjectId: string }
  | { type: "turn_state"; sessionId: string; running: boolean }
  | { type: "queue_changed"; sessionId: string; queue: QueuedMessage[] }
  /** Live context size during a turn (from each model request). */
  | { type: "context_size"; sessionId: string; tokens: number }
  | {
      type: "permission_request";
      sessionId: string;
      requestId: string;
      toolName: string;
      input: unknown;
      /** "Always allow" offer: what the agent program would remember (label for the button). */
      alwaysAllowLabel?: string;
    }
  /** Live status line of a running turn (retry, compacting, subagent progress); null clears it. */
  | { type: "agent_status"; sessionId: string; text: string | null }
  | { type: "background_tasks"; sessionId: string; tasks: BackgroundTask[] }
  /** The agent switched the permission mode (e.g. plan approved → edits allowed); the composer follows. */
  | { type: "permission_mode_changed"; sessionId: string; permissionMode: string }
  | { type: "permission_resolved"; sessionId: string; requestId: string }
  | { type: "files_changed"; projectId: string; paths: string[] }
  /** The agent is editing a file (tool call) or finished it; root = project folder the path is relative to. */
  | { type: "file_activity"; projectId: string; sessionId: string; root: string; path: string; phase: "editing" | "done" | "failed"; at: number }
  | { type: "sessions_changed"; projectId: string }
  | { type: "tasks_changed" }
  /** Folders with access changed – the memory and task screens reload. */
  | { type: "folders_changed" }
  /** Task results changed (e.g. removed) – reload the today overview. */
  | { type: "today_changed" }
  | { type: "task_run_finished"; taskId: string; taskName: string; sessionId: string; projectId: string; success: boolean }
  | { type: "channels_changed" }
  | { type: "mail_changed" }
  | { type: "memory_changed"; projectId: string | null }
  | { type: "integrations_changed" }
  | { type: "design_systems_changed" }
  | { type: "claude_auth_changed" }
  | { type: "environments_changed" }
  | { type: "team_changed" }
  | { type: "projects_changed" }
  | { type: "settings_changed" };

type Listener = (serverEvent: ServerEvent) => void;
const listeners = new Set<Listener>();

export const eventHub = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  publish(serverEvent: ServerEvent): void {
    for (const listener of listeners) listener(serverEvent);
  },
};
