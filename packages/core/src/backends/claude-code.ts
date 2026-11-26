import { getSessionInfo, query, type ModelUsage, type Options, type PermissionResult, type Query, type SDKControlGetContextUsageResponse, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ChatItemPayload } from "../db.ts";
import { contentBlocksFor } from "../attachments.ts";
import { designSystemsDirectory } from "../design-system.ts";
import { environmentStore } from "../environments.ts";
import { environmentMemoryDirectory, memoryConfig } from "../memory.ts";
import { agentIntegrationOptions } from "../integrations.ts";
import { agentModelSettings, claudeAuth, claudeExecutable } from "../claude-auth.ts";
import { agentCommands } from "../slash-commands.ts";
import { agentPluginOptions } from "../plugins.ts";
import { recordClaudeMcpServers } from "../mcp-discovery.ts";
import { createHarnoldToolServers, harnoldAutoAllowedToolNames } from "../harnold-tools.ts";
import { t } from "../i18n.ts";
import { shortTaskName } from "../task-names.ts";
import type { AgentBackend, BackgroundTask, EffortLevel, BackgroundTurnHandler, SessionEventHandler, SteerInput, ContextBreakdown, PermissionMode, PermissionSuggestion, TurnContext, TurnEvent, TurnInput } from "./types.ts";

/** Image blocks of an MCP result (base64), so the chat can show them instead of a placeholder. */
const imagesOfToolResult = (content: unknown): { mediaType: string; data: string }[] | undefined => {
  if (!Array.isArray(content)) return undefined;
  const images = content.flatMap((block) => {
    const source = block && typeof block === "object" && block.type === "image" ? (block as { source?: { type?: string; media_type?: string; data?: string } }).source : undefined;
    return source?.type === "base64" && source.data && source.media_type?.startsWith("image/") ? [{ mediaType: source.media_type, data: source.data }] : [];
  });
  return images.length ? images.slice(0, 6) : undefined;
};

/** Embedded HTML resources of an MCP result (interactive UIs), shown sandboxed in the chat. */
const htmlOfToolResult = (content: unknown): string[] | undefined => {
  if (!Array.isArray(content)) return undefined;
  const documents = content.flatMap((block) => {
    const resource = block && typeof block === "object" && block.type === "resource" ? (block as { resource?: { mimeType?: string; text?: string } }).resource : undefined;
    return resource?.text && resource.mimeType?.startsWith("text/html") ? [resource.text.slice(0, 500_000)] : [];
  });
  return documents.length ? documents.slice(0, 3) : undefined;
};

const stringifyToolResultContent = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((block) => (block && typeof block === "object" && "text" in block ? String(block.text) : block && typeof block === "object" && block.type === "image" ? "" : "[nicht-Text-Inhalt]"))
      .filter(Boolean)
      .join("\n");
  }
  return JSON.stringify(content);
};

/** Window size of the main model (the one that answered last); other entries are subagents/helpers. */
function contextWindowOf(modelUsage: Record<string, ModelUsage> | undefined, model: string | undefined): number | undefined {
  const usageEntries = Object.entries(modelUsage ?? {});
  const mainEntry = usageEntries.find(([modelName]) => model && (modelName === model || modelName.startsWith(model) || model.startsWith(modelName)));
  return mainEntry?.[1].contextWindow ?? (usageEntries.length ? Math.max(...usageEntries.map(([, usage]) => usage.contextWindow)) : undefined);
}

const toContextBreakdown = (usage: SDKControlGetContextUsageResponse): ContextBreakdown => ({
  model: usage.model,
  totalTokens: usage.totalTokens,
  maxTokens: usage.maxTokens,
  percentage: usage.percentage,
  categories: usage.categories.map((category) => ({ id: category.id, name: category.name, tokens: category.tokens, kind: category.kind })),
});

/** Per-turn bookkeeping: the last main-thread transcript entry is the fork point for edits of later messages. */
type TurnTracking = { lastChainUuid?: string; contextTokens?: number; model?: string };

/** Maps one SDK message onto provider-independent turn events. */
function* eventsFor(projectId: string, agentMessage: SDKMessage, turnTracking: TurnTracking): Generator<TurnEvent> {
  if ((agentMessage.type === "assistant" || agentMessage.type === "user") && !agentMessage.parent_tool_use_id && agentMessage.uuid) {
    turnTracking.lastChainUuid = agentMessage.uuid;
  }
  switch (agentMessage.type) {
    case "system":
      if (agentMessage.subtype === "init") yield { type: "session_started", agentSessionId: agentMessage.session_id };
      else if (agentMessage.subtype === "compact_boundary") {
        const { pre_tokens: tokensBefore, post_tokens: tokensAfter } = agentMessage.compact_metadata;
        const tokenText = (tokenCount: number) => `${Math.round(tokenCount / 1000)}k`;
        yield { type: "item", payload: { kind: "notice", text: `Kontext komprimiert${tokensAfter ? ` · ${tokenText(tokensBefore)} → ${tokenText(tokensAfter)} Tokens` : ` · vorher ${tokenText(tokensBefore)} Tokens`}` } };
        if (tokensAfter) {
          turnTracking.contextTokens = tokensAfter;
          yield { type: "context_size", tokens: tokensAfter };
        }
      } else if (agentMessage.subtype === "commands_changed") agentCommands.remember(projectId, agentMessage.commands);
      else if (agentMessage.subtype === "status") {
        yield { type: "status", text: agentMessage.status === "compacting" ? t("Kontext wird komprimiert …") : null };
      } else if (agentMessage.subtype === "api_retry") {
        const retrySeconds = Math.max(1, Math.round(agentMessage.retry_delay_ms / 1000));
        yield {
          type: "status",
          text: t("API antwortet nicht{0} – neuer Versuch {1}/{2} in {3} s", agentMessage.error_status ? ` (${agentMessage.error_status})` : "", agentMessage.attempt, agentMessage.max_retries, retrySeconds),
        };
      } else if (agentMessage.subtype === "task_started" && !agentMessage.skip_transcript) {
        yield { type: "status", text: shortTaskName(agentMessage.description) };
      } else if (agentMessage.subtype === "task_progress") {
        const progressParts = [shortTaskName(agentMessage.description), agentMessage.summary ? shortTaskName(agentMessage.summary) : agentMessage.last_tool_name].filter(Boolean);
        yield { type: "status", text: progressParts.join(" · ") };
      } else if (agentMessage.subtype === "task_notification" && !agentMessage.skip_transcript && !agentMessage.ambient) {
        const statusText = agentMessage.status === "completed" ? t("Hintergrund-Aufgabe fertig") : agentMessage.status === "failed" ? t("Hintergrund-Aufgabe fehlgeschlagen") : t("Hintergrund-Aufgabe gestoppt");
        yield { type: "item", payload: { kind: "notice", text: `${statusText}${agentMessage.summary ? `: ${shortTaskName(agentMessage.summary)}` : ""}` } };
      }
      return;
    case "rate_limit_event": {
      const limitInfo = agentMessage.rate_limit_info;
      const resetTime = limitInfo.resetsAt ? new Date(limitInfo.resetsAt * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "";
      if (limitInfo.status === "rejected") {
        yield { type: "item", payload: { kind: "notice", text: resetTime ? t("Nutzungslimit erreicht – wieder frei um {0}", resetTime) : t("Nutzungslimit erreicht") } };
      } else if (limitInfo.status === "allowed_warning" && limitInfo.utilization !== undefined) {
        yield { type: "status", text: t("{0} % des Nutzungslimits verbraucht", Math.round(limitInfo.utilization * 100)) };
      }
      return;
    }
    case "stream_event": {
      if (agentMessage.parent_tool_use_id) return;
      const streamEvent = agentMessage.event;
      if (streamEvent.type === "message_start") {
        const requestUsage = streamEvent.message.usage;
        turnTracking.contextTokens = requestUsage.input_tokens + (requestUsage.cache_creation_input_tokens ?? 0) + (requestUsage.cache_read_input_tokens ?? 0);
        turnTracking.model = streamEvent.message.model;
        yield { type: "context_size", tokens: turnTracking.contextTokens };
      } else if (streamEvent.type === "content_block_delta" && streamEvent.delta.type === "text_delta") {
        yield { type: "text_delta", text: streamEvent.delta.text };
      } else if (streamEvent.type === "content_block_delta" && streamEvent.delta.type === "thinking_delta") {
        yield { type: "thinking_delta", text: streamEvent.delta.thinking };
      }
      return;
    }
    case "assistant": {
      if (agentMessage.parent_tool_use_id) return;
      for (const contentBlock of agentMessage.message.content) {
        if (contentBlock.type === "thinking" && contentBlock.thinking.trim()) {
          yield { type: "item", payload: { kind: "thinking", text: contentBlock.thinking } };
        } else if (contentBlock.type === "text" && contentBlock.text.trim()) {
          yield { type: "item", payload: { kind: "assistant_text", text: contentBlock.text } };
        } else if (contentBlock.type === "tool_use") {
          yield { type: "item", payload: { kind: "tool_use", toolUseId: contentBlock.id, toolName: contentBlock.name, input: contentBlock.input } };
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
          yield {
            type: "item",
            payload: {
              kind: "tool_result",
              toolUseId: contentBlock.tool_use_id,
              content: stringifyToolResultContent(contentBlock.content).slice(0, 20_000),
              isError: Boolean(contentBlock.is_error),
              images: imagesOfToolResult(contentBlock.content),
              html: htmlOfToolResult(contentBlock.content),
            },
          };
        }
      }
      return;
    }
    case "result": {
      const payload: ChatItemPayload = {
        kind: "turn_result",
        success: agentMessage.subtype === "success" && !agentMessage.is_error,
        costUsd: agentMessage.total_cost_usd,
        durationMs: agentMessage.duration_ms,
        errorText: agentMessage.subtype === "success" ? undefined : agentMessage.errors.join("\n"),
        lastChainUuid: turnTracking.lastChainUuid,
        contextTokens: turnTracking.contextTokens,
        contextWindow: contextWindowOf(agentMessage.modelUsage, turnTracking.model),
      };
      yield { type: "item", payload };
      return;
    }
    default:
      return;
  }
}

/** Options a turn and a context check of this session share (same tools, prompt and model, so the numbers match). */
async function sharedAgentOptions(context: TurnContext): Promise<Options> {
  const { project, sessionId, permissionMode } = context;
  const integrationOptions = agentIntegrationOptions(project);
  const pluginOptions = agentPluginOptions();
  const projectEnvironment = environmentStore.forProject(project.id);
  // A getter: the process outlives the turn and may switch modes live.
  const toolServers = createHarnoldToolServers(project, sessionId, () => liveSessions.get(sessionId)?.permissionMode ?? permissionMode);
  return {
    pathToClaudeCodeExecutable: await claudeExecutable(),
    cwd: context.workingDirectory,
    // The project's environment (accounts, git identity, variables) on top of the provider credentials.
    // Prompt caching stays on: the CLI then reuses the grown conversation prefix instead of re-reading it.
    env: { ...context.env, DISABLE_PROMPT_CACHING: "0" },
    // All design systems are open to the agent (it may create/link one mid-turn).
    // Plus workspace and environment memory, so the agent can read files stored there.
    // Plus the folders the user added to this chat.
    additionalDirectories: [designSystemsDirectory, memoryConfig.workspaceDirectory(), ...(projectEnvironment ? [environmentMemoryDirectory(projectEnvironment.id)] : []), ...context.session.directories],
    model: context.model,
    thinking: { type: "adaptive", display: "summarized" },
    permissionMode,
    allowDangerouslySkipPermissions: permissionMode === "bypassPermissions",
    settingSources: ["user", "project", "local"],
    // Backups before each edit, so files can be restored to the state before any user message.
    enableFileCheckpointing: true,
    systemPrompt: { type: "preset", preset: "claude_code", append: context.systemPromptAppend },
    mcpServers: { ...integrationOptions.mcpServers, ...toolServers },
    allowedTools: [...harnoldAutoAllowedToolNames, ...integrationOptions.allowedTools],
    skills: integrationOptions.skills,
    settings: pluginOptions.settings,
    plugins: pluginOptions.plugins,
  };
}

/** Push-based async queue: the SDK's input stream and the message stream of one turn. */
type AsyncQueue<Value> = AsyncIterable<Value> & { push(value: Value): void; end(): void };

function createAsyncQueue<Value>(): AsyncQueue<Value> {
  const bufferedValues: Value[] = [];
  let wakeReader: (() => void) | null = null;
  let ended = false;
  const wake = () => {
    const reader = wakeReader;
    wakeReader = null;
    reader?.();
  };
  return {
    push(value) {
      if (ended) return;
      bufferedValues.push(value);
      wake();
    },
    end() {
      ended = true;
      wake();
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (bufferedValues.length) yield bufferedValues.shift() as Value;
        else if (ended) return;
        else await new Promise<void>((resolve) => (wakeReader = resolve));
      }
    },
  };
}

/** One user message: plain text, or – with attachments – image/document/text blocks. */
function userMessageFor(input: SteerInput): SDKUserMessage {
  return {
    type: "user",
    // The chat item's id: Claude Code checkpoints files per user message under this uuid.
    uuid: input.userMessageId as SDKUserMessage["uuid"],
    parent_tool_use_id: null,
    origin: { kind: "human" },
    message: { role: "user", content: input.attachments.length ? contentBlocksFor(input.project, input.promptText, input.attachments) : input.promptText },
  };
}

/** How long an idle conversation keeps its process (background tasks keep it alive regardless). */
const idleProcessLifetimeMs = 30 * 60_000;
/** Idle processes kept at most (each Claude Code process holds a few hundred MB); the least recently used goes first. */
const maxIdleLiveSessions = 6;
/** After a stop: if the agent does not end the turn by then, the process is closed. */
const interruptGraceMs = 10_000;

/**
 * One long-running Claude Code process per conversation (streaming input), like the Claude desktop app:
 * background tasks survive the end of a turn, and when one finishes the agent may start a turn on its own.
 */
type LiveSession = {
  sessionId: string;
  projectId: string;
  agentQuery: Query;
  input: AsyncQueue<SDKUserMessage>;
  /** Options that need a new process when they change (see optionsFingerprint). */
  fingerprint: string;
  agentSessionId: string | null;
  permissionMode: PermissionMode;
  model: string;
  effort: EffortLevel | undefined;
  keepAlive: boolean;
  /** Messages of the running turn (user- or agent-started); null between turns. */
  activeTurn: AsyncQueue<SDKMessage> | null;
  backgroundTaskIds: Set<string>;
  /** The process may report init before the first turn listens; handed to that turn. */
  unroutedInit: SDKMessage | null;
  /** Replaced by every user turn; background turns ask through the latest one. */
  requestPermission: TurnInput["requestPermission"];
  idleTimer?: NodeJS.Timeout;
  lastUsedAt: number;
  closed: boolean;
};

const liveSessions = new Map<string, LiveSession>();
let backgroundTurnHandler: BackgroundTurnHandler | null = null;
let sessionEventHandler: SessionEventHandler | null = null;

/** Options whose change requires a new process. Model and permission mode switch live. */
function optionsFingerprint(options: Options): string {
  const comparableMcpServers = Object.fromEntries(
    Object.entries(options.mcpServers ?? {}).map(([serverName, serverConfig]) => [serverName, serverConfig.type === "sdk" ? "sdk" : serverConfig]),
  );
  return JSON.stringify({
    executable: options.pathToClaudeCodeExecutable,
    cwd: options.cwd,
    env: options.env,
    additionalDirectories: options.additionalDirectories,
    systemPrompt: options.systemPrompt,
    mcpServers: comparableMcpServers,
    allowedTools: options.allowedTools,
    skills: options.skills,
    settings: options.settings,
    plugins: options.plugins,
  });
}

function closeLiveSession(liveSession: LiveSession): void {
  if (liveSessions.get(liveSession.sessionId) === liveSession) liveSessions.delete(liveSession.sessionId);
  if (liveSession.closed) return;
  liveSession.closed = true;
  // Background tasks end with the process.
  if (liveSession.backgroundTaskIds.size) sessionEventHandler?.(liveSession.sessionId, { type: "background_tasks", tasks: [] });
  clearTimeout(liveSession.idleTimer);
  liveSession.input.end();
  liveSession.activeTurn?.end();
  liveSession.activeTurn = null;
  try {
    liveSession.agentQuery.close();
  } catch {
    /* already gone */
  }
}

const isIdle = (liveSession: LiveSession) => !liveSession.activeTurn && !liveSession.backgroundTaskIds.size;

function closeSurplusIdleSessions(): void {
  const idleSessions = [...liveSessions.values()].filter(isIdle).sort((first, second) => first.lastUsedAt - second.lastUsedAt);
  for (const surplusSession of idleSessions.slice(0, Math.max(0, idleSessions.length - maxIdleLiveSessions))) closeLiveSession(surplusSession);
}

/** Between turns: close right away (background runs) or after the idle lifetime – never while background tasks run. */
function scheduleIdleClose(liveSession: LiveSession): void {
  clearTimeout(liveSession.idleTimer);
  if (liveSession.closed || liveSession.activeTurn || liveSession.backgroundTaskIds.size) return;
  if (!liveSession.keepAlive) {
    closeLiveSession(liveSession);
    return;
  }
  liveSession.idleTimer = setTimeout(() => {
    if (!liveSession.activeTurn && !liveSession.backgroundTaskIds.size) closeLiveSession(liveSession);
  }, idleProcessLifetimeMs);
  liveSession.idleTimer.unref?.();
}

/** Messages that mean the model is answering – between turns they open a turn the agent started itself. */
const opensTurn = (agentMessage: SDKMessage) => agentMessage.type === "assistant" || agentMessage.type === "stream_event";

/** Routes every message of the process to the running turn, or opens a background turn. */
function routeMessage(liveSession: LiveSession, agentMessage: SDKMessage): void {
  if (agentMessage.type === "system" && agentMessage.subtype === "init") liveSession.agentSessionId = agentMessage.session_id;
  if (agentMessage.type === "system" && agentMessage.subtype === "background_tasks_changed") {
    liveSession.backgroundTaskIds = new Set(agentMessage.tasks.map((backgroundTask) => backgroundTask.task_id));
    const visibleTasks: BackgroundTask[] = agentMessage.tasks
      .filter((backgroundTask) => !backgroundTask.ambient)
      .map((backgroundTask) => ({ id: backgroundTask.task_id, description: shortTaskName(backgroundTask.description), taskType: backgroundTask.task_type }));
    sessionEventHandler?.(liveSession.sessionId, { type: "background_tasks", tasks: visibleTasks });
    scheduleIdleClose(liveSession);
  }
  if (!liveSession.activeTurn) {
    if (agentMessage.type === "system" && agentMessage.subtype === "init") {
      liveSession.unroutedInit = agentMessage;
      return;
    }
    if (!opensTurn(agentMessage) || !backgroundTurnHandler) {
      // Between turns: notices (e.g. a background task finished) still reach the chat.
      for (const turnEvent of eventsFor(liveSession.projectId, agentMessage, {})) {
        if (turnEvent.type === "item" || turnEvent.type === "status") sessionEventHandler?.(liveSession.sessionId, turnEvent);
      }
      return;
    }
    clearTimeout(liveSession.idleTimer);
    const backgroundTurn = createAsyncQueue<SDKMessage>();
    liveSession.activeTurn = backgroundTurn;
    takeUnroutedInit(liveSession, backgroundTurn);
    let stopRequested = false;
    backgroundTurnHandler(
      liveSession.sessionId,
      turnEventsFrom(liveSession, backgroundTurn, () => stopRequested),
      () => {
        stopRequested = true;
        interruptLiveTurn(liveSession, backgroundTurn);
      },
    );
  }
  liveSession.activeTurn.push(agentMessage);
  if (agentMessage.type === "result") {
    liveSession.activeTurn.end();
    liveSession.activeTurn = null;
    scheduleIdleClose(liveSession);
  }
}

function takeUnroutedInit(liveSession: LiveSession, turn: AsyncQueue<SDKMessage>): void {
  if (!liveSession.unroutedInit) return;
  turn.push(liveSession.unroutedInit);
  liveSession.unroutedInit = null;
}

/** Stops the running turn; the process stays unless the agent does not react. */
function interruptLiveTurn(liveSession: LiveSession, turn: AsyncQueue<SDKMessage>): void {
  liveSession.agentQuery.interrupt().catch(() => closeLiveSession(liveSession));
  setTimeout(() => {
    if (liveSession.activeTurn === turn) closeLiveSession(liveSession);
  }, interruptGraceMs).unref?.();
}

async function pumpMessages(liveSession: LiveSession): Promise<void> {
  try {
    for await (const agentMessage of liveSession.agentQuery) routeMessage(liveSession, agentMessage);
  } catch (pumpError) {
    if (!liveSession.closed) console.error("[claude-code] process ended", pumpError);
  } finally {
    closeLiveSession(liveSession);
  }
}

/** Turns the messages of one turn into turn events, ending with the outcome. */
async function* turnEventsFrom(liveSession: LiveSession, turnMessages: AsyncQueue<SDKMessage>, wasStopped: () => boolean): AsyncGenerator<TurnEvent> {
  const turnTracking: TurnTracking = {};
  let finalText = "";
  let sawResult = false;
  let success = false;
  let errorText: string | undefined;
  for await (const agentMessage of turnMessages) {
    if (agentMessage.type === "result") {
      sawResult = true;
      success = agentMessage.subtype === "success" && !agentMessage.is_error;
      if (agentMessage.subtype !== "success") errorText = agentMessage.errors.join("\n");
      // A stopped turn ends quietly, as before (no error card).
      if (wasStopped()) break;
    }
    if (agentMessage.type === "system" && agentMessage.subtype === "init") {
      recordClaudeMcpServers(agentMessage.mcp_servers ?? []);
      const terminalOnlyNames = agentMessage.terminal_slash_commands ?? [];
      liveSession.agentQuery
        .supportedCommands()
        .then((reportedCommands) => agentCommands.remember(liveSession.projectId, reportedCommands, terminalOnlyNames))
        .catch(() => undefined);
    }
    yield* eventsFor(liveSession.projectId, agentMessage, turnTracking);
    if (agentMessage.type === "assistant" && !agentMessage.parent_tool_use_id) {
      const turnText = agentMessage.message.content
        .flatMap((contentBlock) => (contentBlock.type === "text" && contentBlock.text.trim() ? [contentBlock.text] : []))
        .join("\n\n");
      if (turnText) finalText = turnText; // last top-level text = the answer
    }
  }
  if (wasStopped()) yield { type: "outcome", success: false, finalText, errorText: "Abgebrochen" };
  else yield { type: "outcome", success, finalText, errorText: sawResult ? errorText : (errorText ?? "Der Agent-Prozess wurde beendet") };
}

/** The conversation's process: reused while its options and conversation match, else (re)started. */
async function liveSessionFor(input: TurnInput): Promise<LiveSession> {
  const options = await sharedAgentOptions(input);
  const fingerprint = optionsFingerprint(options);
  const wantsFork = input.pendingFork?.mode === "resume";
  const existing = liveSessions.get(input.sessionId);
  if (existing && !existing.closed) {
    const sameConversation = !wantsFork && existing.agentSessionId !== null && existing.agentSessionId === input.resumeSessionId;
    // Running background tasks outweigh a changed prompt: restarting would kill them.
    if (sameConversation && (existing.fingerprint === fingerprint || existing.backgroundTaskIds.size)) {
      existing.keepAlive = input.keepAlive;
      return existing;
    }
    closeLiveSession(existing);
  }

  const inputQueue = createAsyncQueue<SDKUserMessage>();
  // canUseTool reads the session lazily, so the query can be created first.
  let liveSession: LiveSession | undefined;
  const agentQuery = query({
    prompt: inputQueue,
    options: {
      ...options,
      ...(wantsFork && input.pendingFork?.mode === "resume"
        ? { resume: input.pendingFork.agentSessionId, resumeSessionAt: input.pendingFork.resumeAt, forkSession: true }
        : { resume: input.resumeSessionId ?? undefined }),
      includePartialMessages: true,
      ...(input.effort ? { effort: input.effort } : {}),
      // Short summaries of what a subagent is doing, as in the Claude desktop app.
      agentProgressSummaries: true,
      canUseTool: async (toolName, toolInput, { signal, suggestions }) => {
        if (!liveSession) return { behavior: "deny" as const, message: "Abgebrochen" };
        const decision = await liveSession.requestPermission(toolName, toolInput, signal, suggestions as PermissionSuggestion[] | undefined);
        if (decision.behavior === "allow" && decision.updatedPermissions?.length) {
          const switchedMode = decision.updatedPermissions.find((update) => update.type === "setMode")?.mode as PermissionMode | undefined;
          if (switchedMode) liveSession.permissionMode = switchedMode;
        }
        return decision as PermissionResult;
      },
    },
  });
  liveSession = {
    sessionId: input.sessionId,
    projectId: input.project.id,
    agentQuery,
    input: inputQueue,
    fingerprint,
    agentSessionId: null,
    permissionMode: input.permissionMode,
    model: input.model,
    effort: input.effort,
    keepAlive: input.keepAlive,
    activeTurn: null,
    backgroundTaskIds: new Set<string>(),
    requestPermission: input.requestPermission,
    unroutedInit: null,
    lastUsedAt: Date.now(),
    closed: false,
  };
  liveSessions.set(input.sessionId, liveSession);
  closeSurplusIdleSessions();
  void pumpMessages(liveSession);
  return liveSession;
}

/** Without a running process: start the CLI on the session without a prompt, ask, close (no model call, ~1 s). */
async function measureIdleContext(context: TurnContext): Promise<ContextBreakdown> {
  let releaseInput: () => void = () => undefined;
  const inputDone = new Promise<void>((resolve) => (releaseInput = resolve));
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort(), 60_000);
  const idleQuery = query({
    prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
      await inputDone;
    })(),
    options: { ...(await sharedAgentOptions({ ...context, permissionMode: "default" })), resume: context.session.agentSessionId ?? undefined, persistSession: Boolean(context.session.agentSessionId), abortController },
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

/** Runs fn on the conversation's process, or on a short-lived one resumed for it (no model call). */
async function withConversationProcess<Result>(context: TurnContext, run: (agentQuery: Query) => Promise<Result>): Promise<Result> {
  const liveSession = liveSessions.get(context.sessionId);
  if (liveSession && !liveSession.closed) return run(liveSession.agentQuery);
  if (!context.session.agentSessionId) throw new Error(t("Diese Unterhaltung hat noch keinen Agent-Verlauf"));
  let releaseInput: () => void = () => undefined;
  const inputDone = new Promise<void>((resolve) => (releaseInput = resolve));
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort(), 60_000);
  const shortQuery = query({
    prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
      await inputDone;
    })(),
    options: { ...(await sharedAgentOptions({ ...context, permissionMode: "default" })), resume: context.session.agentSessionId, abortController },
  });
  try {
    return await run(shortQuery);
  } finally {
    clearTimeout(timeoutHandle);
    releaseInput();
    void (async () => {
      for await (const _shortMessage of shortQuery);
    })().catch(() => undefined);
  }
}

const contextMeasurementsInFlight = new Map<string, Promise<ContextBreakdown>>();

export const claudeCodeBackend: AgentBackend = {
  id: "claude-code",
  name: "Claude Code",
  capabilities: { interactivePermissions: true, questions: true, contextBreakdown: true, forkAtMessage: true, extensions: true, steering: true, effort: true, rewindFiles: true },

  async status(forceRefresh = false) {
    const claudeStatus = await claudeAuth.status(forceRefresh);
    return { id: "claude-code", name: "Claude Code", ready: claudeStatus.ready, runtime: claudeStatus.runtime, capabilities: claudeCodeBackend.capabilities };
  },

  assertReady: () => claudeAuth.assertReady(),
  defaultModel: () => agentModelSettings.read("claude-code"),

  async *runTurn(input) {
    const liveSession = await liveSessionFor(input);
    if (liveSession.activeTurn) throw new Error("In dieser Session läuft bereits ein Durchlauf");
    clearTimeout(liveSession.idleTimer);
    liveSession.lastUsedAt = Date.now();
    liveSession.requestPermission = input.requestPermission;
    if (liveSession.permissionMode !== input.permissionMode) {
      await liveSession.agentQuery.setPermissionMode(input.permissionMode);
      liveSession.permissionMode = input.permissionMode;
    }
    if (liveSession.model !== input.model) {
      await liveSession.agentQuery.setModel(input.model || undefined);
      liveSession.model = input.model;
    }
    if (liveSession.effort !== input.effort) {
      await liveSession.agentQuery.applyFlagSettings({ effortLevel: input.effort ?? null });
      liveSession.effort = input.effort;
    }

    const turnMessages = createAsyncQueue<SDKMessage>();
    liveSession.activeTurn = turnMessages;
    takeUnroutedInit(liveSession, turnMessages);
    const stopTurn = () => interruptLiveTurn(liveSession, turnMessages);
    if (input.signal.aborted) stopTurn();
    else input.signal.addEventListener("abort", stopTurn, { once: true });
    try {
      liveSession.input.push(userMessageFor(input));
      yield* turnEventsFrom(liveSession, turnMessages, () => input.signal.aborted);
    } finally {
      input.signal.removeEventListener("abort", stopTurn);
      if (liveSession.activeTurn === turnMessages) {
        // Left early (stopped): later messages of this turn are dropped until its result arrives.
        liveSession.activeTurn = createAsyncQueue<SDKMessage>();
      }
      scheduleIdleClose(liveSession);
    }
  },

  measureContext(context) {
    const inFlight = contextMeasurementsInFlight.get(context.sessionId);
    if (inFlight) return inFlight;
    const liveSession = liveSessions.get(context.sessionId);
    const measurement = (liveSession && !liveSession.closed ? liveSession.agentQuery.getContextUsage({ detail: "full" }).then(toContextBreakdown) : measureIdleContext(context)).finally(() =>
      contextMeasurementsInFlight.delete(context.sessionId),
    );
    contextMeasurementsInFlight.set(context.sessionId, measurement);
    return measurement;
  },

  onBackgroundTurn(handler) {
    backgroundTurnHandler = handler;
  },

  onSessionEvent(handler) {
    sessionEventHandler = handler;
  },

  async stopBackgroundTask(sessionId, taskId) {
    const liveSession = liveSessions.get(sessionId);
    if (liveSession && !liveSession.closed) await liveSession.agentQuery.stopTask(taskId);
  },

  async generatedTitle(context) {
    if (!context.session.agentSessionId) return undefined;
    const sessionInfo = await getSessionInfo(context.session.agentSessionId, { dir: context.workingDirectory }).catch(() => undefined);
    const title = sessionInfo?.customTitle ?? sessionInfo?.summary;
    // Without a generated title the summary is just the first prompt.
    return title && title !== sessionInfo?.firstPrompt ? title : undefined;
  },

  rewindFiles(context, userMessageId, dryRun) {
    return withConversationProcess(context, (agentQuery) => agentQuery.rewindFiles(userMessageId, { dryRun }));
  },

  steer(sessionId, steerInput) {
    const liveSession = liveSessions.get(sessionId);
    if (!liveSession || liveSession.closed || !liveSession.activeTurn) return false;
    // Claude Code folds it into the running turn after the current step (or runs it right after).
    liveSession.input.push(userMessageFor(steerInput));
    return true;
  },

  release(sessionId) {
    const liveSession = liveSessions.get(sessionId);
    if (liveSession) closeLiveSession(liveSession);
  },
};
