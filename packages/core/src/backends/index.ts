import { agentBackendSettings, defaultAgentBackendId, type AgentBackendId } from "../agent-backend-settings.ts";
import { eventHub } from "../events.ts";
import { claudeCodeBackend } from "./claude-code.ts";
import { codexBackend } from "./codex.ts";
import { nativeBackend } from "./native/index.ts";
import type { AgentBackend, BackendStatus } from "./types.ts";

const backends: Record<AgentBackendId, AgentBackend> = { "claude-code": claudeCodeBackend, codex: codexBackend, native: nativeBackend };

export type AgentBackendsView = { activeId: AgentBackendId; backends: BackendStatus[] };

/** The agent programs Harnold can drive; which one runs is a setting (and an environment may override it). */
export const agentBackends = {
  get: (backendId: AgentBackendId | null | undefined): AgentBackend => backends[backendId ?? defaultAgentBackendId] ?? backends[defaultAgentBackendId],
  active: (): AgentBackend => backends[agentBackendSettings.read()],
  list: (): AgentBackend[] => Object.values(backends),

  async view(forceRefresh = false): Promise<AgentBackendsView> {
    return { activeId: agentBackendSettings.read(), backends: await Promise.all(Object.values(backends).map((backend) => backend.status(forceRefresh))) };
  },

  setActive(backendId: AgentBackendId): void {
    agentBackendSettings.write(backendId);
    eventHub.publish({ type: "claude_auth_changed" });
  },
};
