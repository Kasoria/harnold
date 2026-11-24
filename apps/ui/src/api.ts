import { currentLanguage, t } from "@/lib/i18n";
import type { TeamAgent, TeamAgentInput, ExternalMcpServer, ManagedFile, Attachment, PluginInfo, QuickChatSettings, AgentCommand, TodayOverview, Environment, EnvironmentAccountChecks, EnvironmentProvider, EnvironmentInput, ImageRequest, ImageSettings, ImageSettingsView, AgentRuntimeStatus, AgentBackendId, AgentBackendsView, AgentRole, AgentRoleDefaults, AgentRoleSettings, CodexAuthMode, CodexStatus, ProviderInput, ProviderProtocol, ProvidersView, ClaudeAuthMode, ClaudeAuthStatus, DesignSystemDetail, DesignSystemLinkTarget, DesignSystemSummary, TokenTree, McpServer, McpServerInput, McpServerTestResult, Skill, SkillScope, MemoryFile, MemoryNoteRef, MemoryNoteSummary, MemoryScope, MemorySearchHit, MemorySettings, MemorySettingsView, VoiceSecretKey, VoiceSettings, VoiceSettingsView, CanvasDocument, Channel, ChannelInput, MailActivity, MailInbox, MailInboxInput, Task, TaskInput, TaskRun, ContextFolder, ContextFolders, ChatItem, ContextBreakdown, QueuedMessage, FileNode, PermissionMode, Project, ServerEvent, Session } from "./types.ts";

/** Core address: same origin by default (dev proxy / server mode), overridable for remote workspaces. */
export const coreBaseUrl = localStorageSafeGet("harnold.coreUrl") ?? "";
export const accessToken = localStorageSafeGet("harnold.token") ?? "";

function localStorageSafeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

async function request<ResponseBody>(method: string, path: string, body?: unknown): Promise<ResponseBody> {
  let response: Response;
  try {
    response = await fetch(coreBaseUrl + path, {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        "x-harnold-language": currentLanguage,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (networkError) {
    // The browser only says "Load failed" / "Failed to fetch"; name the server instead.
    throw new Error(coreBaseUrl ? t("Keine Verbindung zu {0}", coreBaseUrl) : String(networkError instanceof Error ? networkError.message : networkError));
  }
  const responseBody = await response.json();
  if (!response.ok) throw new Error(responseBody.error ?? response.statusText);
  return responseBody as ResponseBody;
}

const memoryNoteQuery = (noteRef: MemoryNoteRef) =>
  new URLSearchParams({ scope: noteRef.scope, projectId: noteRef.projectId ?? "", path: noteRef.path }).toString();

export const api = {
  updateSession: (sessionId: string, changes: { title?: string; projectId?: string; directories?: string[]; model?: string | null }) => request<{ ok: true; deferred: boolean }>("PATCH", `/api/sessions/${sessionId}`, changes),
  clearSession: (sessionId: string) => request<{ ok: true }>("POST", `/api/sessions/${sessionId}/clear`),
  listAgentCommands: (projectId: string) => request<AgentCommand[]>("GET", `/api/projects/${projectId}/commands`),
  readToday: () => request<TodayOverview>("GET", "/api/today"),
  listProjects: () => request<Project[]>("GET", "/api/projects"),
  createProject: (name: string, path?: string, environmentId?: string | null) => request<Project>("POST", "/api/projects", { name, path, environmentId }),
  setProjectEnvironment: (projectId: string, environmentId: string | null) => request<{ ok: true }>("PUT", `/api/projects/${projectId}/environment`, { environmentId }),
  listEnvironments: () => request<Environment[]>("GET", "/api/environments"),
  createEnvironment: (input: EnvironmentInput) => request<Environment>("POST", "/api/environments", input),
  updateEnvironment: (environmentId: string, input: EnvironmentInput) => request<Environment>("PUT", `/api/environments/${environmentId}`, input),
  updateEnvironmentIcon: (environmentId: string, icon: string | null) => request<Environment>("PATCH", `/api/environments/${environmentId}`, { icon }),
  deleteEnvironment: (environmentId: string) => request<{ ok: true }>("DELETE", `/api/environments/${environmentId}`),
  listEnvironmentProviders: () => request<EnvironmentProvider[]>("GET", "/api/environment-providers"),
  importCurrentAccounts: (environmentId: string) =>
    request<{ environment: Environment; found: string[]; notFound: string[] }>("POST", `/api/environments/${environmentId}/import`),
  checkEnvironmentAccounts: (environmentId: string) => request<EnvironmentAccountChecks>("POST", `/api/environments/${environmentId}/check`),
  deleteProject: (projectId: string) => request<{ ok: true }>("DELETE", `/api/projects/${projectId}`),
  revealProject: (projectId: string) => request<{ ok: true }>("POST", `/api/projects/${projectId}/reveal`),
  updateProject: (projectId: string, changes: { name?: string; icon?: string | null }) => request<Project>("PATCH", `/api/projects/${projectId}`, changes),
  createQuickChat: () => request<Session>("POST", "/api/quick-chats"),
  readQuickChatSettings: () => request<QuickChatSettings>("GET", "/api/settings/quick-chats"),
  saveQuickChatSettings: (settings: QuickChatSettings) => request<QuickChatSettings>("PUT", "/api/settings/quick-chats", settings),
  /** Sends an edited version of a message; returns the new version (session). */
  editMessage: (sessionId: string, itemId: string, text: string, permissionMode: PermissionMode, model?: string) =>
    request<Session>("POST", `/api/sessions/${sessionId}/edit`, { itemId, text, permissionMode, model: model || undefined }),
  listPlugins: () => request<PluginInfo[]>("GET", "/api/plugins"),
  setPluginEnabled: (pluginId: string, enabled: boolean) => request<{ ok: true }>("PUT", "/api/plugins/enabled", { pluginId, enabled }),
  addPluginFolder: (folderPath: string) => request<PluginInfo>("POST", "/api/plugins/folders", { path: folderPath }),
  removePluginFolder: (pluginId: string) => request<{ ok: true }>("POST", "/api/plugins/folders/remove", { pluginId }),
  listSessions: (projectId: string) => request<Session[]>("GET", `/api/projects/${projectId}/sessions`),
  createSession: (projectId: string, agentId?: string | null) => request<Session>("POST", `/api/projects/${projectId}/sessions`, { agentId: agentId ?? null }),
  setSessionAgent: (sessionId: string, agentId: string | null) => request<{ ok: true }>("PATCH", `/api/sessions/${sessionId}`, { agentId }),
  listTeam: () => request<TeamAgent[]>("GET", "/api/team"),
  createTeamAgent: (agentInput: TeamAgentInput) => request<TeamAgent>("POST", "/api/team", agentInput),
  updateTeamAgent: (agentId: string, agentInput: TeamAgentInput) => request<TeamAgent>("PUT", `/api/team/${agentId}`, agentInput),
  deleteTeamAgent: (agentId: string) => request<{ ok: true }>("DELETE", `/api/team/${agentId}`),
  deleteSession: (sessionId: string, deleteFiles = false) => request("DELETE", `/api/sessions/${sessionId}${deleteFiles ? "?deleteFiles=1" : ""}`),
  listChatItems: (sessionId: string) => request<ChatItem[]>("GET", `/api/sessions/${sessionId}/items`),
  sendMessage: (sessionId: string, text: string, permissionMode: PermissionMode, model?: string, attachments?: Attachment[]) =>
    request("POST", `/api/sessions/${sessionId}/messages`, { text, permissionMode, model: model || undefined, attachments: attachments?.length ? attachments : undefined }),
  /** Uploads files for a chat message (multipart). */
  uploadAttachments: async (projectId: string, files: File[]): Promise<Attachment[]> => {
    const formData = new FormData();
    for (const file of files) formData.append("files", file, file.name);
    const response = await fetch(`${coreBaseUrl}/api/projects/${projectId}/attachments`, {
      method: "POST",
      headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
      body: formData,
    });
    const responseBody = await response.json();
    if (!response.ok) throw new Error(responseBody.error ?? response.statusText);
    return responseBody as Attachment[];
  },
  interrupt: (sessionId: string) => request("POST", `/api/sessions/${sessionId}/interrupt`),
  listQueue: (sessionId: string) => request<QueuedMessage[]>("GET", `/api/sessions/${sessionId}/queue`),
  removeQueued: (sessionId: string, queuedMessageId: string) => request("DELETE", `/api/sessions/${sessionId}/queue/${queuedMessageId}`),
  /** Stops the running turn and starts this queued message right away. */
  sendQueuedNow: (sessionId: string, queuedMessageId: string) => request("POST", `/api/sessions/${sessionId}/queue/${queuedMessageId}/send-now`),
  readContext: (sessionId: string, model?: string) => request<ContextBreakdown>("GET", `/api/sessions/${sessionId}/context${model ? `?model=${encodeURIComponent(model)}` : ""}`),
  /** Value ("" = skip) goes to the core only and ends up in the environment variables. */
  submitSecretInput: (requestId: string, value: string) => request("POST", `/api/secret-input/${requestId}`, { value }),
  answerPermission: (requestId: string, allow: boolean, answers?: Record<string, string>) => request("POST", `/api/permissions/${requestId}`, { allow, answers }),
  readTree: (projectId: string) => request<FileNode[]>("GET", `/api/projects/${projectId}/tree`),
  readFile: (projectId: string, filePath: string) =>
    request<{ content: string }>("GET", `/api/projects/${projectId}/file?path=${encodeURIComponent(filePath)}`),
  writeFile: (projectId: string, filePath: string, content: string) =>
    request("PUT", `/api/projects/${projectId}/file`, { path: filePath, content }),
  listTasks: () => request<Task[]>("GET", "/api/tasks"),
  createTask: (taskInput: TaskInput) => request<Task>("POST", "/api/tasks", taskInput),
  updateTask: (taskId: string, taskInput: TaskInput) => request<Task>("PUT", `/api/tasks/${taskId}`, taskInput),
  deleteTask: (taskId: string) => request("DELETE", `/api/tasks/${taskId}`),
  runTask: (taskId: string) => request("POST", `/api/tasks/${taskId}/run`),
  listTaskRuns: (taskId: string) => request<TaskRun[]>("GET", `/api/tasks/${taskId}/runs`),
  listFolders: (projectId: string | null) => request<ContextFolders>("GET", `/api/folders${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`),
  addFolder: (scope: MemoryScope, path: string, projectId: string | null) => request<ContextFolder>("POST", "/api/folders", { scope, path, projectId }),
  removeFolder: (scope: MemoryScope, path: string, projectId: string | null) =>
    request<{ ok: true }>("DELETE", `/api/folders?scope=${scope}&path=${encodeURIComponent(path)}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ""}`),
  /** Removes one task result (and its session). */
  deleteTaskRun: (runId: string) => request<{ ok: boolean }>("DELETE", `/api/task-runs/${runId}`),
  /** Removes all finished results of a task. */
  clearTaskRuns: (taskId: string) => request<{ removed: number }>("DELETE", `/api/tasks/${taskId}/runs`),
  listChannels: () => request<Channel[]>("GET", "/api/channels"),
  createChannel: (channelInput: ChannelInput) => request<Channel>("POST", "/api/channels", channelInput),
  updateChannel: (channelId: string, channelInput: ChannelInput) => request<Channel>("PUT", `/api/channels/${channelId}`, channelInput),
  deleteChannel: (channelId: string) => request("DELETE", `/api/channels/${channelId}`),
  listMail: () => request<MailInbox[]>("GET", "/api/mail"),
  createMail: (input: MailInboxInput) => request<MailInbox>("POST", "/api/mail", input),
  updateMail: (inboxId: string, input: MailInboxInput) => request<MailInbox>("PUT", `/api/mail/${inboxId}`, input),
  deleteMail: (inboxId: string) => request<{ ok: true }>("DELETE", `/api/mail/${inboxId}`),
  readMailActivity: (inboxId: string) => request<MailActivity>("GET", `/api/mail/${inboxId}/activity`),
  approveMailAction: (inboxId: string, actionId: string, allow: boolean) =>
    request<{ status: string }>("POST", `/api/mail/${inboxId}/actions/${actionId}/approve`, { allow }),
  pollMail: (inboxId: string) => request<{ ok: true }>("POST", `/api/mail/${inboxId}/poll`),
  readImageSettings: () => request<ImageSettingsView>("GET", "/api/settings/images"),
  saveImageSettings: (settings: ImageSettings, secrets: { geminiApiKey?: string; openaiApiKey?: string }) =>
    request<ImageSettingsView>("PUT", "/api/settings/images", { settings, secrets }),
  generateImages: (projectId: string, imageRequest: ImageRequest) =>
    request<{ paths: string[] }>("POST", `/api/projects/${projectId}/images`, imageRequest).then((responseBody) => responseBody.paths),
  listDesignSystems: () => request<DesignSystemSummary[]>("GET", "/api/design-systems"),
  readDesignSystem: (designSystemId: string) => request<DesignSystemDetail>("GET", `/api/design-systems/${designSystemId}`),
  createDesignSystem: (name: string, template: "starter" | "empty", links: DesignSystemLinkTarget[] = []) =>
    request<DesignSystemDetail>("POST", "/api/design-systems", { name, template, links }),
  renameDesignSystem: (designSystemId: string, name: string) => request<DesignSystemDetail>("PUT", `/api/design-systems/${designSystemId}`, { name }),
  deleteDesignSystem: (designSystemId: string) => request<{ ok: true }>("DELETE", `/api/design-systems/${designSystemId}`),
  saveDesignTokens: (designSystemId: string, tokens: TokenTree) =>
    request<DesignSystemDetail>("PUT", `/api/design-systems/${designSystemId}/tokens`, { tokens }),
  setDesignSystemLinks: (designSystemId: string, links: DesignSystemLinkTarget[]) =>
    request<DesignSystemDetail>("PUT", `/api/design-systems/${designSystemId}/links`, { links }),
  /** environmentId: the own Claude login of that environment instead of the workspace one. */
  /** Language of Core messages (errors, channel replies). */
  saveLanguage: (language: string) => request<{ ok: true }>("PUT", "/api/settings/language", { language }),
  readDefaultModel: (backendId?: AgentBackendId) => request<{ defaultModel: string }>("GET", `/api/settings/model${backendId ? `?backend=${backendId}` : ""}`),
  saveDefaultModel: (defaultModel: string, backendId?: AgentBackendId) =>
    request<{ defaultModel: string }>("PUT", `/api/settings/model${backendId ? `?backend=${backendId}` : ""}`, { defaultModel }),
  readAgentRoles: () => request<AgentRoleSettings>("GET", "/api/agent-roles"),
  saveAgentRoles: (roles: Partial<Record<AgentRole, AgentRoleDefaults>>) => request<AgentRoleSettings>("PUT", "/api/agent-roles", roles),
  readClaudeStatus: (refresh = false, environmentId?: string) =>
    request<ClaudeAuthStatus>("GET", `/api/claude/status?${new URLSearchParams({ ...(refresh ? { refresh: "1" } : {}), ...(environmentId ? { environmentId } : {}) })}`),
  downloadRuntime: (runtimeId: AgentRuntimeStatus["id"]) => request<{ ok: true }>("POST", `/api/runtimes/${runtimeId}/download`),
  readAgentBackends: (refresh = false) => request<AgentBackendsView>("GET", `/api/agent-backends${refresh ? "?refresh=1" : ""}`),
  setActiveBackend: (backendId: AgentBackendId) => request<AgentBackendsView>("PUT", "/api/agent-backends-active", { backendId }),
  readCodexStatus: (refresh = false) => request<CodexStatus>("GET", `/api/codex/status${refresh ? "?refresh=1" : ""}`),
  saveCodexSettings: (settings: { mode: CodexAuthMode; apiKey?: string; models?: string[] }) => request<CodexStatus>("PUT", "/api/codex/settings", settings),
  startCodexLogin: () => request<{ url: string }>("POST", "/api/codex/login"),
  cancelCodexLogin: () => request<{ ok: true }>("POST", "/api/codex/login/cancel"),
  logoutCodex: () => request<CodexStatus>("POST", "/api/codex/logout"),
  readProviders: () => request<ProvidersView>("GET", "/api/providers"),
  createProvider: (input: ProviderInput) => request<ProvidersView>("POST", "/api/providers", input),
  updateProvider: (providerId: string, input: ProviderInput) => request<ProvidersView>("PUT", `/api/providers/${providerId}`, input),
  deleteProvider: (providerId: string) => request<ProvidersView>("DELETE", `/api/providers/${providerId}`),
  setActiveProvider: (providerId: string) => request<ProvidersView>("PUT", "/api/providers-active", { providerId }),
  discoverProviderModels: (input: { protocol: ProviderProtocol; baseUrl: string; apiKey?: string; providerId?: string }) =>
    request<{ models: string[] }>("POST", "/api/providers/discover-models", input),
  saveClaudeSettings: (mode: ClaudeAuthMode, apiKey?: string) => request<ClaudeAuthStatus>("PUT", "/api/claude/settings", { mode, apiKey }),
  startClaudeLogin: (method: "claudeai" | "console", environmentId?: string) => request<{ url: string }>("POST", "/api/claude/login", { method, environmentId }),
  submitClaudeLoginCode: (code: string, environmentId?: string) => request<ClaudeAuthStatus>("POST", "/api/claude/login/code", { code, environmentId }),
  cancelClaudeLogin: (environmentId?: string) => request<{ ok: true }>("POST", "/api/claude/login/cancel", { environmentId }),
  logoutClaude: (environmentId?: string) => request<ClaudeAuthStatus>("POST", "/api/claude/logout", { environmentId }),
  listExternalMcpServers: (projectId: string | null) => request<ExternalMcpServer[]>("GET", `/api/mcp-servers/external?projectId=${encodeURIComponent(projectId ?? "")}`),
  importMcpServer: (sourceId: string, name: string, projectId: string | null) => request<{ ok: true }>("POST", "/api/mcp-servers/import", { sourceId, name, projectId }),
  listMcpServers: () => request<McpServer[]>("GET", "/api/mcp-servers"),
  createMcpServer: (serverInput: McpServerInput) => request<McpServer>("POST", "/api/mcp-servers", serverInput),
  updateMcpServer: (serverId: string, serverInput: McpServerInput) => request<McpServer>("PUT", `/api/mcp-servers/${serverId}`, serverInput),
  deleteMcpServer: (serverId: string) => request<{ ok: true }>("DELETE", `/api/mcp-servers/${serverId}`),
  testMcpServer: (serverId: string) => request<McpServerTestResult>("POST", `/api/mcp-servers/${serverId}/test`),
  listSkills: (projectId: string | null) => request<Skill[]>("GET", `/api/skills?projectId=${encodeURIComponent(projectId ?? "")}`),
  createSkill: (skillInput: { scope: SkillScope; projectId: string | null; name: string; description: string; instructions: string }) =>
    request<{ ok: true }>("POST", "/api/skills", skillInput),
  readSkillFile: (scope: SkillScope, projectId: string | null, skillPath: string) =>
    request<{ content: string }>("GET", `/api/skills/file?${new URLSearchParams({ scope, projectId: projectId ?? "", path: skillPath })}`).then(
      (responseBody) => responseBody.content,
    ),
  saveSkillFile: (scope: SkillScope, projectId: string | null, skillPath: string, content: string) =>
    request<{ ok: true }>("PUT", "/api/skills/file", { scope, projectId, path: skillPath, content }),
  setSkillEnabled: (skillName: string, enabled: boolean) =>
    request<{ ok: true }>("PUT", `/api/skills/${encodeURIComponent(skillName)}/enabled`, { enabled }),
  readMemorySettings: () => request<MemorySettingsView>("GET", "/api/settings/memory"),
  saveMemorySettings: (settings: MemorySettings, openaiApiKey?: string) =>
    request<MemorySettingsView>("PUT", "/api/settings/memory", { settings, openaiApiKey: openaiApiKey || undefined }),
  listMemoryNotes: (projectId: string | null) => request<MemoryNoteSummary[]>("GET", `/api/memory/notes?projectId=${encodeURIComponent(projectId ?? "")}`),
  searchMemory: (searchText: string, projectId: string | null) =>
    request<MemorySearchHit[]>("GET", `/api/memory/search?q=${encodeURIComponent(searchText)}&projectId=${encodeURIComponent(projectId ?? "")}`),
  readMemoryNote: (noteRef: MemoryNoteRef) =>
    request<{ content: string }>("GET", `/api/memory/note?${memoryNoteQuery(noteRef)}`).then((responseBody) => responseBody.content),
  saveMemoryNote: (noteRef: MemoryNoteRef, content: string) =>
    request<{ path: string }>("PUT", "/api/memory/note", { ...noteRef, content }).then((responseBody) => responseBody.path),
  listMemoryFiles: (projectId: string | null) => request<MemoryFile[]>("GET", `/api/memory/files?projectId=${encodeURIComponent(projectId ?? "")}`),
  /** Uploads files into memory (`dateien/` of the project or workspace memory folder). */
  uploadMemoryFiles: async (scope: MemoryScope, projectId: string | null, files: File[]): Promise<MemoryFile[]> => {
    const formData = new FormData();
    for (const file of files) formData.append("files", file, file.name);
    const response = await fetch(`${coreBaseUrl}/api/memory/files?${new URLSearchParams({ scope, projectId: projectId ?? "" })}`, {
      method: "POST",
      headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
      body: formData,
    });
    const responseBody = await response.json();
    if (!response.ok) throw new Error(responseBody.error ?? response.statusText);
    return responseBody as MemoryFile[];
  },
  memoryFileUrl: (fileRef: MemoryNoteRef) => `${coreBaseUrl}/api/memory/files/raw?${memoryNoteQuery(fileRef)}${accessToken ? `&token=${encodeURIComponent(accessToken)}` : ""}`,
  deleteMemoryFile: (fileRef: MemoryNoteRef) => request<{ ok: true }>("DELETE", `/api/memory/files?${memoryNoteQuery(fileRef)}`),
  listManagedFiles: () => request<ManagedFile[]>("GET", "/api/files"),
  managedFileUrl: (fileId: string) => `${coreBaseUrl}/api/files/raw?id=${encodeURIComponent(fileId)}${accessToken ? `&token=${encodeURIComponent(accessToken)}` : ""}`,
  deleteManagedFiles: (fileIds: string[]) => request<{ removedCount: number }>("POST", "/api/files/delete", { fileIds }),
  copyFileToMemory: (fileId: string, scope: MemoryScope, projectId: string | null) => request<MemoryFile>("POST", "/api/files/to-memory", { fileId, scope, projectId }),
  listSessionExclusiveFiles: (sessionId: string) => request<ManagedFile[]>("GET", `/api/sessions/${sessionId}/exclusive-files`),
  deleteMemoryNote: (noteRef: MemoryNoteRef) => request<{ ok: true }>("DELETE", `/api/memory/note?${memoryNoteQuery(noteRef)}`),
  readVoiceSettings: () => request<VoiceSettingsView>("GET", "/api/settings/voice"),
  saveVoiceSettings: (settings: VoiceSettings, secrets: Partial<Record<VoiceSecretKey, string>>) =>
    request<VoiceSettingsView>("PUT", "/api/settings/voice", { settings, secrets }),
  transcribe: async (audio: Blob): Promise<string> => {
    const response = await fetch(coreBaseUrl + "/api/voice/transcribe", {
      method: "POST",
      headers: { "content-type": audio.type || "audio/webm", ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
      body: audio,
    });
    const responseBody = await response.json();
    if (!response.ok) throw new Error(responseBody.error ?? response.statusText);
    return String(responseBody.text ?? "");
  },
  speak: async (text: string): Promise<Blob> => {
    const response = await fetch(coreBaseUrl + "/api/voice/speak", {
      method: "POST",
      headers: { "content-type": "application/json", ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? response.statusText);
    return response.blob();
  },
  readCanvas: (projectId: string) => request<CanvasDocument>("GET", `/api/projects/${projectId}/canvas`),
  writeCanvas: (projectId: string, canvasDocument: CanvasDocument) =>
    request("PUT", `/api/projects/${projectId}/canvas`, canvasDocument),
  designSystemFileUrl: (designSystemId: string, filePath: string) =>
    `${coreBaseUrl}/design-systems/${designSystemId}/${filePath.split("/").map(encodeURIComponent).join("/")}${accessToken ? `?token=${encodeURIComponent(accessToken)}` : ""}`,
  previewUrl: (projectId: string, filePath: string) =>
    `${coreBaseUrl}/preview/${projectId}/${filePath.split("/").map(encodeURIComponent).join("/")}${accessToken ? `?token=${encodeURIComponent(accessToken)}` : ""}`,
};

export function connectEvents(onServerEvent: (serverEvent: ServerEvent) => void): () => void {
  let socket: WebSocket | undefined;
  let closedByClient = false;
  let reconnectTimer: number | undefined;

  const open = () => {
    const httpBase = coreBaseUrl || window.location.origin;
    const socketUrl = httpBase.replace(/^http/, "ws") + "/ws" + (accessToken ? `?token=${encodeURIComponent(accessToken)}` : "");
    socket = new WebSocket(socketUrl);
    socket.onmessage = (messageEvent) => onServerEvent(JSON.parse(messageEvent.data) as ServerEvent);
    socket.onclose = () => {
      if (!closedByClient) reconnectTimer = window.setTimeout(open, 1500);
    };
  };
  open();

  return () => {
    closedByClient = true;
    window.clearTimeout(reconnectTimer);
    socket?.close();
  };
}
