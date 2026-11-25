import { randomUUID } from "node:crypto";
import { chatItemStore, projectStore, sessionStore, type Attachment, type ChatItemPayload, type Project, type Session } from "./db.ts";
import { eventHub } from "./events.ts";
import { memoryNotes } from "./memory.ts";
import { memoryFiles } from "./memory-files.ts";
import { designSystemStore } from "./design-system.ts";
import { environmentStore } from "./environments.ts";
import { workspaceInstructions } from "./workspace-tools.ts";
import { memoryInstructions } from "./memory-tools.ts";
import { mediaInstructions } from "./media-tools.ts";
import { folderStore } from "./folders.ts";
import { mentionHintFor, teamContextFor, teamStore } from "./agents.ts";
import { agentBackends } from "./backends/index.ts";
import type { AgentBackend, BackgroundTask, EffortLevel, PermissionDecision, RewindResult, PermissionMode, PermissionSuggestion, TurnContext, TurnEvent } from "./backends/types.ts";
import { defaultAgentBackendId, normalizeBackendId, type AgentBackendId } from "./agent-backend-settings.ts";
import { agentRoleSettings, defaultAgentRole, type AgentRole } from "./agent-roles.ts";
import { secretInput } from "./secret-input.ts";
import { t } from "./i18n.ts";

/** Chat folders plus the project's folder context (memory levels) – every agent program gets access to them. */
const sessionDirectories = (session: Session): string[] => [...new Set([...session.directories, ...folderStore.pathsForProject(session.projectId)])];

/** Tells the agent which folders beyond the project folder it may work in. */
const whereAllowedContext = (directories: string[], project: Project) =>
  directories.length
    ? `${t("Zusätzliche Ordner (du darfst darin lesen und arbeiten):")}\n${directories.map((directory) => `- ${directory}`).join("\n")}`
    : `${t("Du arbeitest nur im Projektordner:")} ${project.path}`;

export type { ContextBreakdown } from "./backends/types.ts";
import type { ContextBreakdown } from "./backends/types.ts";

export type TurnRequest = {
  sessionId: string;
  text: string;
  permissionMode: PermissionMode;
  /** Model of the unit that starts the turn (task, channel, mailbox); empty = inherit. */
  model?: string;
  effort?: EffortLevel;
  /** Agent program of the unit that starts the turn; empty = the role's/environment's/workspace default. */
  backendId?: string | null;
  /** Role of the turn when neither the unit nor the team member names a program: conversation or background run. */
  role?: AgentRole;
  attachments?: Attachment[];
};
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

type PendingPermission = {
  sessionId: string;
  toolName: string;
  input: unknown;
  suggestions: PermissionSuggestion[];
  alwaysAllowLabel?: string;
  resolve: (decision: PermissionDecision) => void;
};

/** How the user answers a permission card. */
export type PermissionAnswer = {
  allow: boolean;
  /** AskUserQuestion: question text → chosen label(s), comma-separated. */
  answers?: Record<string, string>;
  /** Remember the agent's suggested rule ("always allow"). */
  always?: boolean;
  /** ExitPlanMode: mode to continue in after the plan is approved. */
  permissionMode?: PermissionMode;
  /** Denied with a reason (e.g. what to change in the plan) – the agent reads it. */
  message?: string;
};

/** Readable form of a rule like Bash(npm test:*) – for the "always allow" button. */
function describeSuggestions(suggestions: PermissionSuggestion[]): string | undefined {
  const parts = suggestions.flatMap((suggestion): string[] => {
    if (suggestion.type === "addRules" && Array.isArray(suggestion.rules)) {
      return (suggestion.rules as { toolName: string; ruleContent?: string }[]).map((rule) => (rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName));
    }
    if (suggestion.type === "setMode" && suggestion.mode === "acceptEdits") return [t("Edits automatisch erlauben")];
    if (suggestion.type === "addDirectories" && Array.isArray(suggestion.directories)) return [t("Ordner {0}", (suggestion.directories as string[]).join(", "))];
    return [];
  });
  return parts.length ? parts.join(", ") : undefined;
}

const runningTurns = new Map<string, AbortController>();
const pendingPermissions = new Map<string, PendingPermission>();
/** Actions that must wait until a session's turn is over (e.g. moving it to another project). */
const afterTurnActions = new Map<string, (() => void)[]>();
const queuedMessagesBySession = new Map<string, QueuedMessage[]>();
/** Running background tasks per session (Bash in the background, background subagents). */
const backgroundTasksBySession = new Map<string, BackgroundTask[]>();
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

/**
 * Program of this conversation: the one its context already lives in, else the unit's own choice, else the role's
 * default (interactive or background), else the environment's, else the workspace-wide one.
 */
function backendIdFor(sessionId: string, requestedBackendId: string | null | undefined, role: AgentRole): AgentBackendId {
  const session = sessionStore.get(sessionId);
  if (!session) throw new Error(t("Session nicht gefunden"));
  // A conversation that already has a program keeps it – its context lives in that program.
  const running = session.agentSessionId ? (normalizeBackendId(session.backendId) ?? defaultAgentBackendId) : null;
  return (
    running ??
    normalizeBackendId(requestedBackendId) ??
    agentRoleSettings.of(role).backendId ??
    normalizeBackendId(session.backendId) ??
    environmentStore.backendFor(session.projectId)
  );
}

/** What a turn and a context check of this session share (same tools, prompt and model, so the numbers match). */
async function turnContextFor(
  sessionId: string,
  permissionMode: PermissionMode,
  model?: string,
  requestedBackendId?: string | null,
  role: AgentRole = defaultAgentRole,
): Promise<{ backend: AgentBackend; context: TurnContext }> {
  const session = sessionStore.get(sessionId);
  if (!session) throw new Error(t("Session nicht gefunden"));
  const project = projectStore.get(session.projectId);
  if (!project) throw new Error(t("Projekt nicht gefunden"));
  const teamAgent = session.agentId ? teamStore.get(session.agentId) : undefined;
  // The unit's own program (task, channel, mailbox, team member) wins over the role's and the workspace's one.
  const backendId = backendIdFor(sessionId, requestedBackendId ?? teamAgent?.backendId ?? null, role);
  const roleDefaults = agentRoleSettings.of(role);
  const backend = agentBackends.get(backendId);
  const agentSetup = await environmentStore.agentSetupFor(project.id, backendId);
  // Folders of the project's context (chat + memory levels) apply to every turn, whichever backend runs.
  const directories = sessionDirectories(session);
  const fitting = (candidate?: string | null) => (candidate && modelFitsBackend(candidate, backendId) ? candidate : undefined);
  return {
    backend,
    context: {
      sessionId,
      session: { ...session, directories },
      project,
      teamAgentId: session.agentId,
      permissionMode,
      // The caller's model (composer or unit), then the team member's, the role's, the environment's, then the default.
      model: fitting(model) || fitting(teamAgent?.model) || fitting(roleDefaults.model) || fitting(agentSetup.model) || backend.defaultModel(),
      env: agentSetup.env,
      systemPromptAppend: [harnoldSystemAppend(), whereAllowedContext(directories, project), folderStore.contextFor(project), teamContextFor(project, session.agentId), environmentStore.contextFor(project.id), designSystemStore.contextFor(project.id, sessionId), memoryNotes.contextFor(project), memoryFiles.contextFor(project)]
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
    case "status":
      eventHub.publish({ type: "agent_status", sessionId, text: turnEvent.text });
      return;
    case "background_tasks":
      if (turnEvent.tasks.length) backgroundTasksBySession.set(sessionId, turnEvent.tasks);
      else backgroundTasksBySession.delete(sessionId);
      eventHub.publish({ type: "background_tasks", sessionId, tasks: turnEvent.tasks });
      return;
    case "outcome":
      outcome.success = turnEvent.success;
      outcome.finalText = turnEvent.finalText;
      if (turnEvent.errorText) outcome.errorText = turnEvent.errorText;
      return;
  }
}

/** Replaces the provisional title with the one the agent generated – unless the user renamed the session meanwhile. */
async function adoptGeneratedTitle(sessionId: string, provisionalTitle: string, backend: AgentBackend): Promise<void> {
  try {
    const session = sessionStore.get(sessionId);
    if (!session?.agentSessionId || session.title !== provisionalTitle) return;
    const { context } = await turnContextFor(sessionId, "default");
    const generatedTitle = (await backend.generatedTitle?.(context))?.trim().slice(0, 80);
    if (!generatedTitle || sessionStore.get(sessionId)?.title !== provisionalTitle) return;
    sessionStore.update(sessionId, { title: generatedTitle });
    eventHub.publish({ type: "sessions_changed", projectId: session.projectId });
  } catch (titleError) {
    console.error("[agent] title", titleError);
  }
}

/** Asks the user (app or channel) and waits for the answer. */
function requestPermission(sessionId: string, toolName: string, toolInput: unknown, signal: AbortSignal, suggestions: PermissionSuggestion[] = []): Promise<PermissionDecision> {
  return new Promise<PermissionDecision>((resolve) => {
    const requestId = randomUUID();
    const alwaysAllowLabel = describeSuggestions(suggestions);
    pendingPermissions.set(requestId, { sessionId, toolName, input: toolInput, suggestions, alwaysAllowLabel, resolve });
    signal.addEventListener("abort", () => {
      if (!pendingPermissions.delete(requestId)) return;
      resolve({ behavior: "deny", message: "Abgebrochen" });
      eventHub.publish({ type: "permission_resolved", sessionId, requestId });
    });
    eventHub.publish({ type: "permission_request", sessionId, requestId, toolName, input: toolInput, alwaysAllowLabel });
  });
}

/** Runs one turn of a session (started by the user or by the agent itself): state, storage, cleanup, queue. */
async function driveTurn(sessionId: string, abortController: AbortController, startTurn: () => AsyncGenerator<TurnEvent>): Promise<TurnOutcome> {
  const outcome: TurnOutcome = { success: false, finalText: "" };
  runningTurns.set(sessionId, abortController);
  queuePausedSessionIds.delete(sessionId);
  eventHub.publish({ type: "turn_state", sessionId, running: true });

  try {
    for await (const turnEvent of startTurn()) applyTurnEvent(sessionId, turnEvent, outcome);
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
    eventHub.publish({ type: "agent_status", sessionId, text: null });
    secretInput.cancelSession(sessionId);
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
}

/**
 * Turns the agent starts itself (e.g. after a background task finished) are stored like normal turns.
 * Registered on first use, not at load time: the backends import modules that import this one.
 */
let backgroundTurnsRegistered = false;
function registerBackgroundTurns(): void {
  if (backgroundTurnsRegistered) return;
  backgroundTurnsRegistered = true;
  for (const backend of agentBackends.list()) registerBackgroundTurnsOf(backend);
}

function registerBackgroundTurnsOf(backend: AgentBackend): void {
  backend.onSessionEvent?.((sessionId, turnEvent) => {
    if (sessionStore.get(sessionId)) applyTurnEvent(sessionId, turnEvent, { success: false, finalText: "" });
  });
  backend.onBackgroundTurn?.((sessionId, turnEvents, stop) => {
    if (!sessionStore.get(sessionId) || runningTurns.has(sessionId)) {
      stop();
      void (async () => {
        for await (const _ignoredEvent of turnEvents);
      })();
      return;
    }
    const abortController = new AbortController();
    abortController.signal.addEventListener("abort", stop, { once: true });
    void driveTurn(sessionId, abortController, () => turnEvents).catch((turnError) => console.error("[agent] background turn", turnError));
  });
}

export const agentRuntime = {
  isRunning(sessionId: string): boolean {
    return runningTurns.has(sessionId);
  },

  async runTurn({ sessionId, text, permissionMode, model, effort, backendId, role = defaultAgentRole, attachments = [] }: TurnRequest): Promise<TurnOutcome> {
    const session = sessionStore.get(sessionId);
    if (!session) throw new Error(t("Session nicht gefunden"));
    const project = projectStore.get(session.projectId);
    if (!project) throw new Error(t("Projekt nicht gefunden"));
    if (runningTurns.has(sessionId)) throw new Error(t("In dieser Session läuft bereits ein Durchlauf"));
    // Fail early (before the message is stored) when the agent program is missing or not signed in.
    const { backend, context } = await turnContextFor(sessionId, permissionMode, model, backendId, role);

    // First message: a provisional title from the text; the agent's generated title replaces it after the turn.
    const provisionalTitle = !session.agentSessionId && session.title === "Neue Session" ? (text.trim() || attachments.map((attachment) => attachment.name).join(", ")).slice(0, 60) : null;
    if (provisionalTitle) {
      sessionStore.update(sessionId, { title: provisionalTitle });
      eventHub.publish({ type: "sessions_changed", projectId: project.id });
    }
    const userChatItem = persistAndPublish(sessionId, { kind: "user_text", text, ...(attachments.length ? { attachments } : {}) });
    if (session.forkOriginSessionId && !session.forkItemId) sessionStore.update(sessionId, { forkItemId: userChatItem.id });
    // A version created by editing a message picks the conversation up at the point before that message.
    const pendingFork = session.agentSessionId ? null : session.pendingFork;
    if (session.backendId !== backend.id) sessionStore.update(sessionId, { backendId: backend.id });

    registerBackgroundTurns();
    const abortController = new AbortController();
    const turnOutcome = driveTurn(sessionId, abortController, () =>
      backend.runTurn({
        ...context,
        effort: backend.capabilities.effort ? effort : undefined,
        promptText: `${pendingFork?.mode === "transcript" ? `${pendingFork.transcript}\n\n${text}` : text}${mentionHintFor(project.id, text, session.agentId)}`,
        attachments,
        userMessageId: userChatItem.id,
        resumeSessionId: session.agentSessionId,
        pendingFork,
        signal: abortController.signal,
        keepAlive: role === "chat",
        requestPermission: (toolName, toolInput, signal, suggestions) => requestPermission(sessionId, toolName, toolInput, signal, suggestions),
      }),
    );
    if (provisionalTitle && backend.generatedTitle) void turnOutcome.then(() => adoptGeneratedTitle(sessionId, provisionalTitle, backend));
    return turnOutcome;
  },

  /** Open permission requests (so a freshly opened app still shows what is waiting). */
  listPendingPermissions(): { requestId: string; sessionId: string; toolName: string; input: unknown; alwaysAllowLabel?: string }[] {
    return [
      ...[...pendingPermissions].map(([requestId, pendingPermission]) => ({
        requestId,
        sessionId: pendingPermission.sessionId,
        toolName: pendingPermission.toolName,
        input: pendingPermission.input,
        alwaysAllowLabel: pendingPermission.alwaysAllowLabel,
      })),
      ...secretInput.listPending(),
    ];
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

  backgroundTasksFor(sessionId: string): BackgroundTask[] {
    return backgroundTasksBySession.get(sessionId) ?? [];
  },

  async stopBackgroundTask(sessionId: string, taskId: string): Promise<void> {
    for (const backend of agentBackends.list()) await backend.stopBackgroundTask?.(sessionId, taskId);
  },

  /** Restores the project files to their state before this user message (dryRun: only report). */
  async rewindFiles(sessionId: string, userItemId: string, dryRun: boolean): Promise<RewindResult> {
    if (runningTurns.has(sessionId)) throw new Error(t("In dieser Session läuft bereits ein Durchlauf"));
    const session = sessionStore.get(sessionId);
    if (!session) throw new Error(t("Session nicht gefunden"));
    const backend = agentBackends.get(normalizeBackendId(session.backendId));
    if (!backend.rewindFiles) throw new Error(t("{0} kann Dateien nicht zurücksetzen", backend.name));
    const { context } = await turnContextFor(sessionId, "default");
    const rewindResult = await backend.rewindFiles(context, userItemId, dryRun);
    if (!dryRun && rewindResult.canRewind) persistAndPublish(sessionId, { kind: "notice", text: t("Dateien auf den Stand vor dieser Nachricht zurückgesetzt") });
    return rewindResult;
  },

  /** Ends the agent process of a deleted session. */
  release(sessionId: string): void {
    for (const backend of agentBackends.list()) backend.release?.(sessionId);
  },

  /** Context window by category; model = the one the composer has picked (window size depends on it). */
  async measureContext(sessionId: string, model?: string): Promise<ContextBreakdown> {
    const { backend, context } = await turnContextFor(sessionId, "default", model, null, defaultAgentRole);
    if (!backend.measureContext) throw new Error(t("{0} bietet keine Kontextanzeige", backend.name));
    return backend.measureContext(context);
  },

  /** Throws a friendly error when the agent program of this session cannot run (not installed / signed in). */
  async assertReady(sessionId: string): Promise<void> {
    await agentBackends.get(backendIdFor(sessionId, null, defaultAgentRole)).assertReady();
  },

  queueFor(sessionId: string): QueuedMessage[] {
    return queuedMessagesBySession.get(sessionId) ?? [];
  },

  /** Sends the message into the running turn when the agent program can take it (Claude Code); false = queue it. */
  steer({ sessionId, text, attachments = [] }: TurnRequest): boolean {
    if (!runningTurns.has(sessionId)) return false;
    const session = sessionStore.get(sessionId);
    const project = session && projectStore.get(session.projectId);
    if (!session || !project) return false;
    const backend = agentBackends.get(normalizeBackendId(session.backendId));
    const userMessageId = randomUUID();
    if (!backend.steer?.(sessionId, { project, promptText: `${text}${mentionHintFor(project.id, text, session.agentId)}`, attachments, userMessageId })) return false;
    const chatItem = chatItemStore.append(sessionId, { kind: "user_text", text, ...(attachments.length ? { attachments } : {}) }, Date.now(), userMessageId);
    eventHub.publish({ type: "chat_item", sessionId, chatItem });
    return true;
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

  resolvePermission(requestId: string, { allow, answers, always, permissionMode, message }: PermissionAnswer): boolean {
    const pendingPermission = pendingPermissions.get(requestId);
    if (!pendingPermission) return false;
    pendingPermissions.delete(requestId);
    const toolInput = (pendingPermission.input && typeof pendingPermission.input === "object" ? pendingPermission.input : {}) as Record<string, unknown>;
    const isQuestion = pendingPermission.toolName === "AskUserQuestion";
    // Plan approved: continue in the chosen mode (like Claude Code's "auto-accept edits" / "ask for each edit").
    const modeUpdate: PermissionSuggestion[] = permissionMode ? [{ type: "setMode", mode: permissionMode, destination: "session" }] : [];
    const updatedPermissions = [...(always ? pendingPermission.suggestions : []), ...modeUpdate];
    pendingPermission.resolve(
      !allow
        ? { behavior: "deny", message: message?.trim() || (isQuestion ? "Der Nutzer hat die Fragen übersprungen." : "Vom Nutzer abgelehnt") }
        : {
            behavior: "allow",
            ...(answers ? { updatedInput: { ...toolInput, answers } } : {}),
            ...(updatedPermissions.length ? { updatedPermissions } : {}),
          },
    );
    eventHub.publish({ type: "permission_resolved", sessionId: pendingPermission.sessionId, requestId });
    const switchedMode = updatedPermissions.find((update) => update.type === "setMode")?.mode;
    if (allow && typeof switchedMode === "string") eventHub.publish({ type: "permission_mode_changed", sessionId: pendingPermission.sessionId, permissionMode: switchedMode });
    return true;
  },
};
