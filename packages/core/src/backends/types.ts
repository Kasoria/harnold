import type { Attachment, ChatItemPayload, PendingFork, Project, Session } from "../db.ts";
import type { AgentRuntimeStatus } from "../agent-runtimes.ts";
import type { AgentBackendId } from "../agent-backend-settings.ts";

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";
/** How hard the model thinks (Claude Code's /effort); empty = the model's default. */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
/** updatedPermissions: rules/mode changes the agent program applies (Claude Code's PermissionUpdate). */
export type PermissionDecision = { behavior: "allow"; updatedInput?: Record<string, unknown>; updatedPermissions?: PermissionSuggestion[] } | { behavior: "deny"; message: string };
/** A rule the agent program proposes for "always allow" (Claude Code: PermissionUpdate). */
export type PermissionSuggestion = { type: string; destination?: string; [field: string]: unknown };

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
  /** Effort level can be chosen per message. */
  effort?: boolean;
  /** Files can be restored to their state before a user message. */
  rewindFiles?: boolean;
  /** Messages sent during a turn reach the running turn (else they wait in the queue). */
  steering?: boolean;
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
  effort?: EffortLevel;
  /** Process env including credentials and the environment's variables. */
  env: NodeJS.ProcessEnv;
  /** Harnold's instructions (memory, design system, team, environment …) for the system prompt. */
  systemPromptAppend: string;
};

export type TurnInput = TurnContext & {
  promptText: string;
  attachments: Attachment[];
  /** Id of the stored user message – checkpoint for rewinding files. */
  userMessageId: string;
  /** Conversation to continue (null = fresh). */
  resumeSessionId: string | null;
  pendingFork: PendingFork | null;
  signal: AbortSignal;
  /** Keep the agent process alive after the turn (conversations); background runs end it once idle. */
  keepAlive: boolean;
  requestPermission: (toolName: string, input: unknown, signal: AbortSignal, suggestions?: PermissionSuggestion[]) => Promise<PermissionDecision>;
};

export type BackgroundTask = { id: string; description: string; taskType: string };

/** A message sent while a turn runs (see AgentBackend.steer). */
export type SteerInput = { project: Project; promptText: string; attachments: Attachment[]; userMessageId: string };

/** Restoring files to their state before a user message (Claude Code checkpoints). */
export type RewindResult = { canRewind: boolean; error?: string; filesChanged?: string[]; insertions?: number; deletions?: number };

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
  /** Short live status (retry, compacting, subagent progress); null clears it. Not stored. */
  | { type: "status"; text: string | null }
  /** Full set of the conversation's running background tasks (replaces the previous set). */
  | { type: "background_tasks"; tasks: BackgroundTask[] }
  /** Last event: how the turn ended. */
  | { type: "outcome"; success: boolean; finalText: string; errorText?: string };

/** Something happened in a conversation outside a turn (background task finished, task list changed). */
export type SessionEventHandler = (sessionId: string, turnEvent: TurnEvent) => void;

/**
 * The agent started a turn on its own (e.g. a background task finished and it reacts). The runtime stores the
 * events like a normal turn; stop interrupts that turn.
 */
export type BackgroundTurnHandler = (sessionId: string, turnEvents: AsyncGenerator<TurnEvent>, stop: () => void) => void;

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
  /** Backends with a long-running process per conversation report turns they start themselves. */
  onBackgroundTurn?(handler: BackgroundTurnHandler): void;
  onSessionEvent?(handler: SessionEventHandler): void;
  /** Stops one background task (Bash in the background, background subagent). */
  stopBackgroundTask?(sessionId: string, taskId: string): Promise<void>;
  /** Hands a message to the running turn (the agent reads it after its current step); false = not possible, queue it. */
  steer?(sessionId: string, steerInput: SteerInput): boolean;
  /** Title the agent program generated for the conversation (Claude Code names sessions itself). */
  generatedTitle?(context: TurnContext): Promise<string | undefined>;
  /** dryRun: only report what would change. */
  rewindFiles?(context: TurnContext, userMessageId: string, dryRun: boolean): Promise<RewindResult>;
  /** Ends the conversation's process (session deleted). */
  release?(sessionId: string): void;
}
