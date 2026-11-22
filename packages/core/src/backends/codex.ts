import fs from "node:fs";
import { Codex, type SandboxMode, type ThreadEvent, type ThreadItem, type ThreadOptions, type UserInput } from "@openai/codex-sdk";
import type { ChatItemPayload } from "../db.ts";
import { resolveInsideProject } from "../files.ts";
import { designSystemsDirectory } from "../design-system.ts";
import { environmentStore } from "../environments.ts";
import { environmentMemoryDirectory, memoryConfig } from "../memory.ts";
import { agentIntegrationOptions } from "../integrations.ts";
import { codexAuth, codexDefaultModel, codexExecutable, codexSettings } from "../codex-auth.ts";
import { harnoldMcp } from "../mcp-http.ts";
import type { AgentBackend, PermissionMode, TurnEvent, TurnInput } from "./types.ts";

/**
 * Codex has no per-call approval in Harnold: the permission mode picks how far its sandbox reaches.
 * "Fragen"/"Edits erlauben" → may write inside the project, "Planen" → read only, "Alles erlauben" → no sandbox.
 */
const sandboxFor: Record<PermissionMode, SandboxMode> = {
  default: "workspace-write",
  acceptEdits: "workspace-write",
  plan: "read-only",
  bypassPermissions: "danger-full-access",
};

const toStringEnvironment = (environment: NodeJS.ProcessEnv): Record<string, string> =>
  Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => typeof entry[1] === "string"));

/** User-configured MCP servers in Codex's config format (stdio and streamable HTTP only). */
function userMcpServers(input: TurnInput): Record<string, Record<string, unknown>> {
  const servers: Record<string, Record<string, unknown>> = {};
  for (const [serverName, serverConfig] of Object.entries(agentIntegrationOptions(input.project).mcpServers)) {
    if (serverConfig.type === "stdio" || serverConfig.type === undefined) {
      servers[serverName] = { command: serverConfig.command, args: serverConfig.args ?? [], ...(serverConfig.env ? { env: serverConfig.env } : {}) };
    } else if (serverConfig.type === "http") {
      servers[serverName] = { url: serverConfig.url, ...(serverConfig.headers ? { http_headers: serverConfig.headers } : {}) };
    }
  }
  return servers;
}

function promptFor(input: TurnInput): string | UserInput[] {
  if (!input.attachments.length) return input.promptText;
  const parts: UserInput[] = [];
  const references: string[] = [];
  for (const attachment of input.attachments) {
    const absolutePath = resolveInsideProject(input.project, attachment.path);
    if (!fs.existsSync(absolutePath)) continue;
    if (attachment.mimeType.startsWith("image/")) parts.push({ type: "local_image", path: absolutePath });
    references.push(`Angehängt: ${attachment.name} (liegt unter ${attachment.path})`);
  }
  parts.unshift({ type: "text", text: [...references, input.promptText].filter(Boolean).join("\n\n") });
  return parts;
}

const toolResultText = (item: ThreadItem): { content: string; isError: boolean } => {
  switch (item.type) {
    case "command_execution":
      return { content: `${item.aggregated_output}${item.exit_code !== undefined && item.exit_code !== 0 ? `\n[Exit-Code ${item.exit_code}]` : ""}`.trim(), isError: item.status === "failed" || (item.exit_code ?? 0) !== 0 };
    case "file_change":
      return { content: item.changes.map((change) => `${change.kind} ${change.path}`).join("\n"), isError: item.status === "failed" };
    case "mcp_tool_call":
      return {
        content: item.error?.message ?? (item.result?.content ?? []).map((block) => (block.type === "text" ? block.text : "[nicht-Text-Inhalt]")).join("\n"),
        isError: item.status === "failed" || Boolean(item.error),
      };
    default:
      return { content: "", isError: false };
  }
};

/** Tool call as the UI knows it (Claude-style names, so grouping and summaries work). */
function toolUseFor(item: ThreadItem): Extract<ChatItemPayload, { kind: "tool_use" }> | null {
  switch (item.type) {
    case "command_execution":
      return { kind: "tool_use", toolUseId: item.id, toolName: "Bash", input: { command: item.command } };
    case "file_change":
      return { kind: "tool_use", toolUseId: item.id, toolName: "Edit", input: { file_path: item.changes[0]?.path ?? "", changes: item.changes } };
    case "mcp_tool_call":
      return { kind: "tool_use", toolUseId: item.id, toolName: `mcp__${item.server}__${item.tool}`, input: item.arguments };
    case "web_search":
      return { kind: "tool_use", toolUseId: item.id, toolName: "WebSearch", input: { query: item.query } };
    default:
      return null;
  }
}

export const codexBackend: AgentBackend = {
  id: "codex",
  name: "Codex",
  capabilities: { interactivePermissions: false, questions: false, contextBreakdown: false, forkAtMessage: false, extensions: false },

  async status(forceRefresh = false) {
    const codexStatus = await codexAuth.status(forceRefresh);
    return { id: "codex", name: "Codex", ready: codexStatus.ready, runtime: codexStatus.runtime, capabilities: codexBackend.capabilities };
  },

  assertReady: () => codexAuth.assertReady(),
  defaultModel: () => codexSettings.defaultModel(),

  async *runTurn(input) {
    const startedAt = Date.now();
    const projectEnvironment = environmentStore.forProject(input.project.id);
    const harnoldServers = harnoldMcp.register(input.project, input.sessionId, input.permissionMode);
    const codex = new Codex({
      codexPathOverride: await codexExecutable(),
      env: toStringEnvironment(input.env),
      config: ({
        developer_instructions: input.systemPromptAppend,
        mcp_servers: {
          ...userMcpServers(input),
          ...Object.fromEntries(Object.entries(harnoldServers.servers).map(([serverName, url]) => [serverName, { url }])),
        },
      } as unknown) as NonNullable<ConstructorParameters<typeof Codex>[0]>["config"],
    });
    const threadOptions: ThreadOptions = {
      ...(input.model && input.model !== codexDefaultModel ? { model: input.model } : {}),
      sandboxMode: sandboxFor[input.permissionMode],
      approvalPolicy: "never",
      workingDirectory: input.project.path,
      skipGitRepoCheck: true,
      networkAccessEnabled: input.permissionMode === "bypassPermissions",
      additionalDirectories: [designSystemsDirectory, memoryConfig.workspaceDirectory(), ...(projectEnvironment ? [environmentMemoryDirectory(projectEnvironment.id)] : []), ...input.session.directories],
    };
    const thread = input.resumeSessionId ? codex.resumeThread(input.resumeSessionId, threadOptions) : codex.startThread(threadOptions);

    let finalText = "";
    let success = false;
    let errorText: string | undefined;
    let contextTokens: number | undefined;
    const startedTools = new Set<string>();

    try {
      const { events } = await thread.runStreamed(promptFor(input), { signal: input.signal });
      for await (const event of events as AsyncIterable<ThreadEvent>) {
        switch (event.type) {
          case "thread.started":
            yield { type: "session_started", agentSessionId: event.thread_id };
            break;
          case "item.started":
          case "item.updated":
          case "item.completed": {
            const { item } = event;
            const toolUse = toolUseFor(item);
            if (toolUse) {
              if (!startedTools.has(item.id)) {
                startedTools.add(item.id);
                yield { type: "item", payload: toolUse };
              }
              const finished = event.type === "item.completed" || (item.type === "command_execution" && item.status !== "in_progress");
              if (finished) yield { type: "item", payload: { kind: "tool_result", toolUseId: item.id, ...toolResultText(item) } };
            } else if (event.type === "item.completed") {
              if (item.type === "agent_message" && item.text.trim()) {
                finalText = item.text;
                yield { type: "item", payload: { kind: "assistant_text", text: item.text } };
              } else if (item.type === "reasoning" && item.text.trim()) {
                yield { type: "item", payload: { kind: "thinking", text: item.text } };
              } else if (item.type === "error" && !/^(Falling back|Reconnecting)/.test(item.message)) {
                yield { type: "item", payload: { kind: "notice", text: item.message } };
              }
            }
            break;
          }
          case "turn.completed":
            success = true;
            contextTokens = event.usage.input_tokens;
            yield { type: "context_size", tokens: contextTokens };
            break;
          case "turn.failed":
            errorText = event.error.message;
            break;
          case "error":
            // "Reconnecting … n/5" is transient; only the last error counts, and only when the turn failed.
            errorText = event.message;
            break;
          default:
            break;
        }
      }
    } finally {
      harnoldServers.release();
    }
    if (success) errorText = undefined;

    yield {
      type: "item",
      payload: { kind: "turn_result", success, costUsd: 0, durationMs: Date.now() - startedAt, errorText, contextTokens },
    } satisfies TurnEvent;
    yield { type: "outcome", success, finalText, errorText };
  },
};

