import { Blocks, Brain, FolderOpen, CalendarClock, Inbox, Check, ChevronRight, ChevronsUpDown, Layers, Mail, MessageSquarePlus, MessagesSquare, Moon, Palette, Play, Plus, Search, Settings, Sun, Users } from "lucide-react";
import { conversationRootId, conversationMembers } from "@/lib/session-versions";
import { Switch } from "@/components/ui/switch";
import type { Environment, Project, Session, Task } from "@/types";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { ScreenName } from "@/hooks/use-hash-route";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ProjectAvatar } from "@/components/project-avatar";
import { StatusDot, type SessionStatus } from "@/components/status-dot";
import { HarnoldLogo } from "@/components/harnold-logo";
import { ActionContextMenu, ActionMenuButton, type MenuAction } from "@/components/action-menu";
import { t } from "@/lib/i18n";
import { formatCombo, useShortcutBindings } from "@/lib/shortcuts";

type AppSidebarProps = {
  projects: Project[];
  sessionsByProjectId: Record<string, Session[]>;
  expandedProjectIds: Set<string>;
  onToggleProject: (projectId: string, expanded: boolean) => void;
  activeSessionId: string | null;
  sessionStatusFor: (sessionId: string) => SessionStatus;
  /** Opens a conversation (its top session; the app picks the last used version). */
  onSelectSession: (projectId: string, sessionId: string) => void;
  onCreateSession: (projectId: string) => void;
  /** Right-click / "…" menu of a conversation and of a project. */
  sessionActions: (session: Session) => MenuAction[];
  projectActions: (project: Project) => MenuAction[];
  /** Tasks: one row per task in its project (runs don't flood the session list). */
  tasks: Task[];
  onOpenTask: (taskId: string) => void;
  onRunTask: (taskId: string) => void;
  onNewProject: () => void;
  onNewQuickChat: () => void;
  onOpenSearch: () => void;
  activeScreen: ScreenName;
  onOpenScreen: (screen: ScreenName) => void;
  darkMode: boolean;
  taskCount: number;
  waitingCount: number;
  channelsStatus: SessionStatus | null;
  onDarkModeChange: (darkMode: boolean) => void;
  environments: Environment[];
  /** Environment id whose projects are shown, or null for all. */
  activeEnvironmentId: string | null;
  onActiveEnvironmentChange: (environmentId: string | null) => void;
};

export const featureScreens: { screen: ScreenName; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { screen: "today", label: t("Heute"), icon: Inbox },
  { screen: "tasks", label: t("Tasks"), icon: CalendarClock },
  { screen: "channels", label: t("Channels"), icon: MessagesSquare },
  { screen: "mail", label: t("Postfächer"), icon: Mail },
  { screen: "memory", label: t("Memory"), icon: Brain },
  { screen: "files", label: t("Dateien"), icon: FolderOpen },
  { screen: "integrations", label: t("Integrationen"), icon: Blocks },
  { screen: "design", label: t("Design Systems"), icon: Palette },
  { screen: "environments", label: t("Umgebungen"), icon: Layers },
  { screen: "team", label: t("Team"), icon: Users },
];

const activeRowClassName = "bg-foreground/[0.07] font-medium";

const rowClassName =
  "group/row flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors duration-150 hover:bg-foreground/5";

function HoverAction(props: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="button"
          tabIndex={0}
          aria-label={props.label}
          onClick={(clickEvent) => {
            clickEvent.stopPropagation();
            props.onClick();
          }}
          onKeyDown={(keyboardEvent) => {
            if (keyboardEvent.key === "Enter") {
              keyboardEvent.stopPropagation();
              props.onClick();
            }
          }}
          className="flex size-5 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 hover:bg-foreground/10 hover:text-foreground focus-visible:opacity-100"
        >
          {props.children}
        </span>
      </TooltipTrigger>
      <TooltipContent side="right">{props.label}</TooltipContent>
    </Tooltip>
  );
}

/** One click into another environment: shows its projects; their agent turns use its accounts. */
function EnvironmentSwitcher(props: Pick<AppSidebarProps, "environments" | "activeEnvironmentId" | "onActiveEnvironmentChange" | "onOpenScreen">) {
  const activeEnvironment = props.environments.find((environment) => environment.id === props.activeEnvironmentId) ?? null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={cn(rowClassName, "mb-1 h-8 border bg-background font-medium hover:bg-foreground/[0.04]")}>
        {activeEnvironment ? <ProjectAvatar name={activeEnvironment.name} icon={activeEnvironment.icon} /> : <Layers className="size-4 text-muted-foreground" />}
        <span className="truncate">{activeEnvironment?.name ?? t("Alle Umgebungen")}</span>
        <ChevronsUpDown className="ml-auto size-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width)">
        {[null, ...props.environments].map((environment) => (
          <DropdownMenuItem key={environment?.id ?? "all"} className="text-[13px]" onSelect={() => props.onActiveEnvironmentChange(environment?.id ?? null)}>
            {environment ? <ProjectAvatar name={environment.name} icon={environment.icon} /> : <Layers className="size-4" />}
            <span className="truncate">{environment?.name ?? t("Alle Umgebungen")}</span>
            {(environment?.id ?? null) === props.activeEnvironmentId && <Check className="ml-auto size-3.5" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-[13px] text-muted-foreground" onSelect={() => props.onOpenScreen("environments")}>
          <Settings className="size-4" /> {t("Umgebungen verwalten")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Status of a conversation: the most urgent state among its versions. */
function conversationStatus(members: Session[], sessionStatusFor: (sessionId: string) => SessionStatus): SessionStatus {
  const statuses = members.map((member) => sessionStatusFor(member.id));
  return (["waiting", "running", "error"] as const).find((status) => statuses.includes(status)) ?? "idle";
}

/** Conversations of one project; versions created by editing a message appear once. */
function ConversationList({ projectId, className, ...props }: AppSidebarProps & { projectId: string; className?: string }) {
  const projectSessions = props.sessionsByProjectId[projectId] ?? [];
  const conversations = projectSessions.filter((session) => !session.forkOriginSessionId && !session.taskId && !session.mailInboxId);
  const activeConversationId = props.activeSessionId ? conversationRootId(props.activeSessionId, projectSessions) : null;
  const projectTasks = props.tasks.filter((task) => task.projectId === projectId);
  return (
    <ul className={cn("space-y-0.5", className)}>
      {projectTasks.map((task) => (
        <TaskRow key={task.id} task={task} projectSessions={projectSessions} {...props} />
      ))}
      {conversations.map((session) => (
        <li key={session.id}>
          <ActionContextMenu actions={props.sessionActions(session)}>
            <button
              className={cn(rowClassName, props.activeScreen === "workspace" && session.id === activeConversationId && activeRowClassName)}
              onClick={() => props.onSelectSession(projectId, session.id)}
            >
              <StatusDot status={conversationStatus(conversationMembers(session.id, projectSessions), props.sessionStatusFor)} className="mx-1" />
              <span className="truncate">{session.title}</span>
              <span className="ml-auto flex">
                <ActionMenuButton label={t("Aktionen")} actions={props.sessionActions(session)} />
              </span>
            </button>
          </ActionContextMenu>
        </li>
      ))}
    </ul>
  );
}

/** A task in the session list: opens its latest run; status of the running or last run. */
function TaskRow({ task, projectSessions, ...props }: AppSidebarProps & { task: Task; projectSessions: Session[] }) {
  const taskSessions = projectSessions.filter((session) => session.taskId === task.id).sort((first, second) => second.updatedAt - first.updatedAt);
  const latestSession = taskSessions[0];
  const running = taskSessions.some((session) => props.sessionStatusFor(session.id) === "running");
  const status: SessionStatus = running ? "running" : task.lastRun?.status === "error" ? "error" : "idle";
  const active = props.activeScreen === "workspace" && taskSessions.some((session) => session.id === props.activeSessionId);
  const actions: MenuAction[] = [
    { label: t("Letzten Lauf öffnen"), icon: MessagesSquare, onSelect: () => latestSession && props.onSelectSession(task.projectId, latestSession.id), hidden: !latestSession },
    { label: t("Task bearbeiten"), icon: CalendarClock, onSelect: () => props.onOpenTask(task.id) },
    { label: t("Jetzt ausführen"), icon: Play, onSelect: () => props.onRunTask(task.id), hidden: running },
  ];
  return (
    <li>
      <ActionContextMenu actions={actions}>
        <button
          className={cn(rowClassName, active && activeRowClassName, !task.enabled && "opacity-60")}
          title={t("Task · {0} Läufe", taskSessions.length)}
          onClick={() => (latestSession ? props.onSelectSession(task.projectId, latestSession.id) : props.onOpenTask(task.id))}
        >
          <CalendarClock className="mx-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{task.name}</span>
          <span className="ml-auto flex items-center gap-1">
            <StatusDot status={status} />
            <ActionMenuButton label={t("Aktionen")} actions={actions} />
          </span>
        </button>
      </ActionContextMenu>
    </li>
  );
}

function ProjectTreeItem({ project, ...props }: AppSidebarProps & { project: Project }) {
  const expanded = props.expandedProjectIds.has(project.id);
  const hasSessions = (props.sessionsByProjectId[project.id] ?? []).length > 0;
  return (
    <li>
      <Collapsible open={expanded} onOpenChange={(open) => props.onToggleProject(project.id, open)}>
        <ActionContextMenu actions={props.projectActions(project)}>
          <CollapsibleTrigger className={cn(rowClassName, "font-medium")} title={project.path}>
            <ProjectAvatar name={project.name} icon={project.icon} />
            <span className="truncate">{project.name}</span>
            <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform duration-200", expanded && "rotate-90")} />
            <span className="ml-auto flex items-center gap-0.5">
              <ActionMenuButton label={t("Projekt-Aktionen")} actions={props.projectActions(project)} />
              <HoverAction label={t("Neue Session")} onClick={() => props.onCreateSession(project.id)}>
                <Plus className="size-3.5" />
              </HoverAction>
            </span>
          </CollapsibleTrigger>
        </ActionContextMenu>
        <CollapsibleContent className="collapsible-animated">
          {hasSessions ? (
            <ConversationList projectId={project.id} className="py-0.5 pl-3" {...props} />
          ) : (
            <div className="py-0.5 pl-3">
              <button className={cn(rowClassName, "text-muted-foreground")} onClick={() => props.onCreateSession(project.id)}>
                <Plus className="size-3.5" /> {t("Neue Session")}
              </button>
            </div>
          )}
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

function SectionHeader(props: { label: string; actionLabel: string; onAction: () => void }) {
  return (
    <div className="flex items-center justify-between px-2 pt-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
      {props.label}
      <Tooltip>
        <TooltipTrigger asChild>
          <button aria-label={props.actionLabel} onClick={props.onAction} className="flex size-5 items-center justify-center rounded transition-colors hover:bg-foreground/10 hover:text-foreground">
            <Plus className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">{props.actionLabel}</TooltipContent>
      </Tooltip>
    </div>
  );
}

export function AppSidebar(props: AppSidebarProps) {
  const shortcutBindings = useShortcutBindings();
  const activeEnvironment = props.environments.find((environment) => environment.id === props.activeEnvironmentId) ?? null;
  const quickChatProject = props.projects.find((project) => project.kind === "quick") ?? null;
  const regularProjects = props.projects.filter((project) => project.kind !== "quick");
  const visibleProjects = activeEnvironment ? regularProjects.filter((project) => activeEnvironment.projectIds.includes(project.id)) : regularProjects;
  const hasQuickChats = Boolean(quickChatProject && (props.sessionsByProjectId[quickChatProject.id] ?? []).length > 0);
  return (
    <aside className="flex h-full flex-col bg-sidebar">
      <div className="flex h-12 shrink-0 items-center px-4">
        <HarnoldLogo className="h-[18px]" />
      </div>

      <nav className="space-y-0.5 px-2 pb-2">
        <button
          className="mb-1.5 flex h-8 w-full items-center gap-2 rounded-md bg-primary px-2.5 text-[13px] font-medium text-primary-foreground shadow-xs transition-colors duration-150 hover:bg-primary/90 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          onClick={props.onNewQuickChat}
        >
          <MessageSquarePlus className="size-4" />
          {t("Quick Chat")}
        </button>
        <button className={cn(rowClassName, "mb-1 text-muted-foreground")} onClick={props.onOpenSearch}>
          <Search className="size-4" />
          {t("Suchen")}
          <kbd className="ml-auto font-sans text-[11.5px]">{formatCombo(shortcutBindings.search)}</kbd>
        </button>
        {featureScreens.map(({ screen, label, icon: ScreenIcon }) => (
          <button key={screen} className={cn(rowClassName, props.activeScreen === screen && activeRowClassName)} onClick={() => props.onOpenScreen(screen)}>
            <ScreenIcon className="size-4 text-muted-foreground" />
            {label}
            {screen === "today" && props.waitingCount > 0 && (
              <span className="ml-auto rounded-full bg-status-waiting px-1.5 text-[11px] leading-4 font-medium text-white tabular-nums">{props.waitingCount}</span>
            )}
            {screen === "tasks" && props.taskCount > 0 && <span className="ml-auto text-[11.5px] text-muted-foreground tabular-nums">{props.taskCount}</span>}
            {screen === "channels" && props.channelsStatus && <StatusDot status={props.channelsStatus} className="mr-1 ml-auto" />}
          </button>
        ))}
      </nav>

      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {props.environments.length > 0 && (
          <EnvironmentSwitcher
            environments={props.environments}
            activeEnvironmentId={props.activeEnvironmentId}
            onActiveEnvironmentChange={props.onActiveEnvironmentChange}
            onOpenScreen={props.onOpenScreen}
          />
        )}
        <SectionHeader label={t("Projekte")} actionLabel={t("Neues Projekt")} onAction={props.onNewProject} />

        {visibleProjects.length === 0 && (
          <p className="px-2 py-1 text-[13px] text-muted-foreground">{activeEnvironment ? t("Noch keine Projekte in {0}.", activeEnvironment.name) : t("Noch keine Projekte.")}</p>
        )}

        <ul className="space-y-0.5">
          {visibleProjects.map((project) => (
            <ProjectTreeItem key={project.id} project={project} {...props} />
          ))}
        </ul>

        {quickChatProject && hasQuickChats && (
          <div className="mt-3">
            <SectionHeader label={t("Quick Chats")} actionLabel={t("Neuer Quick Chat")} onAction={props.onNewQuickChat} />
            <ConversationList projectId={quickChatProject.id} {...props} />
          </div>
        )}
      </div>

      <div className="flex items-center gap-1 border-t p-2">
        <button
          className={cn(rowClassName, props.activeScreen === "settings" ? activeRowClassName : "text-muted-foreground hover:text-foreground")}
          onClick={() => props.onOpenScreen("settings")}
        >
          <Settings className="size-4" /> {t("Einstellungen")}
        </button>
        <label className="flex shrink-0 items-center gap-1.5 px-1 text-muted-foreground" title={t("Hell / Dunkel")}>
          <Sun className={cn("size-3.5 transition-opacity duration-200", props.darkMode && "opacity-40")} />
          <Switch checked={props.darkMode} onCheckedChange={props.onDarkModeChange} aria-label={t("Dunkler Modus")} />
          <Moon className={cn("size-3.5 transition-opacity duration-200", !props.darkMode && "opacity-40")} />
        </label>
      </div>
    </aside>
  );
}
