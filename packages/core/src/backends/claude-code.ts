import { query, type ModelUsage, type Options, type Query, type SDKControlGetContextUsageResponse, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
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
import type { AgentBackend, ContextBreakdown, TurnContext, TurnEvent, TurnInput } from "./types.ts";

const stringifyToolResultContent = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((block) => (block && typeof block === "object" && "text" in block ? String(block.text) : "[nicht-Text-Inhalt]")).join("\n");
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
      return;
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
            payload: { kind: "tool_result", toolUseId: contentBlock.tool_use_id, content: stringifyToolResultContent(contentBlock.content).slice(0, 20_000), isError: Boolean(contentBlock.is_error) },
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
  const toolServers = createHarnoldToolServers(project, sessionId, permissionMode);
  return {
    pathToClaudeCodeExecutable: await claudeExecutable(),
    cwd: project.path,
    // The project's environment (accounts, git identity, variables) on top of the provider credentials.
    env: context.env,
    // All design systems are open to the agent (it may create/link one mid-turn).
    // Plus workspace and environment memory, so the agent can read files stored there.
    // Plus the folders the user added to this chat.
    additionalDirectories: [designSystemsDirectory, memoryConfig.workspaceDirectory(), ...(projectEnvironment ? [environmentMemoryDirectory(projectEnvironment.id)] : []), ...context.session.directories],
    model: context.model,
    thinking: { type: "adaptive", display: "summarized" },
    permissionMode,
    allowDangerouslySkipPermissions: permissionMode === "bypassPermissions",
    settingSources: ["user", "project", "local"],
    systemPrompt: { type: "preset", preset: "claude_code", append: context.systemPromptAppend },
    mcpServers: { ...integrationOptions.mcpServers, ...toolServers },
    allowedTools: [...harnoldAutoAllowedToolNames, ...integrationOptions.allowedTools],
    skills: integrationOptions.skills,
    settings: pluginOptions.settings,
    plugins: pluginOptions.plugins,
  };
}

/** Plain text, or – with attachments – one user message with image/document/text blocks (streaming input). */
function promptFor(input: TurnInput): string | AsyncIterable<SDKUserMessage> {
  if (!input.attachments.length) return input.promptText;
  const userMessage: SDKUserMessage = {
    type: "user",
    parent_tool_use_id: null,
    message: { role: "user", content: contentBlocksFor(input.project, input.promptText, input.attachments) },
  };
  return (async function* () {
    yield userMessage;
  })();
}

/** Live query per running turn (asked for the context breakdown mid-turn). */
const activeQueries = new Map<string, Query>();
const contextMeasurementsInFlight = new Map<string, Promise<ContextBreakdown>>();

/** Without a running turn: start the CLI on the session without a prompt, ask, close (no model call, ~1 s). */
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

export const claudeCodeBackend: AgentBackend = {
  id: "claude-code",
  name: "Claude Code",
  capabilities: { interactivePermissions: true, questions: true, contextBreakdown: true, forkAtMessage: true, extensions: true },

  async status(forceRefresh = false) {
    const claudeStatus = await claudeAuth.status(forceRefresh);
    return { id: "claude-code", name: "Claude Code", ready: claudeStatus.ready, runtime: claudeStatus.runtime, capabilities: claudeCodeBackend.capabilities };
  },

  assertReady: () => claudeAuth.assertReady(),
  defaultModel: () => agentModelSettings.read("claude-code"),

  async *runTurn(input) {
    const abortController = new AbortController();
    const relayAbort = () => abortController.abort();
    if (input.signal.aborted) relayAbort();
    else input.signal.addEventListener("abort", relayAbort, { once: true });

    const turnTracking: TurnTracking = {};
    let finalText = "";
    let success = false;
    let errorText: string | undefined;
    const pendingFork = input.pendingFork;
    const agentStream = query({
      prompt: promptFor(input),
      options: {
        ...(await sharedAgentOptions(input)),
        ...(pendingFork?.mode === "resume"
          ? { resume: pendingFork.agentSessionId, resumeSessionAt: pendingFork.resumeAt, forkSession: true }
          : { resume: input.resumeSessionId ?? undefined }),
        includePartialMessages: true,
        abortController,
        canUseTool: (toolName, toolInput, { signal }) => input.requestPermission(toolName, toolInput, signal),
      },
    });
    activeQueries.set(input.sessionId, agentStream);
    try {
      for await (const agentMessage of agentStream) {
        yield* eventsFor(input.project.id, agentMessage, turnTracking);
        if (agentMessage.type === "system" && agentMessage.subtype === "init") {
          recordClaudeMcpServers(agentMessage.mcp_servers ?? []);
          const terminalOnlyNames = agentMessage.terminal_slash_commands ?? [];
          agentStream
            .supportedCommands()
            .then((reportedCommands) => agentCommands.remember(input.project.id, reportedCommands, terminalOnlyNames))
            .catch(() => undefined);
        }
        if (agentMessage.type === "assistant" && !agentMessage.parent_tool_use_id) {
          const turnText = agentMessage.message.content
            .flatMap((contentBlock) => (contentBlock.type === "text" && contentBlock.text.trim() ? [contentBlock.text] : []))
            .join("\n\n");
          if (turnText) finalText = turnText; // last top-level text = the answer
        } else if (agentMessage.type === "result") {
          success = agentMessage.subtype === "success" && !agentMessage.is_error;
          if (agentMessage.subtype !== "success") errorText = agentMessage.errors.join("\n");
        }
      }
    } finally {
      activeQueries.delete(input.sessionId);
      input.signal.removeEventListener("abort", relayAbort);
    }
    yield { type: "outcome", success, finalText, errorText };
  },

  measureContext(context) {
    const inFlight = contextMeasurementsInFlight.get(context.sessionId);
    if (inFlight) return inFlight;
    const activeQuery = activeQueries.get(context.sessionId);
    const measurement = (activeQuery ? activeQuery.getContextUsage({ detail: "full" }).then(toContextBreakdown) : measureIdleContext(context)).finally(() =>
      contextMeasurementsInFlight.delete(context.sessionId),
    );
    contextMeasurementsInFlight.set(context.sessionId, measurement);
    return measurement;
  },
};

