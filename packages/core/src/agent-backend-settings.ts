import { settingsStore } from "./settings.ts";

/** Agent programs Harnold can drive. Which one is used is a setting, never hard-wired. */
export type AgentBackendId = "claude-code" | "codex" | "native";
export const agentBackendIds: AgentBackendId[] = ["claude-code", "codex", "native"];
export const defaultAgentBackendId: AgentBackendId = "claude-code";

const activeKey = "agent.backend";

export const isAgentBackendId = (value: unknown): value is AgentBackendId => agentBackendIds.includes(value as AgentBackendId);

/** A unit's own backend choice (team agent, channel, mailbox, task): null = inherit the workspace/environment one. */
export const normalizeBackendId = (value: string | null | undefined): AgentBackendId | null => (isAgentBackendId(value) ? value : null);

/** Workspace-wide choice; sessions remember the backend they started with. */
export const agentBackendSettings = {
  read: (): AgentBackendId => {
    const stored = settingsStore.read<string>(activeKey, defaultAgentBackendId);
    return isAgentBackendId(stored) ? stored : defaultAgentBackendId;
  },
  write: (backendId: AgentBackendId): void => settingsStore.write(activeKey, backendId),
};
