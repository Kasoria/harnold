import { randomUUID } from "node:crypto";
import { query, type PermissionMode, type PermissionResult, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { chatItemStore, projectStore, sessionStore, type ChatItemPayload } from "./db.ts";
import { eventHub } from "./events.ts";
import { config } from "./config.ts";
import { memoryNotes } from "./memory.ts";
import { agentIntegrationOptions } from "./integrations.ts";
import { designSystemsDirectory, designSystemStore } from "./design-system.ts";
import { claudeAuth } from "./claude-auth.ts";
import { createMediaServer, mediaInstructions, mediaServerName } from "./media-tools.ts";
import { createWorkspaceServer, workspaceInstructions, workspaceServerName, workspaceToolNames } from "./workspace-tools.ts";
import { createMemoryServer, memoryInstructions, memoryServerName, memoryToolNames } from "./memory-tools.ts";

export type TurnRequest = { sessionId: string; text: string; permissionMode: PermissionMode; model?: string };
export type TurnOutcome = { success: boolean; finalText: string; errorText?: string };

const harnoldSystemAppend = `
Du läufst in Harnold, einem Workspace, in dem Chat, Code und Design im selben Projektordner liegen.
- Visuelle Entwürfe (Artifacts) als eigenständige HTML-Dateien unter design/ anlegen (z. B. design/hero.html). Sie werden dem Nutzer sofort live angezeigt.
- Ist ein Design System verknüpft, steht es unten (Pfad, Tokens, Einbindung).
- design/canvas.json ist der Canvas des Nutzers (Frames + Elemente mit x/y/width/height, frameId). Neue Dateien unter design/ erscheinen dort automatisch; zum Gruppieren Frames anlegen und frameId/Position setzen.
- Referenzen wie @pfad/zur/datei beziehen sich auf Dateien im Projekt.

${workspaceInstructions}

${memoryInstructions}

${mediaInstructions}
`.trim();

type PendingPermission = { sessionId: string; resolve: (permissionResult: PermissionResult) => void };

const runningTurns = new Map<string, AbortController>();
const pendingPermissions = new Map<string, PendingPermission>();

function persistAndPublish(sessionId: string, payload: ChatItemPayload): void {
  const chatItem = chatItemStore.append(sessionId, payload);
  eventHub.publish({ type: "chat_item", sessionId, chatItem });
}

function stringifyToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (block && typeof block === "object" && "text" in block ? String(block.text) : "[nicht-Text-Inhalt]"))
      .join("\n");
  }
  return JSON.stringify(content);
}

/** Maps one SDK message onto Harnold chat items / live events. */
function handleAgentMessage(sessionId: string, agentMessage: SDKMessage): void {
  switch (agentMessage.type) {
    case "system":
      if (agentMessage.subtype === "init") sessionStore.update(sessionId, { agentSessionId: agentMessage.session_id });
      return;
    case "stream_event": {
      if (agentMessage.parent_tool_use_id) return;
      const streamEvent = agentMessage.event;
      if (streamEvent.type === "content_block_delta" && streamEvent.delta.type === "text_delta") {
        eventHub.publish({ type: "text_delta", sessionId, text: streamEvent.delta.text });
      }
      return;
    }
    case "assistant": {
      if (agentMessage.parent_tool_use_id) return;
      for (const contentBlock of agentMessage.message.content) {
        if (contentBlock.type === "text" && contentBlock.text.trim()) {
          persistAndPublish(sessionId, { kind: "assistant_text", text: contentBlock.text });
        } else if (contentBlock.type === "tool_use") {
          persistAndPublish(sessionId, {
            kind: "tool_use",
            toolUseId: contentBlock.id,
            toolName: contentBlock.name,
            input: contentBlock.input,
          });
        }
      }
      return;
    }
    case "user": {
      if (agentMessage.parent_tool_use_id) return;
      const messageContent = agentMessage.message.content;
      if (!Array.isArray(messageContent)) return;
      for (const contentBlock of messageContent) {
        if (contentBlock.type === "tool_result") {
          persistAndPublish(sessionId, {
            kind: "tool_result",
            toolUseId: contentBlock.tool_use_id,
            content: stringifyToolResultContent(contentBlock.content).slice(0, 20_000),
            isError: Boolean(contentBlock.is_error),
          });
        }
      }
      return;
    }
    case "result":
      persistAndPublish(sessionId, {
        kind: "turn_result",
        success: agentMessage.subtype === "success" && !agentMessage.is_error,
        costUsd: agentMessage.total_cost_usd,
        durationMs: agentMessage.duration_ms,
        errorText: agentMessage.subtype === "success" ? undefined : agentMessage.errors.join("\n"),
      });
      return;
    default:
      return;
  }
}

export const agentRuntime = {
  isRunning(sessionId: string): boolean {
    return runningTurns.has(sessionId);
  },

  async runTurn({ sessionId, text, permissionMode, model }: TurnRequest): Promise<TurnOutcome> {
    const session = sessionStore.get(sessionId);
    if (!session) throw new Error("Session nicht gefunden");
    const project = projectStore.get(session.projectId);
    if (!project) throw new Error("Projekt nicht gefunden");
    if (runningTurns.has(sessionId)) throw new Error("In dieser Session läuft bereits ein Durchlauf");
    await claudeAuth.assertReady();

    if (!session.agentSessionId && session.title === "Neue Session") {
      sessionStore.update(sessionId, { title: text.slice(0, 60) });
      eventHub.publish({ type: "sessions_changed", projectId: project.id });
    }
    persistAndPublish(sessionId, { kind: "user_text", text });

    const abortController = new AbortController();
    const outcome: TurnOutcome = { success: false, finalText: "" };
    runningTurns.set(sessionId, abortController);
    eventHub.publish({ type: "turn_state", sessionId, running: true });

    try {
      const integrationOptions = agentIntegrationOptions(project);
      const agentStream = query({
        prompt: text,
        options: {
          cwd: project.path,
          env: claudeAuth.agentEnvironment(),
          // All design systems are open to the agent (it may create/link one mid-turn).
          additionalDirectories: [designSystemsDirectory],
          resume: session.agentSessionId ?? undefined,
          model: model ?? config.defaultModel,
          permissionMode,
          allowDangerouslySkipPermissions: permissionMode === "bypassPermissions",
          includePartialMessages: true,
          settingSources: ["user", "project", "local"],
          systemPrompt: { type: "preset", preset: "claude_code", append: [harnoldSystemAppend, designSystemStore.contextFor(project.id, sessionId), memoryNotes.contextFor(project)].filter(Boolean).join("\n\n") },
          mcpServers: { ...integrationOptions.mcpServers, [memoryServerName]: createMemoryServer(project), [mediaServerName]: createMediaServer(project), [workspaceServerName]: createWorkspaceServer(project, sessionId) },
          allowedTools: [...workspaceToolNames, ...memoryToolNames, ...integrationOptions.allowedTools],
          skills: integrationOptions.skills,
          abortController,
          canUseTool: (toolName, input, { signal }) =>
            new Promise<PermissionResult>((resolve) => {
              const requestId = randomUUID();
              pendingPermissions.set(requestId, { sessionId, resolve });
              signal.addEventListener("abort", () => {
                pendingPermissions.delete(requestId);
                resolve({ behavior: "deny", message: "Abgebrochen" });
              });
              eventHub.publish({ type: "permission_request", sessionId, requestId, toolName, input });
            }),
        },
      });
      for await (const agentMessage of agentStream) {
        handleAgentMessage(sessionId, agentMessage);
        if (agentMessage.type === "assistant" && !agentMessage.parent_tool_use_id) {
          const turnText = agentMessage.message.content
            .flatMap((contentBlock) => (contentBlock.type === "text" && contentBlock.text.trim() ? [contentBlock.text] : []))
            .join("\n\n");
          if (turnText) outcome.finalText = turnText; // last top-level text = the answer
        } else if (agentMessage.type === "result") {
          outcome.success = agentMessage.subtype === "success" && !agentMessage.is_error;
          if (agentMessage.subtype !== "success") outcome.errorText = agentMessage.errors.join("\n");
        }
      }
    } catch (turnError) {
      outcome.errorText = abortController.signal.aborted ? "Abgebrochen" : turnError instanceof Error ? turnError.message : String(turnError);
      if (!abortController.signal.aborted) {
        persistAndPublish(sessionId, {
          kind: "turn_result",
          success: false,
          costUsd: 0,
          durationMs: 0,
          errorText: turnError instanceof Error ? turnError.message : String(turnError),
        });
      }
    } finally {
      runningTurns.delete(sessionId);
      for (const [requestId, pendingPermission] of pendingPermissions) {
        if (pendingPermission.sessionId === sessionId) {
          pendingPermissions.delete(requestId);
          eventHub.publish({ type: "permission_resolved", sessionId, requestId });
        }
      }
      sessionStore.update(sessionId, {});
      eventHub.publish({ type: "turn_state", sessionId, running: false });
    }
    return outcome;
  },

  interrupt(sessionId: string): void {
    runningTurns.get(sessionId)?.abort();
  },

  resolvePermission(requestId: string, allow: boolean): boolean {
    const pendingPermission = pendingPermissions.get(requestId);
    if (!pendingPermission) return false;
    pendingPermissions.delete(requestId);
    pendingPermission.resolve(allow ? { behavior: "allow" } : { behavior: "deny", message: "Vom Nutzer abgelehnt" });
    eventHub.publish({ type: "permission_resolved", sessionId: pendingPermission.sessionId, requestId });
    return true;
  },
};
