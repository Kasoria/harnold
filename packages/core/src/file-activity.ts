import path from "node:path";
import { projectStore, sessionStore, type ChatItemPayload } from "./db.ts";
import { eventHub } from "./events.ts";
import { projectRootPaths } from "./project-roots.ts";

/**
 * Live activity for the canvas: which file the agent is editing right now. Derived from the agent's tool calls
 * (not from a file watcher), so it covers attached code folders too, which aren't watched.
 */

const fileEditingToolNames = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
type PendingEdit = { projectId: string; sessionId: string; root: string; path: string };
const pendingEditsByToolUseId = new Map<string, PendingEdit>();

function editedFileOf(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const filePath = record.file_path ?? record.notebook_path;
  return typeof filePath === "string" && filePath ? filePath : null;
}

/** The project root that contains the file (deepest wins) and the path relative to it. */
function locateInProject(projectId: string, filePath: string): { root: string; path: string } | null {
  const project = projectStore.get(projectId);
  if (!project) return null;
  const absolutePath = path.resolve(project.path, filePath);
  const containingRoot = projectRootPaths(project)
    .filter((rootPath) => absolutePath.startsWith(rootPath + path.sep))
    .sort((first, second) => second.length - first.length)[0];
  if (!containingRoot) return null;
  return { root: containingRoot, path: path.relative(containingRoot, absolutePath).split(path.sep).join("/") };
}

export function publishFileActivity(sessionId: string, payload: ChatItemPayload): void {
  if (payload.kind === "tool_use" && fileEditingToolNames.has(payload.toolName)) {
    const filePath = editedFileOf(payload.input);
    const session = sessionStore.get(sessionId);
    if (!filePath || !session) return;
    const location = locateInProject(session.projectId, filePath);
    if (!location) return;
    const pendingEdit = { projectId: session.projectId, sessionId, ...location };
    pendingEditsByToolUseId.set(payload.toolUseId, pendingEdit);
    eventHub.publish({ type: "file_activity", ...pendingEdit, phase: "editing", at: Date.now() });
  } else if (payload.kind === "tool_result") {
    const pendingEdit = pendingEditsByToolUseId.get(payload.toolUseId);
    if (!pendingEdit) return;
    pendingEditsByToolUseId.delete(payload.toolUseId);
    eventHub.publish({ type: "file_activity", ...pendingEdit, phase: payload.isError ? "failed" : "done", at: Date.now() });
  }
}
