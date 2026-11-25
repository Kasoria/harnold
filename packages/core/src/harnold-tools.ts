import type { Project } from "./db.ts";
import { createMediaServer, mediaServerName } from "./media-tools.ts";
import { createWorkspaceServer, workspaceServerName, workspaceToolNames } from "./workspace-tools.ts";
import { createMemoryServer, memoryServerName, memoryToolNames } from "./memory-tools.ts";

/**
 * Harnold's own tools for the agent (memory, media, workspace/team/setup), as MCP servers.
 * Claude Code runs them in-process; other agent programs reach them over HTTP (mcp-http.ts).
 */
/** permissionMode may be a getter: a long-running agent process can switch modes between turns. */
export function createHarnoldToolServers(project: Project, sessionId: string, permissionMode: string | (() => string)) {
  return {
    [memoryServerName]: createMemoryServer(project),
    [mediaServerName]: createMediaServer(project),
    [workspaceServerName]: createWorkspaceServer(project, sessionId, permissionMode),
  };
}

/** Tools that run without asking (`mcp__<server>__<tool>`); the rest needs a per-call permission. */
export const harnoldAutoAllowedToolNames = [...workspaceToolNames, ...memoryToolNames];
