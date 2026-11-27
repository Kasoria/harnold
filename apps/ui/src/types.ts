/** kind "quick" = built-in home of chats without a project. */
export type Project = { id: string; name: string; path: string; icon: string | null; kind: "project" | "quick"; createdAt: number };
export type Session = {
  id: string;
  projectId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  running?: boolean;
  /** Set on a version created by editing a message: the session/message it is an alternative to. */
  forkOriginSessionId: string | null;
  forkOriginItemId: string | null;
  /** The edited user message in this version. */
  forkItemId: string | null;
  /** Team member this conversation is with; null = default Harnold agent. */
  agentId: string | null;
  /** Agent program this conversation runs on (null until its first turn). */
  backendId?: AgentBackendId | null;
  /** Created by this task; shown as one row per task, not per run. */
  taskId: string | null;
  /** Created by a mailbox (integration); hidden from the normal conversation list. */
  mailInboxId: string | null;
  /** Extra local folders the agent may use in this chat (absolute paths). */
  directories?: string[];
  /** Model picked in the composer for this conversation (null/absent = inherited). */
  model?: string | null;
  /** Own Git worktree of this chat; null = works in the folders directly. */
  worktree?: SessionWorktree | null;
};
export type SessionWorktree = { repositoryPath: string; path: string; branch: string; baseBranch: string | null };
export type WorktreeStatus = SessionWorktree & { exists: boolean; uncommittedChanges: boolean; commitsAhead: number; repositoryBranch: string | null };
export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan";

export type ChatItem = { id: string; sessionId: string; createdAt: number } & (
  | { kind: "user_text"; text: string; attachments?: Attachment[] }
  | { kind: "assistant_text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "notice"; text: string }
  | { kind: "tool_use"; toolUseId: string; toolName: string; input: unknown }
  | { kind: "tool_result"; toolUseId: string; content: string; isError: boolean; images?: { mediaType: string; data: string }[]; html?: string[] }
  | { kind: "turn_result"; success: boolean; costUsd: number; durationMs: number; errorText?: string; contextTokens?: number; contextWindow?: number }
);

/** Work that outlives a turn: Bash in the background, background subagents. */
export type BackgroundTask = { id: string; description: string; taskType: string };
/** A listening server (npm run dev …) the user can open in Workspace → App. */
export type DevServer = { port: number; targetHost: string; processName?: string; workingDirectory?: string; container?: string; likelyApp?: boolean };
export type TerminalInfo = { id: string; projectId: string; title: string; workingDirectory: string; createdAt: number; exited: boolean };
export type ProjectRootKind = "project" | "project-folder" | "environment-folder" | "workspace-folder" | "worktree";
/** A folder the project consists of: its own, an attached one, or a chat's worktree. */
export type ProjectRoot = { path: string; label: string; kind: ProjectRootKind; repositoryPath: string | null; sessionId?: string; branch?: string };
export type DirectoryEntry = { name: string; path: string; type: "file" | "directory"; heavy?: boolean };
export type GitBranches = { current: string | null; local: string[]; remote: string[] };
export type GitFileChange = { path: string; originalPath?: string; staged: string; unstaged: string };
export type GitStatus =
  | { isRepository: false; gitAvailable: boolean }
  | { isRepository: true; branch: string | null; upstream: string | null; ahead: number; behind: number; files: GitFileChange[]; operationInProgress: string | null };
export type GitCommit = { hash: string; subject: string; author: string; date: number };
export type PreviewOpening =
  | { mode: "direct"; url: string }
  | { mode: "proxy"; url?: string; path: string; publicPort: number }
  | { mode: "unavailable"; reason: string };

/** Sent while a turn ran; starts once it is done. */
export type QueuedMessage = { id: string; createdAt: string; text: string; permissionMode: PermissionMode; model?: string; attachments?: Attachment[] };

/** What fills the context window, by category (like /context). */
export type ContextBreakdown = {
  model: string;
  totalTokens: number;
  maxTokens: number;
  percentage: number;
  categories: { id?: string; name: string; tokens: number; kind: "used" | "free" | "buffer" | "deferred" }[];
};

/** A file attached to a chat message; stored in the project under attachments/. */
export type Attachment = { path: string; name: string; mimeType: string; size: number };

export type FileNode = { name: string; path: string; type: "file" | "directory"; children?: FileNode[] };

export type PermissionRequest = { requestId: string; sessionId: string; toolName: string; input: unknown; alwaysAllowLabel?: string };
/** Answer to a permission card (see core agent.ts PermissionAnswer). */
export type PermissionAnswer = { allow: boolean; answers?: Record<string, string>; always?: boolean; permissionMode?: PermissionMode; message?: string };

export type ServerEvent =
  | { type: "chat_item"; sessionId: string; chatItem: ChatItem }
  | { type: "text_delta"; sessionId: string; text: string }
  | { type: "thinking_delta"; sessionId: string; text: string }
  | { type: "session_cleared"; sessionId: string }
  | { type: "session_moved"; sessionId: string; fromProjectId: string; toProjectId: string }
  | { type: "turn_state"; sessionId: string; running: boolean }
  | { type: "queue_changed"; sessionId: string; queue: QueuedMessage[] }
  | { type: "context_size"; sessionId: string; tokens: number }
  | ({ type: "permission_request" } & PermissionRequest)
  | { type: "permission_resolved"; sessionId: string; requestId: string }
  | { type: "permission_mode_changed"; sessionId: string; permissionMode: PermissionMode }
  | { type: "agent_status"; sessionId: string; text: string | null }
  | { type: "background_tasks"; sessionId: string; tasks: BackgroundTask[] }
  | { type: "files_changed"; projectId: string; paths: string[] }
  | { type: "sessions_changed"; projectId: string }
  | { type: "tasks_changed" }
  | { type: "folders_changed" }
  /** Task results changed (e.g. removed) – reload the today overview. */
  | { type: "today_changed" }
  | { type: "task_run_finished"; taskId: string; taskName: string; sessionId: string; projectId: string; success: boolean }
  | { type: "channels_changed" }
  | { type: "mail_changed" }
  | { type: "memory_changed"; projectId: string | null }
  | { type: "integrations_changed" }
  | { type: "design_systems_changed" }
  | { type: "claude_auth_changed" }
  | { type: "environments_changed" }
  | { type: "team_changed" }
  | { type: "projects_changed" }
  | { type: "settings_changed" };

export type CanvasElementType = "frame" | "artifact" | "note" | "text" | "rect" | "drawing";

export type CanvasElement = {
  id: string;
  type: CanvasElementType;
  x: number;
  y: number;
  width: number;
  height: number;
  frameId?: string | null;
  title?: string;
  path?: string;
  text?: string;
  points?: [number, number][];
  viewportWidth?: number;
  viewportHeight?: number;
};

export type CanvasDocument = { version: 1; elements: CanvasElement[] };

/** Folder Harnold may work in, on one memory level (project, environment, workspace). */
export type ContextFolder = {
  scope: MemoryScope;
  /** Project id, environment id, or "" for the workspace. */
  ownerId: string;
  path: string;
  label: string;
  exists: boolean;
  createdAt: number;
};

export type ContextFolders = { project: ContextFolder[]; environment: ContextFolder[]; workspace: ContextFolder[] };

export type TaskRun = {
  id: string;
  taskId: string;
  sessionId: string | null;
  startedAt: number;
  finishedAt: number | null;
  status: "running" | "success" | "error";
  summary: string | null;
};

export type TaskInput = {
  projectId: string;
  name: string;
  prompt: string;
  schedule: string;
  enabled: boolean;
  permissionMode: PermissionMode;
  model: string | null;
  /** Agent program of the runs; null = the project's environment, else the workspace default. */
  backendId: AgentBackendId | null;
  /** Team member that runs the task (null = default agent). */
  agentId: string | null;
  /** "new": own session per run; "continue": all runs in one session. */
  sessionMode: "new" | "continue";
  /** "new" mode, opt-in: delete run sessions older than this many days. */
  cleanupAfterDays: number | null;
  /** "continue" mode, opt-in: fresh agent context after this many runs (history stays). */
  contextResetRuns: number | null;
  /** Folders the runs may work in, besides the project folder and the project's folder context. */
  directories: string[];
  notifyChannelId: string | null;
  notifyChatId: string | null;
};

export type Task = TaskInput & { id: string; createdAt: number; nextRunAt: number | null; lastRun: TaskRun | null };

export type ChannelType = "telegram" | "discord" | "slack" | "email";

export type ChannelInput = {
  type: ChannelType;
  name: string;
  /** "workspace": whole Harnold, starts in Quick Chats, switch via /projekt. "project": fixed projectId. */
  scope: "project" | "workspace";
  projectId: string;
  enabled: boolean;
  permissionMode: PermissionMode;
  allowedSenders: string[];
  voiceReplies: "off" | "voice" | "always";
  /** Agent program of the channel's conversations; null = workspace/environment default. */
  backendId: AgentBackendId | null;
  /** Model its conversations start with; null = the backend's default. */
  model: string | null;
  settings: Record<string, string>;
  secrets: Record<string, string>;
};

export type Channel = Omit<ChannelInput, "secrets"> & {
  id: string;
  createdAt: number;
  secretsSet: Record<string, boolean>;
  status: { state: "connected" | "connecting" | "error" | "stopped"; error?: string };
};

export type MailAutonomy = "readonly" | "drafts" | "approve" | "auto";
export type MailScope = "project" | "global";

export type MailInboxInput = {
  name: string;
  scope: MailScope;
  projectId: string;
  agentId: string | null;
  autonomy: MailAutonomy;
  enabled: boolean;
  /** Own agent program for this mailbox; null = the workspace/environment default. */
  backendId: AgentBackendId | null;
  /** Its own model; null = the backend's default. */
  model: string | null;
  /** The brief: what to do with incoming mail, what to leave alone. */
  instructions: string;
  /** Appended to every draft and answer. */
  signature: string;
  /** Address, tone, language. */
  tone: string;
  /** Background about the user, the business, recurring correspondents. */
  context: string;
  /** Sender patterns (comma separated, * allowed); empty = every sender. */
  includeSenders: string;
  /** Sender patterns to leave untouched. */
  excludeSenders: string;
  /** Folders to watch (comma separated); empty = INBOX. */
  folders: string;
  settings: Record<string, string>;
  secrets: Record<string, string>;
};

export type MailboxStatus = { state: "connected" | "connecting" | "error" | "stopped"; error?: string };

export type MailInbox = Omit<MailInboxInput, "secrets"> & {
  id: string;
  createdAt: number;
  secretsSet: Record<string, boolean>;
  agentName: string | null;
  status: MailboxStatus;
};

export type MailMessage = {
  id: string;
  inboxId: string;
  uid: string;
  folder: string;
  subject: string;
  fromAddress: string;
  fromName: string;
  snippet: string;
  status: "new" | "processed" | "ignored";
  action: string;
  sessionId: string | null;
  /** Project of the session the agent used for this mail (for opening it). */
  projectId: string | null;
  createdAt: number;
};

export type MailAction = {
  id: string;
  inboxId: string;
  messageId: string | null;
  kind: "summary" | "digest" | "draft" | "moved" | "flagged" | "sent";
  description: string;
  status: "done" | "pending" | "sent" | "rejected";
  payload: Record<string, unknown>;
  createdAt: number;
};

export type MailActivity = { messages: MailMessage[]; actions: MailAction[]; pending: MailAction[] };

export type SttProvider = "none" | "system" | "openai" | "elevenlabs" | "deepgram" | "whisper-cpp";
export type TtsProvider = "none" | "openai" | "elevenlabs" | "piper";
export type VoiceSecretKey = "openaiApiKey" | "elevenlabsApiKey" | "deepgramApiKey";

export type VoiceSettings = {
  sttProvider: SttProvider;
  ttsProvider: TtsProvider;
  language: string;
  options: Record<string, string>;
};

export type VoiceSettingsView = VoiceSettings & {
  secretsSet: Record<VoiceSecretKey, boolean>;
  sttReady: boolean;
  ttsReady: boolean;
};

export type ManagedFileKind = "attachment" | "generated" | "memory";
/** A file Harnold created (attachment, generated image, memory file) – see packages/core/src/managed-files.ts. */
export type ManagedFile = {
  id: string;
  kind: ManagedFileKind;
  scope: "project" | "environment" | "workspace";
  ownerId: string;
  ownerName: string;
  projectId: string | null;
  path: string;
  name: string;
  size: number;
  mimeType: string;
  modifiedAt: number;
  sessions: { id: string; title: string }[];
  usedIn: string[];
  orphaned: boolean;
  duplicateGroup: string | null;
};
export type MemoryScope = "workspace" | "environment" | "project";
export type MemoryNoteRef = { scope: MemoryScope; projectId: string | null; path: string };
export type MemoryNoteSummary = MemoryNoteRef & { title: string; modifiedAt: number };
export type MemoryFile = MemoryNoteRef & { name: string; size: number; mimeType: string; modifiedAt: number };
export type MemorySearchHit = MemoryNoteSummary & { snippet: string; score: number };
export type EmbeddingProvider = "off" | "openai" | "ollama";
export type MemorySettings = { workspaceDirectory: string; embeddingProvider: EmbeddingProvider; embeddingModel: string; ollamaUrl: string };
export type MemorySettingsView = MemorySettings & { resolvedWorkspaceDirectory: string; openaiKeySet: boolean };

export type McpTransport = "stdio" | "http" | "sse";
export type McpServerInput = {
  name: string;
  scope: "workspace" | "project";
  projectId: string | null;
  transport: McpTransport;
  command: string;
  args: string[];
  url: string;
  /** Empty value = keep stored secret. */
  env: Record<string, string>;
  headers: Record<string, string>;
  autoAllow: boolean;
  enabled: boolean;
};
export type McpServerTestResult = { ok: boolean; testedAt: number; tools: { name: string; description: string }[]; error?: string };
export type McpServer = Omit<McpServerInput, "env" | "headers"> & {
  id: string;
  createdAt: number;
  envKeys: string[];
  headerKeys: string[];
  lastTest: McpServerTestResult | null;
};
export type SkillScope = "user" | "project";
export type Skill = { name: string; description: string; scope: SkillScope; path: string; enabled: boolean };
export type PluginSource = "claude-code" | "claude-desktop" | "folder";
export type PluginInfo = { id: string; name: string; description: string; version: string | null; source: PluginSource; path: string; enabled: boolean };
export type QuickChatSettings = { autoDeleteDays: number | null };

export type TokenType = "color" | "dimension" | "fontFamily" | "fontWeight" | "number" | "shadow" | "duration" | "other";
export type FlatToken = { path: string; cssVariable: string; value: string; resolvedValue: string; type: TokenType };
export type TokenTree = Record<string, unknown>;
export type DesignSystemView = {
  exists: boolean;
  tokens: TokenTree;
  flatTokens: FlatToken[];
  modeTokens: Record<string, FlatToken[]>;
  components: { name: string; path: string }[];
  error?: string;
};
export type DesignSystemLinkTarget = { targetType: "project" | "session"; targetId: string };
export type DesignSystemSummary = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  tokenCount: number;
  swatches: string[];
  links: DesignSystemLinkTarget[];
};
export type DesignSystemDetail = DesignSystemView & { id: string; name: string; directory: string; links: DesignSystemLinkTarget[] };

export type AgentBackendId = "claude-code" | "codex" | "native";

export type AgentRuntimeStatus = {
  id: AgentBackendId;
  name: string;
  found: boolean;
  source?: "configured" | "bundled" | "downloaded" | "installed";
  executablePath?: string;
  version?: string;
  recommendedVersion: string;
  outdated: boolean;
  tooOldPath?: string;
  installHint: string;
  installUrl: string;
  updateHint: string;
  /** Harnold can fetch the program itself. */
  downloadable: boolean;
  download: { running: boolean; receivedBytes: number; totalBytes: number; error?: string };
};

/** What the UI may offer for an agent program; features it lacks are hidden. */
export type BackendCapabilities = { interactivePermissions: boolean; questions: boolean; contextBreakdown: boolean; forkAtMessage: boolean; extensions: boolean; steering?: boolean; effort?: boolean; rewindFiles?: boolean };
export type RewindResult = { canRewind: boolean; error?: string; filesChanged?: string[]; insertions?: number; deletions?: number };
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
/** runtime null = nothing to install (Harnold-Agent). */
export type BackendStatus = { id: AgentBackendId; name: string; ready: boolean; runtime: AgentRuntimeStatus | null; capabilities: BackendCapabilities };
export type AgentBackendsView = { activeId: AgentBackendId; backends: BackendStatus[] };

/** Workspace defaults per role: what runs conversations and what runs unattended work (tasks, mailbox). */
export type AgentRole = "chat" | "automation";
export type AgentRoleDefaults = { backendId: AgentBackendId | null; model: string | null };
export type AgentRoleSettings = Record<AgentRole, AgentRoleDefaults>;
export type CodexAuthMode = "login" | "apiKey";
export type CodexStatus = {
  mode: CodexAuthMode;
  apiKeySet: boolean;
  environmentApiKey: boolean;
  loginText: string | null;
  loggedIn: boolean;
  loginPending: boolean;
  ready: boolean;
  runtime: AgentRuntimeStatus;
  /** Extra model ids the user added (besides Codex's own default). */
  models: string[];
};

export type ClaudeAuthMode = "subscription" | "apiKey";
/** "anthropic" = Messages API (also usable by Claude Code), "openai" = chat completions. */
export type ProviderProtocol = "anthropic" | "openai";
export type ProviderPreset = { id: string; name: string; protocol: ProviderProtocol; baseUrl: string; models: string[]; needsKey: boolean; keyPlaceholder: string; hint?: string };
export type CustomProvider = { id: string; name: string; protocol: ProviderProtocol; baseUrl: string; models: string[]; needsKey: boolean; apiKeySet: boolean; ready: boolean };
export type ProviderInput = { name: string; protocol: ProviderProtocol; baseUrl: string; models: string[]; needsKey: boolean; apiKey?: string };
/** activeId: "claude" or a custom provider's id. */
export type ProvidersView = { activeId: string; providers: CustomProvider[]; presets: ProviderPreset[] };

export type ClaudeAuthStatus = {
  /** "claude" or the id of the active custom provider. */
  providerId: string;
  mode: ClaudeAuthMode;
  apiKeySet: boolean;
  environmentApiKey: boolean;
  account: { loggedIn: boolean; authMethod?: string; email?: string; orgName?: string; subscriptionType?: string; apiProvider?: string } | null;
  cliError?: string;
  loginPending: boolean;
  ready: boolean;
  runtime: AgentRuntimeStatus;
};

export type ImageProvider = "none" | "gemini" | "openai";
export type ImageAspectRatio = "1:1" | "16:9" | "9:16" | "4:3" | "3:4";
export type ImageSettings = { provider: ImageProvider; geminiModel: string; openaiModel: string };
export type ImageSettingsView = ImageSettings & {
  secretsSet: { geminiApiKey: boolean; openaiApiKey: boolean };
  ready: boolean;
  defaultModels: { gemini: string; openai: string };
};
export type ImageRequest = {
  prompt: string;
  referencePaths: string[];
  aspectRatio: ImageAspectRatio;
  count: number;
  anchor: { x: number; y: number } | null;
};

/** "inherit" = Einstellungen → Claude. */
export type EnvironmentClaudeMode = "inherit" | "subscription" | "apiKey" | `provider:${string}` | `backend:${string}`;
export type EnvironmentVariable = { key: string; value: string; secret: boolean };
export type Environment = {
  id: string;
  name: string;
  /** Emoji or "lucide:<name>"; null = letter. */
  icon: string | null;
  gitName: string;
  gitEmail: string;
  sshKeyPath: string;
  accounts: EnvironmentAccount[];
  claudeMode: EnvironmentClaudeMode;
  claudeApiKeySet: boolean;
  /** "" = Harnold default. */
  model: string;
  /** Secret values come back empty. */
  variables: EnvironmentVariable[];
  projectIds: string[];
  createdAt: number;
};
export type EnvironmentInput = {
  name: string;
  gitName: string;
  gitEmail: string;
  sshKeyPath: string;
  /** undefined keeps the stored token, "" removes it. */
  /** Listed accounts replace the stored ones; an empty secret value keeps the stored one. */
  accounts: { provider: string; values: Record<string, string> }[];
  claudeMode: EnvironmentClaudeMode;
  claudeApiKey?: string;
  model: string;
  variables: EnvironmentVariable[];
  projectIds: string[];
};
export type AccountCheck = { ok: boolean; detail: string };
export type EnvironmentAccountChecks = Record<string, AccountCheck>;
/** Secret values come back ""; setKeys = fields that hold a value. */
export type EnvironmentAccount = { provider: string; label: string; values: Record<string, string>; setKeys: string[] };
export type EnvironmentProvider = { id: string; label: string; fields: { key: string; label: string; secret: boolean; placeholder?: string }[]; checkable: boolean };

export type SessionReference = { sessionId: string; sessionTitle: string; projectId: string; projectName: string };
export type TodayOverview = {
  waiting: (PermissionRequest & SessionReference)[];
  running: SessionReference[];
  taskResults: (TaskRun & { taskName: string; session: SessionReference | null })[];
  recentSessions: (SessionReference & { updatedAt: number })[];
};

export type AgentCommand = { name: string; description: string; argumentHint: string };

export type ExternalMcpServer = {
  sourceId: string;
  sourceLabel: string;
  name: string;
  transport: McpTransport;
  target: string;
  activeViaClaude: boolean;
  imported: boolean;
  importable: boolean;
};

export type TeamAgentInput = {
  environmentId: string | null;
  name: string;
  role: string;
  instructions: string;
  model: string | null;
  /** Agent program of this member; null = the workspace/environment default. */
  backendId: AgentBackendId | null;
  icon: string | null;
};
export type TeamAgent = TeamAgentInput & { id: string; createdAt: number };

/** What a move or export contains. */
export type TransferSelection = {
  scope: "workspace" | "agents";
  excludedFolders: string[];
  includeAgentConfiguration: boolean;
  includeAgentTranscripts: boolean;
};
export type TransferFolders = { folders: { path: string; name: string; sizeBytes: number }[]; agentConfigurationBytes: number; agentTranscriptBytes: number };
/** State of a move to a server or of an export (runs in the Core). */
export type TransferJob = {
  kind: "push" | "export";
  phase: "idle" | "packing" | "uploading" | "unpacking" | "restarting" | "done" | "failed" | "cancelled";
  sentBytes: number;
  totalBytes: number;
  remainingSeconds: number | null;
  reconnecting: boolean;
  error: string | null;
  warning: string | null;
  filePath: string | null;
};

/** Subscription usage of one provider (5-hour session, week, …). */
export type LimitWindow = { id: string; label: string; usedPercent: number; resetsAt: number | null };
export type ProviderLimits = { id: string; label: string; plan?: string; windows: LimitWindow[]; error?: string };
export type LimitsView = { providers: ProviderLimits[]; fetchedAt: number };
