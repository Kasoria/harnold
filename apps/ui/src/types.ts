export type Project = { id: string; name: string; path: string; createdAt: number };
export type Session = { id: string; projectId: string; title: string; updatedAt: number; running?: boolean };
export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan";

export type ChatItem = { id: string; sessionId: string; createdAt: number } & (
  | { kind: "user_text"; text: string }
  | { kind: "assistant_text"; text: string }
  | { kind: "tool_use"; toolUseId: string; toolName: string; input: unknown }
  | { kind: "tool_result"; toolUseId: string; content: string; isError: boolean }
  | { kind: "turn_result"; success: boolean; costUsd: number; durationMs: number; errorText?: string }
);

export type FileNode = { name: string; path: string; type: "file" | "directory"; children?: FileNode[] };

export type PermissionRequest = { requestId: string; sessionId: string; toolName: string; input: unknown };

export type ServerEvent =
  | { type: "chat_item"; sessionId: string; chatItem: ChatItem }
  | { type: "text_delta"; sessionId: string; text: string }
  | { type: "turn_state"; sessionId: string; running: boolean }
  | ({ type: "permission_request" } & PermissionRequest)
  | { type: "permission_resolved"; sessionId: string; requestId: string }
  | { type: "files_changed"; projectId: string; paths: string[] }
  | { type: "sessions_changed"; projectId: string }
  | { type: "tasks_changed" }
  | { type: "task_run_finished"; taskId: string; taskName: string; sessionId: string; projectId: string; success: boolean }
  | { type: "channels_changed" }
  | { type: "memory_changed"; projectId: string | null }
  | { type: "integrations_changed" };

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
  notifyChannelId: string | null;
  notifyChatId: string | null;
};

export type Task = TaskInput & { id: string; createdAt: number; nextRunAt: number | null; lastRun: TaskRun | null };

export type ChannelType = "telegram" | "discord" | "slack" | "email";

export type ChannelInput = {
  type: ChannelType;
  name: string;
  projectId: string;
  enabled: boolean;
  permissionMode: PermissionMode;
  allowedSenders: string[];
  voiceReplies: "off" | "voice" | "always";
  settings: Record<string, string>;
  secrets: Record<string, string>;
};

export type Channel = Omit<ChannelInput, "secrets"> & {
  id: string;
  createdAt: number;
  secretsSet: Record<string, boolean>;
  status: { state: "connected" | "connecting" | "error" | "stopped"; error?: string };
};

export type SttProvider = "none" | "openai" | "elevenlabs" | "deepgram" | "whisper-cpp";
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

export type MemoryScope = "workspace" | "project";
export type MemoryNoteRef = { scope: MemoryScope; projectId: string | null; path: string };
export type MemoryNoteSummary = MemoryNoteRef & { title: string; modifiedAt: number };
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
