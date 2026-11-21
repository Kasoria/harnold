import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDefaultLayout, usePanelRef } from "react-resizable-panels";
import { api, connectEvents } from "@/api";
import type { Channel, ChatItem, PermissionMode, PermissionRequest, Project, ServerEvent, Session, Task, VoiceSettingsView } from "@/types";
import { cn } from "@/lib/utils";
import { safeStorage } from "@/lib/storage";
import { useTheme } from "@/hooks/use-theme";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppSidebar } from "@/components/app-sidebar";
import { ChatPane } from "@/components/chat/chat-pane";
import { WorkspacePane } from "@/components/workspace/workspace-pane";
import { NewProjectDialog } from "@/components/new-project-dialog";
import { SettingsDialog } from "@/components/settings-dialog";
import type { SessionStatus } from "@/components/status-dot";
import { TasksSheet } from "@/components/tasks/tasks-sheet";
import { MemorySheet } from "@/components/memory/memory-sheet";
import { IntegrationsSheet } from "@/components/integrations/integrations-sheet";
import { ChannelsSheet, channelStatusDot } from "@/components/channels/channels-sheet";
import { Button } from "@/components/ui/button";

type Toast = { message: string; tone: "error" | "info"; action?: { label: string; run: () => void } };

const panelAnimationMs = 260;

export function App() {
  const { themePreference, setThemePreference, resolvedTheme } = useTheme();

  const [projects, setProjects] = useState<Project[]>([]);
  const [sessionsByProjectId, setSessionsByProjectId] = useState<Record<string, Session[]>>({});
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(new Set());
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [chatItems, setChatItems] = useState<ChatItem[]>([]);
  const [streamingDraft, setStreamingDraft] = useState("");
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(new Set());
  const [permissionRequests, setPermissionRequests] = useState<PermissionRequest[]>([]);
  const [fileChangeCounter, setFileChangeCounter] = useState(0);
  const [lastChangedPaths, setLastChangedPaths] = useState<string[]>([]);
  const [composerInsertion, setComposerInsertion] = useState<{ text: string; nonce: number } | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [tasksSheetOpen, setTasksSheetOpen] = useState(false);
  const [channelsSheetOpen, setChannelsSheetOpen] = useState(false);
  const [memorySheetOpen, setMemorySheetOpen] = useState(false);
  const [memoryChangeCounter, setMemoryChangeCounter] = useState(0);
  const [integrationsSheetOpen, setIntegrationsSheetOpen] = useState(false);
  const [integrationsChangeCounter, setIntegrationsChangeCounter] = useState(0);
  const [newProjectDialogOpen, setNewProjectDialogOpen] = useState(false);
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const [voiceSettings, setVoiceSettings] = useState<VoiceSettingsView | null>(null);
  const [workspaceOpen, setWorkspaceOpen] = useState(true);
  const [panelsAnimating, setPanelsAnimating] = useState(false);

  const workspacePanelRef = usePanelRef();
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: "harnold-shell", storage: safeStorage });

  const activeIdsRef = useRef({ activeProjectId, activeSessionId });
  activeIdsRef.current = { activeProjectId, activeSessionId };

  const reportError = useCallback((unknownError: unknown) => {
    setToast({ message: unknownError instanceof Error ? unknownError.message : String(unknownError), tone: "error" });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const dismissTimer = window.setTimeout(() => setToast(null), 7000);
    return () => window.clearTimeout(dismissTimer);
  }, [toast]);

  const refreshTasks = useCallback(() => api.listTasks().then(setTasks).catch(reportError), [reportError]);
  const refreshChannels = useCallback(() => api.listChannels().then(setChannels).catch(reportError), [reportError]);

  useEffect(() => {
    void refreshTasks();
    void refreshChannels();
    api.readVoiceSettings().then(setVoiceSettings).catch(reportError);
  }, [refreshTasks, refreshChannels]);

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
        const firstProject = loadedProjects[0];
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
    if (activeSessionId) api.listChatItems(activeSessionId).then(setChatItems).catch(reportError);
  }, [activeSessionId, reportError]);

  useEffect(
    () =>
      connectEvents((serverEvent: ServerEvent) => {
        const { activeProjectId: currentProjectId, activeSessionId: currentSessionId } = activeIdsRef.current;
        switch (serverEvent.type) {
          case "chat_item":
            if (serverEvent.sessionId !== currentSessionId) return;
            if (serverEvent.chatItem.kind === "assistant_text") setStreamingDraft("");
            setChatItems((previous) => [...previous, serverEvent.chatItem]);
            return;
          case "text_delta":
            if (serverEvent.sessionId === currentSessionId) setStreamingDraft((previous) => previous + serverEvent.text);
            return;
          case "turn_state":
            setRunningSessionIds((previous) => {
              const next = new Set(previous);
              if (serverEvent.running) next.add(serverEvent.sessionId);
              else next.delete(serverEvent.sessionId);
              return next;
            });
            if (!serverEvent.running && serverEvent.sessionId === currentSessionId) setStreamingDraft("");
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
          case "task_run_finished":
            setToast({
              message: `Task „${serverEvent.taskName}“ ${serverEvent.success ? "fertig" : "fehlgeschlagen"}`,
              tone: serverEvent.success ? "info" : "error",
              action: {
                label: "Öffnen",
                run: () => {
                  setActiveProjectId(serverEvent.projectId);
                  setActiveSessionId(serverEvent.sessionId);
                  setExpandedProjectIds((previous) => new Set(previous).add(serverEvent.projectId));
                },
              },
            });
            return;
        }
      }),
    [refreshSessions, refreshTasks, refreshChannels],
  );

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
      const project = await api.createProject(name, projectPath);
      setProjects((previous) => [project, ...previous]);
      setSessionsByProjectId((previous) => ({ ...previous, [project.id]: [] }));
      setExpandedProjectIds((previous) => new Set(previous).add(project.id));
      setActiveProjectId(project.id);
      setActiveSessionId(null);
    } catch (creationError) {
      reportError(creationError);
    }
  };

  const createSession = async (projectId: string): Promise<Session | null> => {
    try {
      const session = await api.createSession(projectId);
      setSessionsByProjectId((previous) => ({ ...previous, [projectId]: [session, ...(previous[projectId] ?? [])] }));
      setExpandedProjectIds((previous) => new Set(previous).add(projectId));
      setActiveProjectId(projectId);
      setActiveSessionId(session.id);
      return session;
    } catch (creationError) {
      reportError(creationError);
      return null;
    }
  };

  const deleteSession = async (session: Session) => {
    try {
      await api.deleteSession(session.id);
      setSessionsByProjectId((previous) => ({
        ...previous,
        [session.projectId]: (previous[session.projectId] ?? []).filter((existing) => existing.id !== session.id),
      }));
      if (session.id === activeSessionId) setActiveSessionId(null);
    } catch (deletionError) {
      reportError(deletionError);
    }
  };

  /** Ensures a session exists, then sends — used by the composer and by "In Code übernehmen". */
  const sendToAgent = async (text: string, permissionMode: PermissionMode, model?: string) => {
    if (!activeProjectId) return;
    try {
      const targetSessionId = activeSessionId ?? (await createSession(activeProjectId))?.id;
      if (targetSessionId) await api.sendMessage(targetSessionId, text, permissionMode, model);
    } catch (sendError) {
      reportError(sendError);
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
                setActiveSessionId(sessionId);
              }}
              onCreateSession={(projectId) => void createSession(projectId)}
              onDeleteSession={deleteSession}
              onNewProject={() => setNewProjectDialogOpen(true)}
              onOpenSettings={() => setSettingsDialogOpen(true)}
              darkMode={resolvedTheme === "dark"}
              onDarkModeChange={(darkMode) => setThemePreference(darkMode ? "dark" : "light")}
              taskCount={tasks.length}
              channelsStatus={
                channels.length === 0
                  ? null
                  : channels.some((channel) => channel.status.state === "error")
                    ? "error"
                    : channels.some((channel) => channel.status.state === "connected")
                      ? "running"
                      : channelStatusDot(channels[0])
              }
              onOpenTasks={() => setTasksSheetOpen(true)}
              onOpenChannels={() => setChannelsSheetOpen(true)}
              onOpenMemory={() => setMemorySheetOpen(true)}
              onOpenIntegrations={() => setIntegrationsSheetOpen(true)}
            />
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel id="chat" defaultSize="38" minSize={360}>
            <ChatPane
              project={activeProject}
              session={activeSession}
              status={activeSessionId ? sessionStatusFor(activeSessionId) : "idle"}
              chatItems={chatItems}
              streamingDraft={streamingDraft}
              permissionRequests={permissionRequests.filter((request) => request.sessionId === activeSessionId)}
              composerInsertion={composerInsertion}
              workspaceOpen={workspaceOpen}
              onOpenWorkspace={() => setWorkspaceVisibility(true)}
              onSend={sendToAgent}
              onInterrupt={() => activeSessionId && api.interrupt(activeSessionId).catch(reportError)}
              onAnswerPermission={(requestId, allow) => api.answerPermission(requestId, allow).catch(reportError)}
              onDeleteSession={() => activeSession && void deleteSession(activeSession)}
              sttReady={voiceSettings?.sttReady ?? false}
              ttsReady={voiceSettings?.ttsReady ?? false}
              onError={reportError}
            />
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
                  sendToAgent(`Setze den Entwurf @${filePath} im Projekt-Code um. Nutze vorhandene Struktur und das Design System.`, "acceptEdits")
                }
                onAskAgent={(prompt) => sendToAgent(prompt, "acceptEdits")}
                onClose={() => setWorkspaceVisibility(false)}
                onError={reportError}
              />
            ) : (
              <div className="h-full bg-canvas" />
            )}
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      <NewProjectDialog open={newProjectDialogOpen} onOpenChange={setNewProjectDialogOpen} onCreate={createProject} />
      <SettingsDialog
        open={settingsDialogOpen}
        onOpenChange={setSettingsDialogOpen}
        themePreference={themePreference}
        onThemePreferenceChange={setThemePreference}
        voiceSettings={voiceSettings}
        onVoiceSettingsChange={setVoiceSettings}
        onError={reportError}
      />

      <TasksSheet
        open={tasksSheetOpen}
        onOpenChange={setTasksSheetOpen}
        tasks={tasks}
        projects={projects}
        channels={channels}
        defaultProjectId={activeProjectId}
        onOpenSession={(projectId, sessionId) => {
          setActiveProjectId(projectId);
          setActiveSessionId(sessionId);
          setExpandedProjectIds((previous) => new Set(previous).add(projectId));
          setTasksSheetOpen(false);
        }}
        onError={reportError}
      />
      <MemorySheet
        open={memorySheetOpen}
        onOpenChange={setMemorySheetOpen}
        project={activeProject}
        memoryChangeCounter={memoryChangeCounter}
        onError={reportError}
      />
      <IntegrationsSheet
        open={integrationsSheetOpen}
        onOpenChange={setIntegrationsSheetOpen}
        project={activeProject}
        integrationsChangeCounter={integrationsChangeCounter}
        onError={reportError}
      />
      <ChannelsSheet
        open={channelsSheetOpen}
        onOpenChange={setChannelsSheetOpen}
        channels={channels}
        projects={projects}
        defaultProjectId={activeProjectId}
        onError={reportError}
      />

      {toast && (
        <div
          key={toast.message}
          role={toast.tone === "error" ? "alert" : "status"}
          className={cn(
            "fixed right-4 bottom-4 z-50 flex max-w-sm animate-in items-center gap-3 rounded-lg border bg-popover px-4 py-3 text-[13px] shadow-lg fade-in slide-in-from-bottom-2 duration-200",
            toast.tone === "error" ? "text-destructive" : "text-foreground",
          )}
        >
          <span className="cursor-pointer" onClick={() => setToast(null)}>
            {toast.message}
          </span>
          {toast.action && (
            <Button
              size="sm"
              variant="secondary"
              className="h-7"
              onClick={() => {
                toast.action!.run();
                setToast(null);
              }}
            >
              {toast.action.label}
            </Button>
          )}
        </div>
      )}
    </TooltipProvider>
  );
}
