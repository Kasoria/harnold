import { randomUUID } from "node:crypto";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { database, projectStore, sessionStore, type Project } from "./db.ts";
import { eventHub } from "./events.ts";
import { environmentStore } from "./environments.ts";
import { t } from "./i18n.ts";

/**
 * Team: several agents (experts) per environment – each with its own role, instructions and model. Every conversation
 * can be with one of them; they reach each other via team_ask, which runs a turn in the other agent's own session.
 */
database.exec(`
  CREATE TABLE IF NOT EXISTS team_agents (
    id TEXT PRIMARY KEY,
    environment_id TEXT,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT '',
    instructions TEXT NOT NULL DEFAULT '',
    model TEXT,
    icon TEXT,
    created_at INTEGER NOT NULL
  );
`);

export const teamAgentInputSchema = z.object({
  /** null = available in every environment. */
  environmentId: z.string().nullable(),
  name: z.string().trim().min(1).max(40),
  role: z.string().trim().max(200),
  instructions: z.string().max(20_000),
  model: z.string().trim().nullable(),
  icon: z.string().trim().max(40).nullable(),
});
export type TeamAgentInput = z.infer<typeof teamAgentInputSchema>;
export type TeamAgent = TeamAgentInput & { id: string; createdAt: number };

type Row = Record<string, unknown>;
const mapAgent = (row: Row): TeamAgent => ({
  id: String(row.id),
  environmentId: row.environment_id ? String(row.environment_id) : null,
  name: String(row.name),
  role: String(row.role),
  instructions: String(row.instructions),
  model: row.model ? String(row.model) : null,
  icon: row.icon ? String(row.icon) : null,
  createdAt: Number(row.created_at),
});

export const teamStore = {
  list(): TeamAgent[] {
    return (database.prepare("SELECT * FROM team_agents ORDER BY created_at").all() as Row[]).map(mapAgent);
  },
  get(agentId: string): TeamAgent | undefined {
    const row = database.prepare("SELECT * FROM team_agents WHERE id = ?").get(agentId) as Row | undefined;
    return row ? mapAgent(row) : undefined;
  },
  save(agentInput: TeamAgentInput, agentId?: string): TeamAgent {
    if (agentInput.environmentId) environmentStore.get(agentInput.environmentId);
    const existing = agentId ? teamStore.get(agentId) : undefined;
    if (agentId && !existing) throw new Error(t("Agent nicht gefunden"));
    const duplicate = teamStore
      .list()
      .find((agent) => agent.id !== agentId && agent.name.toLowerCase() === agentInput.name.toLowerCase() && agent.environmentId === agentInput.environmentId);
    if (duplicate) throw new Error(t("Name „{0}“ gibt es in diesem Team schon", agentInput.name));
    const id = existing?.id ?? randomUUID();
    database
      .prepare(
        `INSERT INTO team_agents (id, environment_id, name, role, instructions, model, icon, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET environment_id = excluded.environment_id, name = excluded.name, role = excluded.role,
           instructions = excluded.instructions, model = excluded.model, icon = excluded.icon`,
      )
      .run(id, agentInput.environmentId, agentInput.name, agentInput.role, agentInput.instructions, agentInput.model || null, agentInput.icon || null, existing?.createdAt ?? Date.now());
    eventHub.publish({ type: "team_changed" });
    return teamStore.get(id)!;
  },
  remove(agentId: string): void {
    database.prepare("DELETE FROM team_agents WHERE id = ?").run(agentId);
    database.prepare("UPDATE sessions SET agent_id = NULL WHERE agent_id = ?").run(agentId);
    eventHub.publish({ type: "team_changed" });
  },
  /** Team of a project: agents of its environment plus those available everywhere; Quick Chats reach everyone. */
  forProject(projectId: string): TeamAgent[] {
    if (projectStore.get(projectId)?.kind === "quick") return teamStore.list();
    const environmentId = environmentStore.forProject(projectId)?.id ?? null;
    return teamStore.list().filter((agent) => agent.environmentId === null || agent.environmentId === environmentId);
  },
};

/** System prompt part: who this agent is and who else is on the team. */
export function teamContextFor(project: Project, agentId: string | null): string {
  const team = teamStore.forProject(project.id);
  const ownAgent = agentId ? teamStore.get(agentId) : undefined;
  const parts: string[] = [];
  if (ownAgent) {
    parts.push(`Du bist „${ownAgent.name}“${ownAgent.role ? ` – ${ownAgent.role}` : ""}. Bleib in dieser Rolle.${ownAgent.instructions.trim() ? `\n${ownAgent.instructions.trim()}` : ""}`);
  }
  const colleagues = team.filter((agent) => agent.id !== ownAgent?.id);
  if (colleagues.length) {
    parts.push(
      `Team (erreichbar mit team_ask): ${colleagues.map((agent) => `${agent.name}${agent.role ? ` (${agent.role})` : ""}`).join(", ")}. ` +
        "Frag oder beauftrage ein Teammitglied, wenn dessen Fachgebiet besser passt; gib ihm allen nötigen Kontext mit, es kennt diese Unterhaltung nicht.",
    );
  }
  return parts.join("\n\n");
}

const escapeForRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Team members addressed with @Name in a user message (not the session's own agent). */
export function mentionedTeamAgents(projectId: string, text: string, ownAgentId: string | null): TeamAgent[] {
  if (!text.includes("@")) return [];
  return teamStore
    .forProject(projectId)
    .filter((agent) => agent.id !== ownAgentId && new RegExp(`(^|[^\\p{L}\\p{N}_])@${escapeForRegex(agent.name)}(?![\\p{L}\\p{N}_])`, "iu").test(text));
}

/** Added to the prompt (not the stored message) so the agent hands mentioned members the request via team_ask. */
export function mentionHintFor(projectId: string, text: string, ownAgentId: string | null): string {
  const mentioned = mentionedTeamAgents(projectId, text, ownAgentId);
  if (!mentioned.length) return "";
  const names = mentioned.map((agent) => agent.name).join(", ");
  return (
    `\n\n[Harnold: Der Nutzer spricht hier ${mentioned.length > 1 ? "die Teammitglieder" : "das Teammitglied"} ${names} direkt an (@-Erwähnung). ` +
    `Gib die Nachricht mit team_ask an ${mentioned.length > 1 ? "jedes von ihnen" : names} weiter – samt allem nötigen Kontext aus dieser Unterhaltung – ` +
    `und gib die Antwort${mentioned.length > 1 ? "en" : ""} vollständig und mit Namen wieder. Ergänze nur, wenn es hilft.]`
  );
}

// ---------------------------------------------------------------- Agent-to-agent messages

/** How deep a chain of team_ask calls currently is, per running session (stops loops). */
const askDepthBySession = new Map<string, number>();
const maximumAskDepth = 3;

type TextResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const textResult = (text: string, isError = false): TextResult => ({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });

/** team_list / team_ask for the agent running in `sessionId`. */
export function createTeamTools(project: Project, sessionId: string, permissionMode: string) {
  return [
    tool("team_list", "Listet die Agenten im Team dieses Projekts (Name, Rolle, id).", {}, async () => {
      const team = teamStore.forProject(project.id);
      return textResult(team.map((agent) => `${agent.name} – id ${agent.id}${agent.role ? ` – ${agent.role}` : ""}`).join("\n") || "Kein Team eingerichtet (Team-Screen).");
    }, { annotations: { readOnlyHint: true } }),
    tool(
      "team_save",
      "Legt ein Teammitglied (Agent mit Rolle und Anweisungen) an oder ändert es (agentId). environmentId null = in allen Umgebungen, sonst nur in dieser Umgebung (environment_list).",
      {
        agentId: z.string().optional(),
        environmentId: z.string().nullable().default(null),
        name: z.string().min(1).max(40),
        role: z.string().max(200).default(""),
        instructions: z.string().default(""),
        model: z.string().nullable().default(null),
      },
      async ({ agentId, ...agentFields }) => {
        try {
          const savedAgent = teamStore.save({ ...agentFields, icon: agentId ? (teamStore.get(agentId)?.icon ?? null) : null }, agentId);
          return textResult(`Teammitglied „${savedAgent.name}“ gespeichert (id ${savedAgent.id}).`);
        } catch (saveError) {
          return textResult(saveError instanceof Error ? saveError.message : String(saveError), true);
        }
      },
    ),
    tool(
      "team_delete",
      "Entfernt ein Teammitglied (id aus team_list).",
      { agentId: z.string() },
      async ({ agentId }) => {
        try {
          const existing = teamStore.get(agentId);
          if (!existing) return textResult("Teammitglied nicht gefunden.", true);
          teamStore.remove(agentId);
          return textResult(`Teammitglied „${existing.name}“ entfernt.`);
        } catch (deleteError) {
          return textResult(deleteError instanceof Error ? deleteError.message : String(deleteError), true);
        }
      },
      { annotations: { destructiveHint: true } },
    ),
    tool(
      "team_ask",
      "Schickt einem Teammitglied eine Nachricht (Frage oder Auftrag) und wartet auf seine Antwort. Es arbeitet im selben Projekt, in seiner eigenen Session, und erinnert sich an frühere Nachrichten von dir. Gib allen nötigen Kontext mit.",
      { agentName: z.string().describe("Name aus team_list"), message: z.string().min(1) },
      async ({ agentName, message }) => {
        try {
          const callerSession = sessionStore.get(sessionId);
          const caller = callerSession?.agentId ? teamStore.get(callerSession.agentId) : undefined;
          const target = teamStore.forProject(project.id).find((agent) => agent.name.toLowerCase() === agentName.trim().toLowerCase());
          if (!target) return textResult(`Kein Teammitglied „${agentName}“. team_list zeigt alle.`, true);
          if (target.id === caller?.id) return textResult("Das bist du selbst.", true);
          const callerDepth = askDepthBySession.get(sessionId) ?? 0;
          if (callerDepth >= maximumAskDepth) return textResult("Zu viele Weitergaben hintereinander – beantworte es selbst.", true);

          const { agentRuntime } = await import("./agent.ts");
          // One conversation per pair (asking session → member), so the member keeps the context of earlier messages.
          const pairTitle = `Team · ${target.name} ← ${caller?.name ?? "Harnold"}`;
          const existingSession = sessionStore
            .listByProject(project.id)
            .find((session) => session.agentId === target.id && session.title === pairTitle && !agentRuntime.isRunning(session.id));
          const targetSession = existingSession ?? sessionStore.create(project.id, pairTitle, undefined, target.id);
          if (!existingSession) eventHub.publish({ type: "sessions_changed", projectId: project.id });

          askDepthBySession.set(targetSession.id, callerDepth + 1);
          try {
            const outcome = await agentRuntime.runTurn({
              sessionId: targetSession.id,
              text: `Nachricht von ${caller?.name ?? "Harnold"} (Team):\n\n${message}`,
              permissionMode: permissionMode as Parameters<typeof agentRuntime.runTurn>[0]["permissionMode"],
            });
            return outcome.success ? textResult(`${target.name}: ${outcome.finalText || "(keine Antwort)"}`) : textResult(`${target.name} konnte nicht antworten: ${outcome.errorText ?? "Fehler"}`, true);
          } finally {
            askDepthBySession.delete(targetSession.id);
          }
        } catch (askError) {
          return textResult(askError instanceof Error ? askError.message : String(askError), true);
        }
      },
    ),
  ];
}

/** Allowed without asking (team_save goes through the normal permission flow). */
export const teamToolNames = ["team_list", "team_ask"];
