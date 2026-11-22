import type { Attachment, ChatItemPayload, PendingFork, Project, Session } from "../db.ts";
import type { AgentRuntimeStatus } from "../agent-runtimes.ts";
import type { AgentBackendId } from "../agent-backend-settings.ts";

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";
export type PermissionDecision = { behavior: "allow"; updatedInput?: Record<string, unknown> } | { behavior: "deny"; message: string };

/** What the UI may offer for a backend; features a backend lacks are hidden instead of failing. */
export type BackendCapabilities = {
  /** Each tool call can be approved one by one (otherwise the permission mode maps to a sandbox level). */
  interactivePermissions: boolean;
  /** The agent can ask the user questions mid-turn. */
  questions: boolean;
  /** /context breakdown of the window. */
  contextBreakdown: boolean;
  /** Editing an earlier message can branch the agent's own conversation (else Harnold replays a transcript). */
  forkAtMessage: boolean;
  /** Skills, plugins, slash commands of the agent program. */
  extensions: boolean;
};

export type BackendStatus = {
  id: AgentBackendId;
  name: string;
  /** Installed, signed in and usable right now. */
  ready: boolean;
  /** null = nothing to install (Harnold's own agent). */
  runtime: AgentRuntimeStatus | null;
  capabilities: BackendCapabilities;
};

/** Everything a backend needs for one turn; prepared by the orchestrator in agent.ts. */
export type TurnContext = {
  sessionId: string;
  session: Session;
  project: Project;
  teamAgentId: string | null;
  permissionMode: PermissionMode;
  /** Resolved model id; "" = the program's own default. */
  model: string;
  /** Process env including credentials and the environment's variables. */
  env: NodeJS.ProcessEnv;
  /** Harnold's instructions (memory, design system, team, environment …) for the system prompt. */
  systemPromptAppend: string;
};

export type TurnInput = TurnContext & {
  promptText: string;
  attachments: Attachment[];
  /** Conversation to continue (null = fresh). */
  resumeSessionId: string | null;
  pendingFork: PendingFork | null;
  signal: AbortSignal;
  requestPermission: (toolName: string, input: unknown, signal: AbortSignal) => Promise<PermissionDecision>;
};

export type ContextBreakdown = {
  model: string;
  totalTokens: number;
  maxTokens: number;
  percentage: number;
  categories: { id?: string; name: string; tokens: number; kind: "used" | "free" | "buffer" | "deferred" }[];
};

/** Provider-independent stream a backend produces; agent.ts stores and publishes it. */
export type TurnEvent =
  | { type: "session_started"; agentSessionId: string }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "context_size"; tokens: number }
  | { type: "item"; payload: ChatItemPayload }
  /** Last event: how the turn ended. */
  | { type: "outcome"; success: boolean; finalText: string; errorText?: string };

export interface AgentBackend {
  id: AgentBackendId;
  name: string;
  capabilities: BackendCapabilities;
  status(forceRefresh?: boolean): Promise<BackendStatus>;
  /** Throws a friendly error when this backend cannot run (missing program, not signed in). */
  assertReady(): Promise<void>;
  /** Model used when nothing else picks one. */
  defaultModel(): string;
  runTurn(input: TurnInput): AsyncGenerator<TurnEvent>;
  /** Only with capabilities.contextBreakdown. */
  measureContext?(context: TurnContext): Promise<ContextBreakdown>;
}
