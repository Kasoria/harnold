import { randomUUID } from "node:crypto";
import { chatItemStore, projectStore, sessionStore, type Attachment, type ChatItemPayload } from "./db.ts";
import { eventHub } from "./events.ts";
import { memoryNotes } from "./memory.ts";
import { memoryFiles } from "./memory-files.ts";
import { designSystemStore } from "./design-system.ts";
import { environmentStore } from "./environments.ts";
import { workspaceInstructions } from "./workspace-tools.ts";
import { memoryInstructions } from "./memory-tools.ts";
import { mediaInstructions } from "./media-tools.ts";
import { mentionHintFor, teamContextFor, teamStore } from "./agents.ts";
import { agentBackends } from "./backends/index.ts";
import type { AgentBackend, PermissionDecision, PermissionMode, TurnContext, TurnEvent } from "./backends/types.ts";
import type { AgentBackendId } from "./agent-backend-settings.ts";
import { t } from "./i18n.ts";

export type { ContextBreakdown } from "./backends/types.ts";
import type { ContextBreakdown } from "./backends/types.ts";

export type TurnRequest = { sessionId: string; text: string; permissionMode: PermissionMode; model?: string; attachments?: Attachment[] };
export type TurnOutcome = { success: boolean; finalText: string; errorText?: string };
/** A message sent while a turn runs; it starts once the current turn is done. */
export type QueuedMessage = Omit<TurnRequest, "sessionId"> & { id: string; createdAt: string };

/** Built on demand: the tool modules import this one, so their texts don't exist yet while modules load. */
const harnoldSystemAppend = () => `
Du läufst in Harnold, einem Workspace, in dem Chat, Code und Design im selben Projektordner liegen.
- Visuelle Entwürfe (Artifacts) als eigenständige HTML-Dateien unter design/ anlegen (z. B. design/hero.html). Sie werden dem Nutzer sofort live angezeigt.
- Ist ein Design System verknüpft, steht es unten (Pfad, Tokens, Einbindung).
- design/canvas.json ist der Canvas des Nutzers (Frames + Elemente mit x/y/width/height, frameId). Neue Dateien unter design/ erscheinen dort automatisch; zum Gruppieren Frames anlegen und frameId/Position setzen.
- Referenzen wie @pfad/zur/datei beziehen sich auf Dateien im Projekt.

${workspaceInstructions}

${memoryInstructions}

${mediaInstructions}
`.trim();

type PendingPermission = { sessionId: string; toolName: string; input: unknown; resolve: (decision: PermissionDecision) => void };

const runningTurns = new Map<string, AbortController>();
const pendingPermissions = new Map<string, PendingPermission>();
/** Actions that must wait until a session's turn is over (e.g. moving it to another project). */
const afterTurnActions = new Map<string, (() => void)[]>();
const queuedMessagesBySession = new Map<string, QueuedMessage[]>();
/** Stopped by the user: the queue waits instead of starting the next message. */
const queuePausedSessionIds = new Set<string>();

function publishQueue(sessionId: string) {
  eventHub.publish({ type: "queue_changed", sessionId, queue: queuedMessagesBySession.get(sessionId) ?? [] });
}

function startNextQueuedMessage(sessionId: string) {
  if (runningTurns.has(sessionId) || queuePausedSessionIds.has(sessionId)) return;
  const queue = queuedMessagesBySession.get(sessionId) ?? [];
  const nextMessage = queue.shift();
  if (!nextMessage) return;
  if (!queue.length) queuedMessagesBySession.delete(sessionId);
  publishQueue(sessionId);
  const { id: _queueId, createdAt: _createdAt, ...turnRequest } = nextMessage;
  void agentRuntime.runTurn({ sessionId, ...turnRequest }).catch((turnError) => console.error("[agent] queue", turnError));
}

function persistAndPublish(sessionId: string, payload: ChatItemPayload) {
  const chatItem = chatItemStore.append(sessionId, payload);
  eventHub.publish({ type: "chat_item", sessionId, chatItem });
  return chatItem;
}

/** Models that clearly belong to another agent program are not sent to this one. */
function modelFitsBackend(model: string, backendId: AgentBackendId): boolean {
  // Harnold's own agent addresses models as "providerId::modelId".
  if (backendId === "native") return model.includes("::");
  if (model.includes("::")) return false;
  const looksLikeClaude = model.startsWith("claude-");
  const looksLikeCodex = model === "codex-default" || /^(gpt-|o\d|codex-)/.test(model);
  return backendId === "codex" ? !looksLikeClaude : !looksLikeCodex;
}

/** Backend of this conversation: the one it started with, or – for a fresh context – the environment's/active one. */
function backendIdFor(sessionId: string): AgentBackendId {
  const session = sessionStore.get(sessionId);
  if (!session) throw new Error(t("Session nicht gefunden"));
  return session.agentSessionId ? ((session.backendId as AgentBackendId | null) ?? "claude-code") : environmentStore.backendFor(session.projectId);
}

/** What a turn and a context check of this session share (same tools, prompt and model, so the numbers match). */
async function turnContextFor(sessionId: string, permissionMode: PermissionMode, model?: string): Promise<{ backend: AgentBackend; context: TurnContext }> {
  const session = sessionStore.get(sessionId);
  if (!session) throw new Error(t("Session nicht gefunden"));
  const project = projectStore.get(session.projectId);
  if (!project) throw new Error(t("Projekt nicht gefunden"));
  const backendId = backendIdFor(sessionId);
  const backend = agentBackends.get(backendId);
  const teamAgent = session.agentId ? teamStore.get(session.agentId) : undefined;
  const agentSetup = await environmentStore.agentSetupFor(project.id, backendId);
  const fitting = (candidate?: string | null) => (candidate && modelFitsBackend(candidate, backendId) ? candidate : undefined);
  return {
    backend,
    context: {
      sessionId,
      session,
      project,
      teamAgentId: session.agentId,
      permissionMode,
      model: fitting(teamAgent?.model) || fitting(model) || fitting(agentSetup.model) || backend.defaultModel(),
      env: agentSetup.env,
      systemPromptAppend: [harnoldSystemAppend(), teamContextFor(project, session.agentId), environmentStore.contextFor(project.id), designSystemStore.contextFor(project.id, sessionId), memoryNotes.contextFor(project), memoryFiles.contextFor(project)]
        .filter(Boolean)
        .join("\n\n"),
    },
  };
}

/** Stores and publishes what a backend reports. */
function applyTurnEvent(sessionId: string, turnEvent: TurnEvent, outcome: TurnOutcome): void {
  switch (turnEvent.type) {
    case "session_started":
      sessionStore.update(sessionId, { agentSessionId: turnEvent.agentSessionId, pendingFork: null });
      return;
    case "text_delta":
      eventHub.publish({ type: "text_delta", sessionId, text: turnEvent.text });
      return;
    case "thinking_delta":
      eventHub.publish({ type: "thinking_delta", sessionId, text: turnEvent.text });
      return;
    case "context_size":
      eventHub.publish({ type: "context_size", sessionId, tokens: turnEvent.tokens });
      return;
    case "item":
      persistAndPublish(
        sessionId,
        turnEvent.payload.kind === "turn_result" ? { ...turnEvent.payload, agentSessionId: sessionStore.get(sessionId)?.agentSessionId ?? undefined } : turnEvent.payload,
      );
      return;
    case "outcome":
      outcome.success = turnEvent.success;
      outcome.finalText = turnEvent.finalText;
      if (turnEvent.errorText) outcome.errorText = turnEvent.errorText;
      return;
  }
}

export const agentRuntime = {
  isRunning(sessionId: string): boolean {
    return runningTurns.has(sessionId);
  },

  async runTurn({ sessionId, text, permissionMode, model, attachments = [] }: TurnRequest): Promise<TurnOutcome> {
    const session = sessionStore.get(sessionId);
    if (!session) throw new Error(t("Session nicht gefunden"));
    const project = projectStore.get(session.projectId);
    if (!project) throw new Error(t("Projekt nicht gefunden"));
    if (runningTurns.has(sessionId)) throw new Error(t("In dieser Session läuft bereits ein Durchlauf"));
    // Fail early (before the message is stored) when the agent program is missing or not signed in.
    const { backend, context } = await turnContextFor(sessionId, permissionMode, model);

    if (!session.agentSessionId && session.title === "Neue Session") {
      sessionStore.update(sessionId, { title: (text.trim() || attachments.map((attachment) => attachment.name).join(", ")).slice(0, 60) });
      eventHub.publish({ type: "sessions_changed", projectId: project.id });
    }
    const userChatItem = persistAndPublish(sessionId, { kind: "user_text", text, ...(attachments.length ? { attachments } : {}) });
    if (session.forkOriginSessionId && !session.forkItemId) sessionStore.update(sessionId, { forkItemId: userChatItem.id });
    // A version created by editing a message picks the conversation up at the point before that message.
    const pendingFork = session.agentSessionId ? null : session.pendingFork;
    if (session.backendId !== backend.id) sessionStore.update(sessionId, { backendId: backend.id });

    const abortController = new AbortController();
    const outcome: TurnOutcome = { success: false, finalText: "" };
    runningTurns.set(sessionId, abortController);
    queuePausedSessionIds.delete(sessionId);
    eventHub.publish({ type: "turn_state", sessionId, running: true });

    try {
      const turnEvents = backend.runTurn({
        ...context,
        promptText: `${pendingFork?.mode === "transcript" ? `${pendingFork.transcript}\n\n${text}` : text}${mentionHintFor(project.id, text, session.agentId)}`,
        attachments,
        resumeSessionId: session.agentSessionId,
        pendingFork,
        signal: abortController.signal,
        requestPermission: (toolName, toolInput, signal) =>
          new Promise<PermissionDecision>((resolve) => {
            const requestId = randomUUID();
            pendingPermissions.set(requestId, { sessionId, toolName, input: toolInput, resolve });
            signal.addEventListener("abort", () => {
              pendingPermissions.delete(requestId);
              resolve({ behavior: "deny", message: "Abgebrochen" });
            });
            eventHub.publish({ type: "permission_request", sessionId, requestId, toolName, input: toolInput });
          }),
      });
      for await (const turnEvent of turnEvents) applyTurnEvent(sessionId, turnEvent, outcome);
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
      const deferredActions = afterTurnActions.get(sessionId) ?? [];
      afterTurnActions.delete(sessionId);
      for (const deferredAction of deferredActions) {
        try {
          deferredAction();
        } catch (deferredError) {
          console.error("[agent] after turn", deferredError);
        }
      }
      setTimeout(() => startNextQueuedMessage(sessionId), 0);
    }
    return outcome;
  },

  /** Open permission requests (so a freshly opened app still shows what is waiting). */
  listPendingPermissions(): { requestId: string; sessionId: string; toolName: string; input: unknown }[] {
    return [...pendingPermissions].map(([requestId, pendingPermission]) => ({ requestId, sessionId: pendingPermission.sessionId, toolName: pendingPermission.toolName, input: pendingPermission.input }));
  },

  /** Ids of sessions with a running turn. */
  listRunningSessionIds(): string[] {
    return [...runningTurns.keys()];
  },

  /** Runs once the current turn of this session has finished. */
  afterTurn(sessionId: string, action: () => void): void {
    afterTurnActions.set(sessionId, [...(afterTurnActions.get(sessionId) ?? []), action]);
  },

  /** Stops the turn; queued messages wait until sent individually or the next turn ends. */
  interrupt(sessionId: string): void {
    const abortController = runningTurns.get(sessionId);
    if (!abortController) return;
    if (queuedMessagesBySession.has(sessionId)) queuePausedSessionIds.add(sessionId);
    abortController.abort();
  },

  /** Context window by category; model = the one the composer has picked (window size depends on it). */
  async measureContext(sessionId: string, model?: string): Promise<ContextBreakdown> {
    const { backend, context } = await turnContextFor(sessionId, "default", model);
    if (!backend.measureContext) throw new Error(t("{0} bietet keine Kontextanzeige", backend.name));
    return backend.measureContext(context);
  },

  /** Throws a friendly error when the agent program of this session cannot run (not installed / signed in). */
  async assertReady(sessionId: string): Promise<void> {
    await agentBackends.get(backendIdFor(sessionId)).assertReady();
  },

  queueFor(sessionId: string): QueuedMessage[] {
    return queuedMessagesBySession.get(sessionId) ?? [];
  },

  /** Queues the message behind the running turn (or starts it right away when nothing runs). */
  enqueue(turnRequest: TurnRequest): QueuedMessage {
    const { sessionId, ...messageFields } = turnRequest;
    const queuedMessage: QueuedMessage = { ...messageFields, id: randomUUID(), createdAt: new Date().toISOString() };
    queuedMessagesBySession.set(sessionId, [...(queuedMessagesBySession.get(sessionId) ?? []), queuedMessage]);
    publishQueue(sessionId);
    if (!runningTurns.has(sessionId)) {
      queuePausedSessionIds.delete(sessionId);
      startNextQueuedMessage(sessionId);
    }
    return queuedMessage;
  },

  removeQueued(sessionId: string, queuedMessageId: string): boolean {
    const queue = queuedMessagesBySession.get(sessionId) ?? [];
    const remaining = queue.filter((queuedMessage) => queuedMessage.id !== queuedMessageId);
    if (remaining.length === queue.length) return false;
    if (remaining.length) queuedMessagesBySession.set(sessionId, remaining);
    else queuedMessagesBySession.delete(sessionId);
    publishQueue(sessionId);
    return true;
  },

  /** "Sofort senden": moves the message to the front and stops the running turn so it starts now. */
  sendQueuedNow(sessionId: string, queuedMessageId: string): boolean {
    const queue = queuedMessagesBySession.get(sessionId) ?? [];
    const queuedMessage = queue.find((candidate) => candidate.id === queuedMessageId);
    if (!queuedMessage) return false;
    queuedMessagesBySession.set(sessionId, [queuedMessage, ...queue.filter((candidate) => candidate !== queuedMessage)]);
    queuePausedSessionIds.delete(sessionId);
    const abortController = runningTurns.get(sessionId);
    if (abortController) abortController.abort();
    else startNextQueuedMessage(sessionId);
    return true;
  },

  /** Drops the queue (session cleared or deleted). */
  clearQueue(sessionId: string): void {
    if (!queuedMessagesBySession.delete(sessionId)) return;
    queuePausedSessionIds.delete(sessionId);
    publishQueue(sessionId);
  },

  /** answers: for AskUserQuestion (question text → chosen label(s), comma-separated). */
  resolvePermission(requestId: string, allow: boolean, answers?: Record<string, string>): boolean {
    const pendingPermission = pendingPermissions.get(requestId);
    if (!pendingPermission) return false;
    pendingPermissions.delete(requestId);
    const toolInput = (pendingPermission.input && typeof pendingPermission.input === "object" ? pendingPermission.input : {}) as Record<string, unknown>;
    pendingPermission.resolve(
      !allow
        ? { behavior: "deny", message: pendingPermission.toolName === "AskUserQuestion" ? "Der Nutzer hat die Fragen übersprungen." : "Vom Nutzer abgelehnt" }
        : answers
          ? { behavior: "allow", updatedInput: { ...toolInput, answers } }
          : { behavior: "allow" },
    );
    eventHub.publish({ type: "permission_resolved", sessionId: pendingPermission.sessionId, requestId });
    return true;
  },
};
