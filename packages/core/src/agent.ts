import { randomUUID } from "node:crypto";
import { query, type PermissionMode, type ModelUsage, type Options, type PermissionResult, type Query, type SDKControlGetContextUsageResponse, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { chatItemStore, projectStore, sessionStore, type Attachment, type ChatItemPayload } from "./db.ts";
import { contentBlocksFor } from "./attachments.ts";
import { eventHub } from "./events.ts";
import { environmentMemoryDirectory, memoryConfig, memoryNotes } from "./memory.ts";
import { memoryFiles } from "./memory-files.ts";
import { agentIntegrationOptions } from "./integrations.ts";
import { designSystemsDirectory, designSystemStore } from "./design-system.ts";
import { environmentStore } from "./environments.ts";
import { agentModelSettings, claudeExecutable } from "./claude-auth.ts";
import { createMediaServer, mediaInstructions, mediaServerName } from "./media-tools.ts";
import { createWorkspaceServer, workspaceInstructions, workspaceServerName, workspaceToolNames } from "./workspace-tools.ts";
import { createMemoryServer, memoryInstructions, memoryServerName, memoryToolNames } from "./memory-tools.ts";
import { agentCommands } from "./slash-commands.ts";
import { agentPluginOptions } from "./plugins.ts";
import { recordClaudeMcpServers } from "./mcp-discovery.ts";
import { mentionHintFor, teamContextFor, teamStore } from "./agents.ts";
import { t } from "./i18n.ts";

export type TurnRequest = { sessionId: string; text: string; permissionMode: PermissionMode; model?: string; attachments?: Attachment[] };
export type TurnOutcome = { success: boolean; finalText: string; errorText?: string };
/** A message sent while a turn runs; it starts once the current turn is done. */
export type QueuedMessage = Omit<TurnRequest, "sessionId"> & { id: string; createdAt: string };

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

type PendingPermission = { sessionId: string; toolName: string; input: unknown; resolve: (permissionResult: PermissionResult) => void };

const runningTurns = new Map<string, AbortController>();
const pendingPermissions = new Map<string, PendingPermission>();
/** Actions that must wait until a session's turn is over (e.g. moving it to another project). */
const afterTurnActions = new Map<string, (() => void)[]>();
const queuedMessagesBySession = new Map<string, QueuedMessage[]>();
/** Live query per running turn (asked for the context breakdown mid-turn). */
const activeQueries = new Map<string, Query>();
const contextMeasurementsInFlight = new Map<string, Promise<ContextBreakdown>>();

/** What fills the context window, by category (like /context). */
export type ContextBreakdown = {
  model: string;
  totalTokens: number;
  maxTokens: number;
  percentage: number;
  categories: { id?: string; name: string; tokens: number; kind: "used" | "free" | "buffer" | "deferred" }[];
};

function toContextBreakdown(usage: SDKControlGetContextUsageResponse): ContextBreakdown {
  return {
    model: usage.model,
    totalTokens: usage.totalTokens,
    maxTokens: usage.maxTokens,
    percentage: usage.percentage,
    categories: usage.categories.map((category) => ({ id: category.id, name: category.name, tokens: category.tokens, kind: category.kind })),
  };
}

/** Without a running turn: start the CLI on the session without a prompt, ask, close (no model call, ~1 s). */
async function measureIdleContext(sessionId: string, model?: string): Promise<ContextBreakdown> {
  const session = sessionStore.get(sessionId);
  if (!session) throw new Error(t("Session nicht gefunden"));
  let releaseInput: () => void = () => undefined;
  const inputDone = new Promise<void>((resolve) => (releaseInput = resolve));
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort(), 60_000);
  const idleQuery = query({
    prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
      await inputDone;
    })(),
    options: { ...(await sharedAgentOptions(sessionId, "default", model)), resume: session.agentSessionId ?? undefined, persistSession: Boolean(session.agentSessionId), abortController },
  });
  try {
    return toContextBreakdown(await idleQuery.getContextUsage({ detail: "full" }));
  } finally {
    clearTimeout(timeoutHandle);
    releaseInput();
    void (async () => {
      for await (const _idleMessage of idleQuery);
    })().catch(() => undefined);
  }
}
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

/** Per-turn bookkeeping: the last main-thread transcript entry is the fork point for edits of later messages. */
type TurnTracking = { lastChainUuid?: string; contextTokens?: number; model?: string };

function stringifyToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (block && typeof block === "object" && "text" in block ? String(block.text) : "[nicht-Text-Inhalt]"))
      .join("\n");
  }
  return JSON.stringify(content);
}

/** Window size of the main model (the one that answered last); other entries are subagents/helpers. */
function contextWindowOf(modelUsage: Record<string, ModelUsage> | undefined, model: string | undefined): number | undefined {
  const usageEntries = Object.entries(modelUsage ?? {});
  const mainEntry = usageEntries.find(([modelName]) => model && (modelName === model || modelName.startsWith(model) || model.startsWith(modelName)));
  return mainEntry?.[1].contextWindow ?? (usageEntries.length ? Math.max(...usageEntries.map(([, usage]) => usage.contextWindow)) : undefined);
}

/** Maps one SDK message onto Harnold chat items / live events. */
function handleAgentMessage(sessionId: string, projectId: string, agentMessage: SDKMessage, turnTracking: TurnTracking): void {
  if ((agentMessage.type === "assistant" || agentMessage.type === "user") && !agentMessage.parent_tool_use_id && agentMessage.uuid) {
    turnTracking.lastChainUuid = agentMessage.uuid;
  }
  switch (agentMessage.type) {
    case "system":
      if (agentMessage.subtype === "init") sessionStore.update(sessionId, { agentSessionId: agentMessage.session_id, pendingFork: null });
      else if (agentMessage.subtype === "compact_boundary") {
        const { pre_tokens: tokensBefore, post_tokens: tokensAfter } = agentMessage.compact_metadata;
        const tokenText = (tokenCount: number) => `${Math.round(tokenCount / 1000)}k`;
        persistAndPublish(sessionId, { kind: "notice", text: `Kontext komprimiert${tokensAfter ? ` · ${tokenText(tokensBefore)} → ${tokenText(tokensAfter)} Tokens` : ` · vorher ${tokenText(tokensBefore)} Tokens`}` });
        if (tokensAfter) {
          turnTracking.contextTokens = tokensAfter;
          eventHub.publish({ type: "context_size", sessionId, tokens: tokensAfter });
        }
      } else if (agentMessage.subtype === "commands_changed") agentCommands.remember(projectId, agentMessage.commands);
      return;
    case "stream_event": {
      if (agentMessage.parent_tool_use_id) return;
      const streamEvent = agentMessage.event;
      if (streamEvent.type === "message_start") {
        const requestUsage = streamEvent.message.usage;
        turnTracking.contextTokens = requestUsage.input_tokens + (requestUsage.cache_creation_input_tokens ?? 0) + (requestUsage.cache_read_input_tokens ?? 0);
        turnTracking.model = streamEvent.message.model;
        eventHub.publish({ type: "context_size", sessionId, tokens: turnTracking.contextTokens });
      } else if (streamEvent.type === "content_block_delta" && streamEvent.delta.type === "text_delta") {
        eventHub.publish({ type: "text_delta", sessionId, text: streamEvent.delta.text });
      } else if (streamEvent.type === "content_block_delta" && streamEvent.delta.type === "thinking_delta") {
        eventHub.publish({ type: "thinking_delta", sessionId, text: streamEvent.delta.thinking });
      }
      return;
    }
    case "assistant": {
      if (agentMessage.parent_tool_use_id) return;
      for (const contentBlock of agentMessage.message.content) {
        if (contentBlock.type === "thinking" && contentBlock.thinking.trim()) {
          persistAndPublish(sessionId, { kind: "thinking", text: contentBlock.thinking });
        } else if (contentBlock.type === "text" && contentBlock.text.trim()) {
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
        agentSessionId: sessionStore.get(sessionId)?.agentSessionId ?? undefined,
        lastChainUuid: turnTracking.lastChainUuid,
        contextTokens: turnTracking.contextTokens,
        contextWindow: contextWindowOf(agentMessage.modelUsage, turnTracking.model),
      });
      return;
    default:
      return;
  }
}

/** Options a turn and a context check of this session share (same tools, prompt and model, so the numbers match). */
async function sharedAgentOptions(sessionId: string, permissionMode: PermissionMode, model?: string): Promise<Options> {
  const session = sessionStore.get(sessionId);
  if (!session) throw new Error(t("Session nicht gefunden"));
  const project = projectStore.get(session.projectId);
  if (!project) throw new Error(t("Projekt nicht gefunden"));
  const claudeExecutablePath = await claudeExecutable();
  const teamAgent = session.agentId ? teamStore.get(session.agentId) : undefined;
  const agentSetup = await environmentStore.agentSetupFor(project.id);
  const integrationOptions = agentIntegrationOptions(project);
  const pluginOptions = agentPluginOptions();
  const projectEnvironment = environmentStore.forProject(project.id);
  return {
    pathToClaudeCodeExecutable: claudeExecutablePath,
    cwd: project.path,
    // The project's environment (accounts, git identity, variables) on top of the Claude credentials.
    env: agentSetup.env,
    // All design systems are open to the agent (it may create/link one mid-turn).
    // Plus workspace and environment memory, so the agent can read files stored there.
    additionalDirectories: [designSystemsDirectory, memoryConfig.workspaceDirectory(), ...(projectEnvironment ? [environmentMemoryDirectory(projectEnvironment.id)] : [])],
    model: teamAgent?.model || model || agentSetup.model || agentModelSettings.read(),
    thinking: { type: "adaptive", display: "summarized" },
    permissionMode,
    allowDangerouslySkipPermissions: permissionMode === "bypassPermissions",
    settingSources: ["user", "project", "local"],
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: [harnoldSystemAppend, teamContextFor(project, session.agentId), environmentStore.contextFor(project.id), designSystemStore.contextFor(project.id, sessionId), memoryNotes.contextFor(project), memoryFiles.contextFor(project)].filter(Boolean).join("\n\n"),
    },
    mcpServers: { ...integrationOptions.mcpServers, [memoryServerName]: createMemoryServer(project), [mediaServerName]: createMediaServer(project), [workspaceServerName]: createWorkspaceServer(project, sessionId, permissionMode) },
    allowedTools: [...workspaceToolNames, ...memoryToolNames, ...integrationOptions.allowedTools],
    skills: integrationOptions.skills,
    settings: pluginOptions.settings,
    plugins: pluginOptions.plugins,
  };
}

/** Plain text, or – with attachments – one user message with image/document/text blocks (streaming input). */
function promptFor(project: { id: string; path: string } & Parameters<typeof contentBlocksFor>[0], promptText: string, attachments: Attachment[]): string | AsyncIterable<SDKUserMessage> {
  if (!attachments.length) return promptText;
  const userMessage: SDKUserMessage = {
    type: "user",
    parent_tool_use_id: null,
    message: { role: "user", content: contentBlocksFor(project, promptText, attachments) },
  };
  return (async function* () {
    yield userMessage;
  })();
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
    // Fail early (before the message is stored) when Claude is missing.
    await claudeExecutable();
    await environmentStore.agentSetupFor(project.id);

    if (!session.agentSessionId && session.title === "Neue Session") {
      sessionStore.update(sessionId, { title: (text.trim() || attachments.map((attachment) => attachment.name).join(", ")).slice(0, 60) });
      eventHub.publish({ type: "sessions_changed", projectId: project.id });
    }
    const userChatItem = persistAndPublish(sessionId, { kind: "user_text", text, ...(attachments.length ? { attachments } : {}) });
    if (session.forkOriginSessionId && !session.forkItemId) sessionStore.update(sessionId, { forkItemId: userChatItem.id });
    // A version created by editing a message picks the conversation up at the point before that message.
    const pendingFork = session.agentSessionId ? null : session.pendingFork;
    const turnTracking: TurnTracking = {};

    const abortController = new AbortController();
    const outcome: TurnOutcome = { success: false, finalText: "" };
    runningTurns.set(sessionId, abortController);
    queuePausedSessionIds.delete(sessionId);
    eventHub.publish({ type: "turn_state", sessionId, running: true });

    try {
      const agentStream = query({
        prompt: promptFor(project, `${pendingFork?.mode === "transcript" ? `${pendingFork.transcript}\n\n${text}` : text}${mentionHintFor(project.id, text, session.agentId)}`, attachments),
        options: {
          ...(await sharedAgentOptions(sessionId, permissionMode, model)),
          ...(pendingFork?.mode === "resume"
            ? { resume: pendingFork.agentSessionId, resumeSessionAt: pendingFork.resumeAt, forkSession: true }
            : { resume: session.agentSessionId ?? undefined }),
          includePartialMessages: true,
          abortController,
          canUseTool: (toolName, input, { signal }) =>
            new Promise<PermissionResult>((resolve) => {
              const requestId = randomUUID();
              pendingPermissions.set(requestId, { sessionId, toolName, input, resolve });
              signal.addEventListener("abort", () => {
                pendingPermissions.delete(requestId);
                resolve({ behavior: "deny", message: "Abgebrochen" });
              });
              eventHub.publish({ type: "permission_request", sessionId, requestId, toolName, input });
            }),
        },
      });
      activeQueries.set(sessionId, agentStream);
      for await (const agentMessage of agentStream) {
        handleAgentMessage(sessionId, project.id, agentMessage, turnTracking);
        if (agentMessage.type === "system" && agentMessage.subtype === "init") {
          recordClaudeMcpServers(agentMessage.mcp_servers ?? []);
          const terminalOnlyNames = agentMessage.terminal_slash_commands ?? [];
          agentStream
            .supportedCommands()
            .then((reportedCommands) => agentCommands.remember(project.id, reportedCommands, terminalOnlyNames))
            .catch(() => undefined);
        }
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
      activeQueries.delete(sessionId);
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
  measureContext(sessionId: string, model?: string): Promise<ContextBreakdown> {
    const inFlight = contextMeasurementsInFlight.get(sessionId);
    if (inFlight) return inFlight;
    const activeQuery = activeQueries.get(sessionId);
    const measurement = (activeQuery ? activeQuery.getContextUsage({ detail: "full" }).then(toContextBreakdown) : measureIdleContext(sessionId, model)).finally(() =>
      contextMeasurementsInFlight.delete(sessionId),
    );
    contextMeasurementsInFlight.set(sessionId, measurement);
    return measurement;
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
