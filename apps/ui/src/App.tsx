import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDefaultLayout, usePanelRef } from "react-resizable-panels";
import { api, connectEvents } from "@/api";
import type { TeamAgent, Attachment, SessionReference, Channel, ChatItem, AgentBackendsView, ClaudeAuthStatus, CodexStatus, ProvidersView, DesignSystemLinkTarget, Environment, PermissionMode, PermissionRequest, Project, QueuedMessage, ServerEvent, Session, Task, VoiceSettingsView } from "@/types";
import { cn } from "@/lib/utils";
import { safeStorage } from "@/lib/storage";
import { useTheme } from "@/hooks/use-theme";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppSidebar } from "@/components/app-sidebar";
import { ChatPane } from "@/components/chat/chat-pane";
import { WorkspacePane } from "@/components/workspace/workspace-pane";
import { NewProjectDialog } from "@/components/new-project-dialog";
import type { SessionStatus } from "@/components/status-dot";
import { routePath, useHashRoute } from "@/hooks/use-hash-route";
import { SettingsScreen, settingsSectionNames, type SettingsSection } from "@/screens/settings-screen";
import { DesignSystemsScreen } from "@/screens/design-systems-screen";
import { EnvironmentsScreen } from "@/screens/environments-screen";
import { TodayScreen } from "@/screens/today-screen";
import { AgentOnboarding } from "@/components/agent-connection";
import { modelsForBackend, setActiveModels } from "@/components/model-select";
import { setAgentBackendsView } from "@/lib/agent-backends";
import { TasksScreen } from "@/screens/tasks-screen";
import { MemoryScreen, type MemorySelection } from "@/screens/memory-screen";
import { FilesScreen } from "@/screens/files-screen";
import { IntegrationsScreen, type IntegrationsTab } from "@/screens/integrations-screen";
import { ChannelsScreen, channelStatusDot } from "@/screens/channels-screen";
import { Button } from "@/components/ui/button";
import type { InheritedModel } from "@/components/model-select";
import { ConfirmDialogHost, confirmAction, confirmWithOption } from "@/components/confirm-dialog";
import { formatFileSize } from "@/components/chat/attachment-views";
import { ProjectIconDialog } from "@/components/project-icon-dialog";
import { TextPromptDialogHost, askForText } from "@/components/text-prompt-dialog";
import type { MenuAction } from "@/components/action-menu";
import { Copy, FolderOpen, FolderInput, Layers, MessageSquarePlus, Pencil, Smile, Trash2, Users } from "lucide-react";
import { TeamScreen } from "@/screens/team-screen";
import { conversationMembers, latestVersionId } from "@/lib/session-versions";
import { systemSpeechAvailable } from "@/lib/system-speech";
import { t } from "@/lib/i18n";
import { AppVersionBadge } from "@/components/app-version-badge";
import { Toaster } from "@/components/toaster";
import { toast } from "@/lib/toast";

const panelAnimationMs = 260;
const activeEnvironmentStorageKey = "harnold.activeEnvironment";

export function App() {
  const { themePreference, setThemePreference, resolvedTheme } = useTheme();

  const [projects, setProjects] = useState<Project[]>([]);
  const [sessionsByProjectId, setSessionsByProjectId] = useState<Record<string, Session[]>>({});
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(new Set());
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [chatItems, setChatItems] = useState<ChatItem[]>([]);
  const [streamingDraft, setStreamingDraft] = useState("");
  const [streamingThinking, setStreamingThinking] = useState("");
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(new Set());
  const [permissionRequests, setPermissionRequests] = useState<PermissionRequest[]>([]);
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);
  const [liveContextTokens, setLiveContextTokens] = useState<number | null>(null);
  const [fileChangeCounter, setFileChangeCounter] = useState(0);
  const [lastChangedPaths, setLastChangedPaths] = useState<string[]>([]);
  const [composerInsertion, setComposerInsertion] = useState<{ text: string; nonce: number } | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [memoryChangeCounter, setMemoryChangeCounter] = useState(0);
  const [integrationsChangeCounter, setIntegrationsChangeCounter] = useState(0);
  const [designSystemsChangeCounter, setDesignSystemsChangeCounter] = useState(0);
  const [claudeStatus, setClaudeStatus] = useState<ClaudeAuthStatus | null>(null);
  const [providers, setProviders] = useState<ProvidersView | null>(null);
  const [agentBackends, setAgentBackends] = useState<AgentBackendsView | null>(null);
  const [codexStatus, setCodexStatus] = useState<CodexStatus | null>(null);
  const [onboardingVisible, setOnboardingVisible] = useState(false);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [teamAgents, setTeamAgents] = useState<TeamAgent[]>([]);
  const [todayReloadCounter, setTodayReloadCounter] = useState(0);
  const [defaultModel, setDefaultModel] = useState("claude-opus-5-5");
  const [activeEnvironmentId, setActiveEnvironmentId] = useState<string | null>(() => safeStorage.getItem(activeEnvironmentStorageKey));
  const [newProjectDialogOpen, setNewProjectDialogOpen] = useState(false);
  const [iconDialogProject, setIconDialogProject] = useState<Project | null>(null);
  /** Project shown in the memory screen; follows the active project until picked there. */
  const [memoryProjectId, setMemoryProjectId] = useState<string | null>(null);
  const [voiceSettings, setVoiceSettings] = useState<VoiceSettingsView | null>(null);
  const [workspaceOpen, setWorkspaceOpen] = useState(true);
  const [panelsAnimating, setPanelsAnimating] = useState(false);

  const workspacePanelRef = usePanelRef();
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: "harnold-shell-v2", storage: safeStorage });
  const { defaultLayout: mainDefaultLayout, onLayoutChanged: onMainLayoutChanged } = useDefaultLayout({ id: "harnold-main", storage: safeStorage });
  const { route, navigate } = useHashRoute();

  const activeIdsRef = useRef({ activeProjectId, activeSessionId });
  activeIdsRef.current = { activeProjectId, activeSessionId };
  const environmentsRef = useRef(environments);
  environmentsRef.current = environments;

  const reportError = useCallback((unknownError: unknown) => toast.error(unknownError), []);

  const refreshTasks = useCallback(() => api.listTasks().then(setTasks).catch(reportError), [reportError]);
  const refreshChannels = useCallback(() => api.listChannels().then(setChannels).catch(reportError), [reportError]);
  const refreshTeam = useCallback(() => api.listTeam().then(setTeamAgents).catch(reportError), [reportError]);
  const refreshEnvironments = useCallback(
    () =>
      api
        .listEnvironments()
        .then((loadedEnvironments) => {
          setEnvironments(loadedEnvironments);
          setActiveEnvironmentId((previous) => (previous && loadedEnvironments.some((environment) => environment.id === previous) ? previous : null));
        })
        .catch(reportError),
    [reportError],
  );

  useEffect(() => {
    if (activeEnvironmentId) safeStorage.setItem(activeEnvironmentStorageKey, activeEnvironmentId);
    else safeStorage.removeItem(activeEnvironmentStorageKey);
  }, [activeEnvironmentId]);

  useEffect(() => {
    void refreshTasks();
    void refreshChannels();
    void refreshEnvironments();
    void refreshTeam();
    // Approvals that were already waiting before this window opened.
    api
      .readToday()
      .then((overview) =>
        setPermissionRequests((previous) => [
          ...previous,
          ...overview.waiting
            .filter((waiting) => !previous.some((request) => request.requestId === waiting.requestId))
            .map(({ requestId, sessionId, toolName, input }) => ({ requestId, sessionId, toolName, input })),
        ]),
      )
      .catch(reportError);
    api.readDefaultModel().then((modelSettings) => setDefaultModel(modelSettings.defaultModel)).catch(reportError);
    api.readProviders().then(setProviders).catch(reportError);
    api.readVoiceSettings().then(setVoiceSettings).catch(reportError);
    api.readCodexStatus().then(setCodexStatus).catch(() => undefined);
    Promise.all([api.readClaudeStatus(), api.readAgentBackends()])
      .then(([loadedStatus, loadedBackends]) => {
        setClaudeStatus(loadedStatus);
        setAgentBackends(loadedBackends);
        const activeBackend = loadedBackends.backends.find((backend) => backend.id === loadedBackends.activeId);
        // Unknown Claude CLI state (status failed) is no reason to block – the agent reports real auth errors itself.
        if (activeBackend && !activeBackend.ready && !(activeBackend.id === "claude-code" && loadedStatus.cliError)) setOnboardingVisible(true);
      })
      .catch(reportError);
  }, [refreshTasks, refreshChannels, refreshEnvironments]);

  const refreshSessions = useCallback(
    (projectId: string) =>
      api
        .listSessions(projectId)
        .then((loadedSessions) => {
          setSessionsByProjectId((previous) => ({ ...previous, [projectId]: loadedSessions }));
          setRunningSessionIds((previous) => {
            const next = new Set(previous);
            for (const session of loadedSessions) if (session.running) next.add(session.id);
            return next;
          });
        })
        .catch(reportError),
    [reportError],
  );

  useEffect(() => {
    api
      .listProjects()
      .then((loadedProjects) => {
        setProjects(loadedProjects);
        const firstProject = loadedProjects.find((project) => project.kind !== "quick");
        if (firstProject) {
          setActiveProjectId(firstProject.id);
          setExpandedProjectIds(new Set([firstProject.id]));
        }
        for (const project of loadedProjects) void refreshSessions(project.id);
      })
      .catch(reportError);
  }, [reportError, refreshSessions]);

  useEffect(() => {
    setChatItems([]);
    setStreamingDraft("");
    setStreamingThinking("");
    setQueuedMessages([]);
    setLiveContextTokens(null);
    if (activeSessionId) api.listChatItems(activeSessionId).then(setChatItems).catch(reportError);
    if (activeSessionId) api.listQueue(activeSessionId).then(setQueuedMessages).catch(() => undefined);
  }, [activeSessionId, reportError]);

  useEffect(
    () =>
      connectEvents((serverEvent: ServerEvent) => {
        const { activeProjectId: currentProjectId, activeSessionId: currentSessionId } = activeIdsRef.current;
        switch (serverEvent.type) {
          case "chat_item":
            if (serverEvent.sessionId !== currentSessionId) return;
            if (serverEvent.chatItem.kind === "assistant_text") setStreamingDraft("");
            if (serverEvent.chatItem.kind === "assistant_text" || serverEvent.chatItem.kind === "thinking" || serverEvent.chatItem.kind === "tool_use") setStreamingThinking("");
            setChatItems((previous) => [...previous, serverEvent.chatItem]);
            return;
          case "text_delta":
            if (serverEvent.sessionId === currentSessionId) setStreamingDraft((previous) => previous + serverEvent.text);
            return;
          case "thinking_delta":
            if (serverEvent.sessionId === currentSessionId) setStreamingThinking((previous) => previous + serverEvent.text);
            return;
          case "session_cleared":
            if (serverEvent.sessionId === currentSessionId) {
              setChatItems([]);
              setStreamingDraft("");
              setStreamingThinking("");
            }
            return;
          case "session_moved":
            if (serverEvent.sessionId !== currentSessionId) return;
            setActiveProjectId(serverEvent.toProjectId);
            setExpandedProjectIds((previous) => new Set(previous).add(serverEvent.toProjectId));
            setActiveEnvironmentId((previous) => {
              if (!previous) return previous;
              const targetEnvironment = environmentsRef.current.find((environment) => environment.projectIds.includes(serverEvent.toProjectId));
              return targetEnvironment?.id ?? null;
            });
            return;
          case "turn_state":
            setRunningSessionIds((previous) => {
              const next = new Set(previous);
              if (serverEvent.running) next.add(serverEvent.sessionId);
              else next.delete(serverEvent.sessionId);
              return next;
            });
            if (!serverEvent.running && serverEvent.sessionId === currentSessionId) {
              setLiveContextTokens(null);
              setStreamingDraft("");
              setStreamingThinking("");
            }
            if (!serverEvent.running) setTodayReloadCounter((previous) => previous + 1);
            return;
          case "queue_changed":
            if (serverEvent.sessionId === currentSessionId) setQueuedMessages(serverEvent.queue);
            return;
          case "context_size":
            if (serverEvent.sessionId === currentSessionId) setLiveContextTokens(serverEvent.tokens);
            return;
          case "permission_request":
            setPermissionRequests((previous) => [...previous, serverEvent]);
            return;
          case "permission_resolved":
            setPermissionRequests((previous) => previous.filter((request) => request.requestId !== serverEvent.requestId));
            return;
          case "files_changed":
            if (serverEvent.projectId !== currentProjectId) return;
            setLastChangedPaths(serverEvent.paths);
            setFileChangeCounter((previous) => previous + 1);
            return;
          case "sessions_changed":
            void refreshSessions(serverEvent.projectId);
            return;
          case "tasks_changed":
            void refreshTasks();
            return;
          case "channels_changed":
            void refreshChannels();
            return;
          case "memory_changed":
            setMemoryChangeCounter((previous) => previous + 1);
            return;
          case "integrations_changed":
            setIntegrationsChangeCounter((previous) => previous + 1);
            return;
          case "design_systems_changed":
            setDesignSystemsChangeCounter((previous) => previous + 1);
            return;
          case "environments_changed":
            void refreshEnvironments();
            return;
          case "team_changed":
            void refreshTeam();
            return;
          case "projects_changed":
            api.listProjects().then(setProjects).catch(() => undefined);
            return;
          case "settings_changed":
            api.readDefaultModel().then((modelSettings) => setDefaultModel(modelSettings.defaultModel)).catch(() => undefined);
            api.readVoiceSettings().then(setVoiceSettings).catch(() => undefined);
            return;
          case "claude_auth_changed":
            api.readClaudeStatus().then(setClaudeStatus).catch(() => undefined);
            api.readProviders().then(setProviders).catch(() => undefined);
            api.readAgentBackends().then(setAgentBackends).catch(() => undefined);
            api.readCodexStatus().then(setCodexStatus).catch(() => undefined);
            api.readDefaultModel().then((modelSettings) => setDefaultModel(modelSettings.defaultModel)).catch(() => undefined);
            return;
          case "task_run_finished":
            setTodayReloadCounter((previous) => previous + 1);
            toast[serverEvent.success ? "success" : "error"](t("Task „{0}“ {1}", serverEvent.taskName, serverEvent.success ? t("fertig") : t("fehlgeschlagen")), {
              label: t("Öffnen"),
              run: () => {
                setActiveProjectId(serverEvent.projectId);
                setActiveSessionId(serverEvent.sessionId);
                navigate("/");
                setExpandedProjectIds((previous) => new Set(previous).add(serverEvent.projectId));
              },
            });
            return;
        }
      }),
    [refreshSessions, refreshTasks, refreshChannels, refreshEnvironments, navigate],
  );

  // The model pickers list the models of the active provider.
  useEffect(() => {
    setActiveModels(modelsForBackend(agentBackends?.activeId, providers, codexStatus));
    setAgentBackendsView(agentBackends);
  }, [providers, agentBackends, codexStatus]);

  /** Model a turn in this project uses when the composer/task picks none: environment model, else settings. */
  const inheritedModelFor = (projectId: string | null): InheritedModel => {
    const environment = environments.find((candidate) => projectId && candidate.projectIds.includes(projectId));
    return environment?.model ? { model: environment.model, source: environment.name } : { model: defaultModel, source: "Einstellungen" };
  };

  const sessionReferenceFor = (sessionId: string): SessionReference | null => {
    for (const [projectId, sessions] of Object.entries(sessionsByProjectId)) {
      const session = sessions.find((candidate) => candidate.id === sessionId);
      if (session) return { sessionId, sessionTitle: session.title, projectId, projectName: projects.find((project) => project.id === projectId)?.name ?? "" };
    }
    return null;
  };

  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null;
  const activeSession = activeProjectId
    ? (sessionsByProjectId[activeProjectId] ?? []).find((session) => session.id === activeSessionId) ?? null
    : null;

  const lastTurnFailed = useMemo(() => {
    const lastTurnResult = [...chatItems].reverse().find((chatItem) => chatItem.kind === "turn_result");
    return lastTurnResult?.kind === "turn_result" && !lastTurnResult.success;
  }, [chatItems]);

  const sessionStatusFor = (sessionId: string): SessionStatus => {
    if (permissionRequests.some((request) => request.sessionId === sessionId)) return "waiting";
    if (runningSessionIds.has(sessionId)) return "running";
    if (sessionId === activeSessionId && lastTurnFailed) return "error";
    return "idle";
  };

  const animatePanels = () => {
    setPanelsAnimating(true);
    window.setTimeout(() => setPanelsAnimating(false), panelAnimationMs);
  };

  const setWorkspaceVisibility = (visible: boolean) => {
    animatePanels();
    requestAnimationFrame(() => (visible ? workspacePanelRef.current?.expand() : workspacePanelRef.current?.collapse()));
  };

  const createProject = async (name: string, projectPath?: string) => {
    try {
      const project = await api.createProject(name, projectPath, activeEnvironmentId);
      setProjects((previous) => [project, ...previous]);
      setSessionsByProjectId((previous) => ({ ...previous, [project.id]: [] }));
      setExpandedProjectIds((previous) => new Set(previous).add(project.id));
      setActiveProjectId(project.id);
      setActiveSessionId(null);
      toast.success(t("Projekt „{0}“ angelegt", project.name));
    } catch (creationError) {
      reportError(creationError);
    }
  };

  /** Switches the sidebar to an environment and moves the active project into it. */
  const switchEnvironment = (environmentId: string | null) => {
    setActiveEnvironmentId(environmentId);
    const environment = environments.find((candidate) => candidate.id === environmentId);
    if (!environment || (activeProjectId && environment.projectIds.includes(activeProjectId))) return;
    const firstProject = projects.find((project) => environment.projectIds.includes(project.id));
    setActiveProjectId(firstProject?.id ?? null);
    setActiveSessionId(null);
    if (firstProject) setExpandedProjectIds((previous) => new Set(previous).add(firstProject.id));
  };

  /** Team of a project: agents of its environment plus those available everywhere. */
  const teamForProject = (projectId: string | null) => {
    if (projects.find((project) => project.id === projectId)?.kind === "quick") return teamAgents;
    const environmentId = environments.find((environment) => projectId && environment.projectIds.includes(projectId))?.id ?? null;
    return teamAgents.filter((agent) => agent.environmentId === null || agent.environmentId === environmentId);
  };

  const createSession = async (projectId: string, agentId: string | null = null): Promise<Session | null> => {
    try {
      const session = await api.createSession(projectId, agentId);
      setSessionsByProjectId((previous) => ({ ...previous, [projectId]: [session, ...(previous[projectId] ?? []).filter((existing) => existing.id !== session.id)] }));
      setExpandedProjectIds((previous) => new Set(previous).add(projectId));
      setActiveProjectId(projectId);
      setActiveSessionId(session.id);
      return session;
    } catch (creationError) {
      reportError(creationError);
      return null;
    }
  };

  /** Chat without a project: lives in the built-in Quick Chats project. */
  const createQuickChat = async () => {
    try {
      const session = await api.createQuickChat();
      if (!projects.some((project) => project.id === session.projectId)) setProjects(await api.listProjects());
      setSessionsByProjectId((previous) => ({ ...previous, [session.projectId]: [session, ...(previous[session.projectId] ?? []).filter((existing) => existing.id !== session.id)] }));
      setExpandedProjectIds((previous) => new Set(previous).add(session.projectId));
      setActiveProjectId(session.projectId);
      setActiveSessionId(session.id);
      navigate("/");
    } catch (creationError) {
      reportError(creationError);
    }
  };

  /** Sends an edited message as a new version of the conversation and switches to it. */
  const editMessage = async (itemId: string, text: string) => {
    if (!activeSessionId || !activeProjectId) return;
    try {
      const permissionMode = (safeStorage.getItem("harnold.permissionMode") as PermissionMode | null) ?? "default";
      const versionSession = await api.editMessage(activeSessionId, itemId, text, permissionMode, safeStorage.getItem("harnold.model") ?? undefined);
      setSessionsByProjectId((previous) => ({ ...previous, [versionSession.projectId]: [versionSession, ...(previous[versionSession.projectId] ?? [])] }));
      setActiveSessionId(versionSession.id);
    } catch (editError) {
      reportError(editError);
    }
  };

  const updateProjectIcon = (project: Project, icon: string | null) =>
    api
      .updateProject(project.id, { icon })
      .then((updatedProject) => {
        setProjects((previous) => previous.map((candidate) => (candidate.id === updatedProject.id ? updatedProject : candidate)));
        toast.success(t("Symbol geändert"));
      })
      .catch(reportError);

  const isDesktopApp = "__TAURI_INTERNALS__" in window;

  const renameProject = async (project: Project) => {
    const name = await askForText({ title: t("Projekt umbenennen"), initialValue: project.name });
    if (!name || name === project.name) return;
    api
      .updateProject(project.id, { name })
      .then((updatedProject) => {
        setProjects((previous) => previous.map((candidate) => (candidate.id === updatedProject.id ? updatedProject : candidate)));
        toast.success(t("Projekt umbenannt"));
      })
      .catch(reportError);
  };

  const removeProject = async (project: Project) => {
    const sessionCount = (sessionsByProjectId[project.id] ?? []).length;
    const confirmed = await confirmAction({
      title: t("Projekt „{0}“ aus Harnold entfernen?", project.name),
      description: t("{0}Der Ordner {1} bleibt mit allen Dateien erhalten.", sessionCount ? t("{0} Session(s) und zugehörige Tasks werden gelöscht. ", sessionCount) : "", project.path),
      confirmLabel: t("Entfernen"),
    });
    if (!confirmed) return;
    try {
      await api.deleteProject(project.id);
      setProjects((previous) => previous.filter((candidate) => candidate.id !== project.id));
      if (activeProjectId === project.id) {
        setActiveProjectId(null);
        setActiveSessionId(null);
      }
      void refreshEnvironments();
      void refreshTasks();
      toast.success(t("Projekt „{0}“ entfernt", project.name));
    } catch (removeError) {
      reportError(removeError);
    }
  };

  const projectActions = (project: Project): MenuAction[] => [
    { label: t("Neue Session"), icon: MessageSquarePlus, onSelect: () => void createSession(project.id) },
    {
      label: t("Neue Session mit"),
      icon: Users,
      hidden: teamForProject(project.id).length === 0,
      children: teamForProject(project.id).map((agent) => ({ label: agent.name, onSelect: () => void createSession(project.id, agent.id) })),
    },
    { label: t("Umbenennen"), icon: Pencil, onSelect: () => void renameProject(project), separated: true },
    { label: t("Icon ändern"), icon: Smile, onSelect: () => setIconDialogProject(project) },
    {
      label: t("Umgebung"),
      icon: Layers,
      hidden: environments.length === 0,
      children: [null, ...environments].map((environment) => ({
        label: environment?.name ?? "Keine",
        checked: environment ? environment.projectIds.includes(project.id) : !environments.some((candidate) => candidate.projectIds.includes(project.id)),
        onSelect: () => api.setProjectEnvironment(project.id, environment?.id ?? null).then(() => refreshEnvironments()).catch(reportError),
      })),
    },
    { label: t("Im Finder zeigen"), icon: FolderOpen, hidden: !isDesktopApp, onSelect: () => api.revealProject(project.id).catch(reportError), separated: true },
    { label: t("Pfad kopieren"), icon: Copy, onSelect: () => void navigator.clipboard.writeText(project.path).catch(reportError), separated: !isDesktopApp },
    { label: t("Aus Harnold entfernen"), icon: Trash2, destructive: true, onSelect: () => void removeProject(project), separated: true },
  ];

  const sessionActions = (session: Session): MenuAction[] => [
    {
      label: t("Umbenennen"),
      icon: Pencil,
      onSelect: async () => {
        const title = await askForText({ title: t("Session umbenennen"), initialValue: session.title });
        if (title && title !== session.title) {
          api
            .updateSession(session.id, { title })
            .then(() => {
              setSessionsByProjectId((previous) => ({
                ...previous,
                [session.projectId]: (previous[session.projectId] ?? []).map((candidate) => (candidate.id === session.id ? { ...candidate, title } : candidate)),
              }));
              toast.success(t("Session umbenannt"));
            })
            .catch(reportError);
        }
      },
    },
    {
      label: t("Verschieben nach"),
      icon: FolderInput,
      children: projects
        .filter((project) => project.id !== session.projectId)
        .map((project) => ({
          label: project.name,
          onSelect: () =>
            api
              .updateSession(session.id, { projectId: project.id })
              .then((moveResult) => moveResult.deferred && toast.info(t("Wird nach diesem Durchlauf verschoben")))
              .catch(reportError),
        })),
    },
    { label: t("Löschen"), icon: Trash2, destructive: true, separated: true, onSelect: () => void deleteSession(session) },
  ];

  const deleteSession = async (session: Session) => {
    const projectSessions = sessionsByProjectId[session.projectId] ?? [];
    const removedSessionIds = new Set(conversationMembers(session.id, projectSessions).map((member) => member.id));
    const description = removedSessionIds.size > 1 ? t("Der Verlauf inkl. {0} bearbeiteter Version(en) geht verloren.", removedSessionIds.size - 1) : t("Der Verlauf geht verloren.");
    // Files only this conversation uses: offered as an opt-in, never deleted by default.
    const exclusiveFiles = await api.listSessionExclusiveFiles(session.id).catch(() => []);
    const exclusiveBytes = exclusiveFiles.reduce((total, file) => total + file.size, 0);
    const confirmation = await confirmWithOption({
      title: t("Session „{0}“ löschen?", session.title),
      description,
      option: exclusiveFiles.length
        ? {
            label: t("Auch {0} dieser Session löschen ({1})", exclusiveFiles.length === 1 ? "die Datei" : `${exclusiveFiles.length} Dateien`, formatFileSize(exclusiveBytes)),
            hint: t("Anhänge und generierte Bilder, die keine andere Session und keine Design-Datei nutzt. Sonst bleiben sie im Projekt."),
          }
        : undefined,
    });
    if (!confirmation.confirmed) return;
    try {
      await api.deleteSession(session.id, confirmation.optionChecked);
      setSessionsByProjectId((previous) => ({
        ...previous,
        [session.projectId]: (previous[session.projectId] ?? []).filter((existing) => !removedSessionIds.has(existing.id)),
      }));
      if (activeSessionId && removedSessionIds.has(activeSessionId)) setActiveSessionId(null);
      toast.success(t("Session „{0}“ gelöscht", session.title));
    } catch (deletionError) {
      reportError(deletionError);
    }
  };

  /** Ensures a session exists, then sends — used by the composer and by "In Code übernehmen". */
  const sendToAgent = async (text: string, permissionMode: PermissionMode, model?: string, attachments?: Attachment[]) => {
    if (!activeProjectId) return;
    try {
      const targetSessionId = activeSessionId ?? (await createSession(activeProjectId))?.id;
      if (targetSessionId) await api.sendMessage(targetSessionId, text, permissionMode, model, attachments);
    } catch (sendError) {
      reportError(sendError);
    }
  };

  /** From the design systems screen: work in the linked session, or in a new session of the linked project. */
  const workOnDesignSystemWithAgent = async (target: DesignSystemLinkTarget, prompt: string, sendImmediately: boolean) => {
    let targetProjectId: string | undefined;
    let targetSessionId: string | undefined;
    if (target.targetType === "session") {
      targetSessionId = target.targetId;
      targetProjectId = Object.entries(sessionsByProjectId).find(([, sessions]) => sessions.some((session) => session.id === target.targetId))?.[0];
    } else {
      targetProjectId = target.targetId;
      targetSessionId = (await createSession(target.targetId))?.id;
    }
    if (!targetProjectId || !targetSessionId) return;
    openSessionFromScreen(targetProjectId, targetSessionId);
    if (sendImmediately) api.sendMessage(targetSessionId, prompt, "acceptEdits").catch(reportError);
    else setComposerInsertion({ text: prompt, nonce: Date.now() });
  };

  const openSessionFromScreen = (projectId: string, sessionId: string) => {
    setActiveProjectId(projectId);
    setActiveSessionId(sessionId);
    setExpandedProjectIds((previous) => new Set(previous).add(projectId));
    navigate("/");
  };

  const renderFeatureScreen = () => {
    switch (route.screen) {
      case "today":
        return (
          <TodayScreen
            projects={projects}
            environments={environments}
            permissionRequests={permissionRequests}
            runningSessionIds={runningSessionIds}
            sessionReferenceFor={sessionReferenceFor}
            reloadCounter={todayReloadCounter}
            onOpenSession={openSessionFromScreen}
            onAnswerPermission={(requestId, allow, answers) => api.answerPermission(requestId, allow, answers).catch(reportError)}
            onError={reportError}
          />
        );
      case "tasks":
        return (
          <TasksScreen
            selectedTaskId={route.itemId}
            onSelectTask={(taskId) => navigate(routePath("tasks", taskId))}
            tasks={tasks}
            projects={projects}
            inheritedModelFor={inheritedModelFor}
            teamForProject={teamForProject}
            channels={channels}
            defaultProjectId={activeProjectId}
            onOpenSession={openSessionFromScreen}
            onError={reportError}
          />
        );
      case "channels":
        return (
          <ChannelsScreen
            selectedChannelId={route.itemId}
            onSelectChannel={(channelId) => navigate(routePath("channels", channelId))}
            channels={channels}
            projects={projects}
            defaultProjectId={activeProjectId}
            onError={reportError}
          />
        );
      case "files":
        return (
          <FilesScreen
            environments={environments}
            onOpenSession={(projectId, sessionId) => {
              setActiveProjectId(projectId);
              setActiveSessionId(sessionId);
              setExpandedProjectIds((previous) => new Set(previous).add(projectId));
              navigate("/");
            }}
            onError={reportError}
            onInfo={(message) => toast.info(message)}
          />
        );
      case "memory": {
        const memoryProject = projects.find((project) => project.id === memoryProjectId) ?? activeProject;
        const memorySelection: MemorySelection =
          route.section === "new"
            ? "new"
            : (route.section === "workspace" || route.section === "environment" || route.section === "project") && route.itemId
              ? { scope: route.section, path: route.itemId }
              : null;
        return (
          <MemoryScreen
            project={memoryProject}
            environment={memoryProject ? (environments.find((environment) => environment.projectIds.includes(memoryProject.id)) ?? null) : null}
            projects={projects}
            onProjectChange={(projectId) => {
              setMemoryProjectId(projectId);
              navigate(routePath("memory"));
            }}
            selection={memorySelection}
            onSelect={(selection) =>
              navigate(selection === null ? routePath("memory") : selection === "new" ? routePath("memory", "new") : `${routePath("memory", selection.scope)}/${selection.path.split("/").map(encodeURIComponent).join("/")}`)
            }
            memoryChangeCounter={memoryChangeCounter}
            onOpenSettings={() => navigate(routePath("settings", "memory"))}
            onError={reportError}
          />
        );
      }
      case "integrations":
        return (
          <IntegrationsScreen
            project={activeProject}
            activeTab={route.section === "skills" || route.section === "plugins" ? route.section : "mcp"}
            selectedItemId={route.itemId}
            onNavigate={(tab: IntegrationsTab, itemId) => navigate(routePath("integrations", tab, itemId))}
            integrationsChangeCounter={integrationsChangeCounter}
            onError={reportError}
          />
        );
      case "design":
        return (
          <DesignSystemsScreen
            selection={route.itemId}
            onSelect={(selection) => navigate(routePath("design", selection))}
            projects={projects}
            sessionsByProjectId={sessionsByProjectId}
            designSystemsChangeCounter={designSystemsChangeCounter}
            onWorkWithAgent={(target, prompt, sendImmediately) => void workOnDesignSystemWithAgent(target, prompt, sendImmediately)}
            onError={reportError}
          />
        );
      case "team":
        return (
          <TeamScreen
            agents={teamAgents}
            environments={environments}
            selection={route.itemId}
            onSelect={(selection) => navigate(routePath("team", selection))}
            onTeamChange={() => void refreshTeam()}
            onError={reportError}
          />
        );
      case "environments":
        return (
          <EnvironmentsScreen
            selection={route.itemId}
            onSelect={(selection) => navigate(routePath("environments", selection))}
            environments={environments}
            workspaceDefaultModel={defaultModel}
            aiProviders={providers?.providers ?? []}
            codexModels={codexStatus?.models ?? []}
            projects={projects.filter((project) => project.kind !== "quick")}
            onEnvironmentsChange={() => void refreshEnvironments()}
            onOpenMemory={(environment) => {
              setMemoryProjectId(environment.projectIds[0]);
              navigate(`${routePath("memory", "environment")}/HARNOLD.md`);
            }}
            onError={reportError}
          />
        );
      case "settings":
        return (
          <SettingsScreen
            section={(settingsSectionNames.includes(route.section as SettingsSection) ? route.section : "claude") as SettingsSection}
            claudeStatus={claudeStatus}
            providers={providers}
            onProvidersChange={setProviders}
            backends={agentBackends}
            codex={codexStatus}
            onBackendsChange={setAgentBackends}
            onCodexChange={setCodexStatus}
            defaultModel={defaultModel}
            onDefaultModelChange={setDefaultModel}
            onClaudeStatusChange={setClaudeStatus}
            onSectionChange={(section) => navigate(routePath("settings", section))}
            themePreference={themePreference}
            onThemePreferenceChange={setThemePreference}
            voiceSettings={voiceSettings}
            onVoiceSettingsChange={setVoiceSettings}
            onError={reportError}
          />
        );
      default:
        return null;
    }
  };

  return (
    <TooltipProvider delayDuration={400}>
      <div className={cn("h-full", panelsAnimating && "panels-animating")}>
        <ResizablePanelGroup id="harnold-shell" orientation="horizontal" defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged}>
          <ResizablePanel id="sidebar" defaultSize={250} minSize={200} maxSize={380}>
            <AppSidebar
              projects={projects}
              sessionsByProjectId={sessionsByProjectId}
              expandedProjectIds={expandedProjectIds}
              onToggleProject={(projectId, expanded) => {
                setExpandedProjectIds((previous) => {
                  const next = new Set(previous);
                  if (expanded) next.add(projectId);
                  else next.delete(projectId);
                  return next;
                });
                if (expanded && projectId !== activeProjectId) {
                  setActiveProjectId(projectId);
                  setActiveSessionId(null);
                }
              }}
              activeSessionId={activeSessionId}
              sessionStatusFor={sessionStatusFor}
              onSelectSession={(projectId, sessionId) => {
                setActiveProjectId(projectId);
                setActiveSessionId(latestVersionId(sessionId, sessionsByProjectId[projectId] ?? []));
                navigate("/");
              }}
              onCreateSession={(projectId) => {
                navigate("/");
                void createSession(projectId);
              }}
              sessionActions={sessionActions}
              projectActions={projectActions}
              tasks={tasks}
              onOpenTask={(taskId) => navigate(routePath("tasks", taskId))}
              onRunTask={(taskId) => void api.runTask(taskId).catch(reportError)}
              onNewProject={() => setNewProjectDialogOpen(true)}
              onNewQuickChat={() => void createQuickChat()}
              activeScreen={route.screen}
              onOpenScreen={(screen) => navigate(screen === "workspace" ? "/" : routePath(screen))}
              darkMode={resolvedTheme === "dark"}
              onDarkModeChange={(darkMode) => setThemePreference(darkMode ? "dark" : "light")}
              environments={environments}
              activeEnvironmentId={activeEnvironmentId}
              onActiveEnvironmentChange={switchEnvironment}
              taskCount={tasks.length}
              waitingCount={permissionRequests.length}
              channelsStatus={
                channels.length === 0
                  ? null
                  : channels.some((channel) => channel.status.state === "error")
                    ? "error"
                    : channels.some((channel) => channel.status.state === "connected")
                      ? "running"
                      : channelStatusDot(channels[0])
              }
            />
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel id="main" minSize={480}>
            <div className="relative h-full">
              {/* Workspace stays mounted (canvas/editor state) and is hidden while a feature screen is open. */}
              <div className={cn("h-full", route.screen !== "workspace" && "invisible")} aria-hidden={route.screen !== "workspace"}>
                <ResizablePanelGroup id="harnold-main" orientation="horizontal" defaultLayout={mainDefaultLayout} onLayoutChanged={onMainLayoutChanged}>
          <ResizablePanel id="chat" defaultSize="42" minSize={360} className="relative">
            <ChatPane
              teamAgents={teamForProject(activeProjectId)}
              onSetAgent={(agentId) => activeSessionId && api.setSessionAgent(activeSessionId, agentId).catch(reportError)}
              project={activeProject}
              session={activeSession}
              status={activeSessionId ? sessionStatusFor(activeSessionId) : "idle"}
              chatItems={chatItems}
              streamingDraft={streamingDraft}
              streamingThinking={streamingThinking}
              projects={projects}
              environments={environments}
              onNewSession={() => activeProjectId && void createSession(activeProjectId)}
              onRenameSession={(title) => activeSessionId && api.updateSession(activeSessionId, { title }).catch(reportError)}
              onMoveSession={(projectId) =>
                activeSessionId &&
                api
                  .updateSession(activeSessionId, { projectId })
                  .then((moveResult) => moveResult.deferred && toast.info(t("Wird nach diesem Durchlauf verschoben")))
                  .catch(reportError)
              }
              onSetProjectEnvironment={(environmentId) =>
                activeProjectId && api.setProjectEnvironment(activeProjectId, environmentId).then(() => refreshEnvironments()).catch(reportError)
              }
              onClearSession={() => activeSessionId && api.clearSession(activeSessionId).catch(reportError)}
              permissionRequests={permissionRequests.filter((request) => request.sessionId === activeSessionId)}
              composerInsertion={composerInsertion}
              workspaceOpen={workspaceOpen}
              onOpenWorkspace={() => setWorkspaceVisibility(true)}
              onSend={sendToAgent}
              inheritedModel={inheritedModelFor(activeProjectId)}
              onInterrupt={() => activeSessionId && api.interrupt(activeSessionId).catch(reportError)}
              onAnswerPermission={(requestId, allow, answers) => api.answerPermission(requestId, allow, answers).catch(reportError)}
              onDeleteSession={() => activeSession && void deleteSession(activeSession)}
              projectSessions={activeProjectId ? (sessionsByProjectId[activeProjectId] ?? []) : []}
              onOpenVersion={setActiveSessionId}
              onEditMessage={(itemId, text) => void editMessage(itemId, text)}
              sttMode={voiceSettings?.sttProvider === "system" ? (systemSpeechAvailable() ? "system" : "off") : voiceSettings?.sttReady ? "server" : "off"}
              sttLanguage={voiceSettings?.language ?? "de"}
              ttsReady={voiceSettings?.ttsReady ?? false}
              onError={reportError}
              queuedMessages={queuedMessages}
              onSendQueuedNow={(queuedMessageId) => activeSessionId && api.sendQueuedNow(activeSessionId, queuedMessageId).catch(reportError)}
              onRemoveQueued={(queuedMessageId) => activeSessionId && api.removeQueued(activeSessionId, queuedMessageId).catch(reportError)}
              liveContextTokens={liveContextTokens}
            />
            <AppVersionBadge onOpenSettings={() => navigate(routePath("settings"))} />
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel
            id="workspace"
            panelRef={workspacePanelRef}
            minSize={380}
            collapsible
            collapsedSize={0}
            onResize={(panelSize) => setWorkspaceOpen(panelSize.inPixels > 0)}
          >
            {activeProject ? (
              <WorkspacePane
                key={activeProject.id}
                project={activeProject}
                resolvedTheme={resolvedTheme}
                fileChangeCounter={fileChangeCounter}
                lastChangedPaths={lastChangedPaths}
                onReferenceFile={(filePath) => setComposerInsertion({ text: `@${filePath} `, nonce: Date.now() })}
                onInsertIntoComposer={(text) => setComposerInsertion({ text, nonce: Date.now() })}
                onImplementDesign={(filePath) =>
                  sendToAgent(t("Setze den Entwurf @{0} im Projekt-Code um. Nutze vorhandene Struktur und das Design System.", filePath), "acceptEdits")
                }
                onClose={() => setWorkspaceVisibility(false)}
                onError={reportError}
              />
            ) : (
              <div className="h-full bg-canvas" />
            )}
          </ResizablePanel>
                </ResizablePanelGroup>
              </div>
              {route.screen !== "workspace" && (
                <div className="absolute inset-0 z-10">
                  {renderFeatureScreen()}
                  <AppVersionBadge onOpenSettings={() => navigate(routePath("settings"))} />
                </div>
              )}
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      {onboardingVisible && (
        <AgentOnboarding
          backends={agentBackends}
          codex={codexStatus}
          claudeStatus={claudeStatus}
          providers={providers}
          onBackendsChange={setAgentBackends}
          onCodexChange={setCodexStatus}
          onClaudeStatusChange={setClaudeStatus}
          onProvidersChange={setProviders}
          onError={reportError}
          onDismiss={() => setOnboardingVisible(false)}
        />
      )}
      <ConfirmDialogHost />
      <TextPromptDialogHost />
      <ProjectIconDialog
        target={iconDialogProject}
        onOpenChange={(open) => !open && setIconDialogProject(null)}
        onSave={(icon) => iconDialogProject && void updateProjectIcon(iconDialogProject, icon)}
      />
      <NewProjectDialog
        open={newProjectDialogOpen}
        onOpenChange={setNewProjectDialogOpen}
        onCreate={createProject}
        environmentName={environments.find((environment) => environment.id === activeEnvironmentId)?.name}
      />
      <Toaster />
    </TooltipProvider>
  );
}
