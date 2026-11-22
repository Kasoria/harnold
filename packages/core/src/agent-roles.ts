import { settingsStore } from "./settings.ts";
import { normalizeBackendId, type AgentBackendId } from "./agent-backend-settings.ts";

/**
 * Which agent program and model a role should use, workspace-wide – the fallback between "one setting for everything"
 * and "configure every unit". A unit's own choice always wins; what neither names comes from here, before the plain
 * workspace/environment default.
 */
export type AgentRole = "chat" | "automation";
export const agentRoles: AgentRole[] = ["chat", "automation"];

export type AgentRoleDefaults = { backendId: AgentBackendId | null; model: string | null };
export type AgentRoleSettings = Record<AgentRole, AgentRoleDefaults>;

const rolesKey = "agent.roles";
const emptyRoles: AgentRoleSettings = { chat: { backendId: null, model: null }, automation: { backendId: null, model: null } };

/** Where a turn comes from, when the caller does not say: a normal conversation is the interactive role. */
export const defaultAgentRole: AgentRole = "chat";

export const agentRoleSettings = {
  read(): AgentRoleSettings {
    const stored = settingsStore.read<Partial<Record<AgentRole, Partial<AgentRoleDefaults>>>>(rolesKey, {});
    const forRole = (role: AgentRole): AgentRoleDefaults => ({
      backendId: normalizeBackendId(stored[role]?.backendId),
      model: stored[role]?.model?.trim() || null,
    });
    return { chat: forRole("chat"), automation: forRole("automation") };
  },
  /** Only the given roles change; the others keep their values. An empty program/model means "inherit". */
  write(changes: Partial<Record<AgentRole, { backendId: string | null; model: string | null } | undefined>>): AgentRoleSettings {
    const current = agentRoleSettings.read();
    // Keep every role's current value; only the ones passed in change.
    const next: AgentRoleSettings = { chat: current.chat, automation: current.automation };
    for (const role of agentRoles) {
      const change = changes[role];
      if (!change) continue;
      next[role] = { backendId: normalizeBackendId(change.backendId), model: change.model?.trim() || null };
    }
    settingsStore.write(rolesKey, next);
    return next;
  },
  of(role: AgentRole | null | undefined): AgentRoleDefaults {
    return agentRoleSettings.read()[role ?? defaultAgentRole];
  },
};
