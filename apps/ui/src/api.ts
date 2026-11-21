import type { TodayOverview, Environment, EnvironmentAccountChecks, EnvironmentInput, ImageRequest, ImageSettings, ImageSettingsView, ClaudeAuthMode, ClaudeAuthStatus, DesignSystemDetail, DesignSystemLinkTarget, DesignSystemSummary, TokenTree, McpServer, McpServerInput, McpServerTestResult, Skill, SkillScope, MemoryNoteRef, MemoryNoteSummary, MemorySearchHit, MemorySettings, MemorySettingsView, VoiceSecretKey, VoiceSettings, VoiceSettingsView, CanvasDocument, Channel, ChannelInput, Task, TaskInput, TaskRun, ChatItem, FileNode, PermissionMode, Project, ServerEvent, Session } from "./types.ts";

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
  const response = await fetch(coreBaseUrl + path, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const responseBody = await response.json();
  if (!response.ok) throw new Error(responseBody.error ?? response.statusText);
  return responseBody as ResponseBody;
}

const memoryNoteQuery = (noteRef: MemoryNoteRef) =>
  new URLSearchParams({ scope: noteRef.scope, projectId: noteRef.projectId ?? "", path: noteRef.path }).toString();

export const api = {
  readToday: () => request<TodayOverview>("GET", "/api/today"),
  listProjects: () => request<Project[]>("GET", "/api/projects"),
  createProject: (name: string, path?: string, environmentId?: string | null) => request<Project>("POST", "/api/projects", { name, path, environmentId }),
  setProjectEnvironment: (projectId: string, environmentId: string | null) => request<{ ok: true }>("PUT", `/api/projects/${projectId}/environment`, { environmentId }),
  listEnvironments: () => request<Environment[]>("GET", "/api/environments"),
  createEnvironment: (input: EnvironmentInput) => request<Environment>("POST", "/api/environments", input),
  updateEnvironment: (environmentId: string, input: EnvironmentInput) => request<Environment>("PUT", `/api/environments/${environmentId}`, input),
  deleteEnvironment: (environmentId: string) => request<{ ok: true }>("DELETE", `/api/environments/${environmentId}`),
  checkEnvironmentAccounts: (environmentId: string) => request<EnvironmentAccountChecks>("POST", `/api/environments/${environmentId}/check`),
  listSessions: (projectId: string) => request<Session[]>("GET", `/api/projects/${projectId}/sessions`),
  createSession: (projectId: string) => request<Session>("POST", `/api/projects/${projectId}/sessions`),
  deleteSession: (sessionId: string) => request("DELETE", `/api/sessions/${sessionId}`),
  listChatItems: (sessionId: string) => request<ChatItem[]>("GET", `/api/sessions/${sessionId}/items`),
  sendMessage: (sessionId: string, text: string, permissionMode: PermissionMode, model?: string) =>
    request("POST", `/api/sessions/${sessionId}/messages`, { text, permissionMode, model: model || undefined }),
  interrupt: (sessionId: string) => request("POST", `/api/sessions/${sessionId}/interrupt`),
  answerPermission: (requestId: string, allow: boolean) => request("POST", `/api/permissions/${requestId}`, { allow }),
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
  listChannels: () => request<Channel[]>("GET", "/api/channels"),
  createChannel: (channelInput: ChannelInput) => request<Channel>("POST", "/api/channels", channelInput),
  updateChannel: (channelId: string, channelInput: ChannelInput) => request<Channel>("PUT", `/api/channels/${channelId}`, channelInput),
  deleteChannel: (channelId: string) => request("DELETE", `/api/channels/${channelId}`),
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
  readDefaultModel: () => request<{ defaultModel: string }>("GET", "/api/settings/model"),
  saveDefaultModel: (defaultModel: string) => request<{ defaultModel: string }>("PUT", "/api/settings/model", { defaultModel }),
  readClaudeStatus: (refresh = false, environmentId?: string) =>
    request<ClaudeAuthStatus>("GET", `/api/claude/status?${new URLSearchParams({ ...(refresh ? { refresh: "1" } : {}), ...(environmentId ? { environmentId } : {}) })}`),
  saveClaudeSettings: (mode: ClaudeAuthMode, apiKey?: string) => request<ClaudeAuthStatus>("PUT", "/api/claude/settings", { mode, apiKey }),
  startClaudeLogin: (method: "claudeai" | "console", environmentId?: string) => request<{ url: string }>("POST", "/api/claude/login", { method, environmentId }),
  submitClaudeLoginCode: (code: string, environmentId?: string) => request<ClaudeAuthStatus>("POST", "/api/claude/login/code", { code, environmentId }),
  cancelClaudeLogin: (environmentId?: string) => request<{ ok: true }>("POST", "/api/claude/login/cancel", { environmentId }),
  logoutClaude: (environmentId?: string) => request<ClaudeAuthStatus>("POST", "/api/claude/logout", { environmentId }),
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
