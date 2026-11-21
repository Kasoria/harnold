import { Blocks, Brain, CalendarClock, ChevronRight, MessagesSquare, Moon, Plus, Settings, Sun, Trash2 } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import type { Project, Session } from "@/types";
import { cn } from "@/lib/utils";
import type { ScreenName } from "@/hooks/use-hash-route";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ProjectAvatar } from "@/components/project-avatar";
import { StatusDot, type SessionStatus } from "@/components/status-dot";

type AppSidebarProps = {
  projects: Project[];
  sessionsByProjectId: Record<string, Session[]>;
  expandedProjectIds: Set<string>;
  onToggleProject: (projectId: string, expanded: boolean) => void;
  activeSessionId: string | null;
  sessionStatusFor: (sessionId: string) => SessionStatus;
  onSelectSession: (projectId: string, sessionId: string) => void;
  onCreateSession: (projectId: string) => void;
  onDeleteSession: (session: Session) => void;
  onNewProject: () => void;
  activeScreen: ScreenName;
  onOpenScreen: (screen: ScreenName) => void;
  darkMode: boolean;
  taskCount: number;
  channelsStatus: SessionStatus | null;
  onDarkModeChange: (darkMode: boolean) => void;
};

const featureScreens: { screen: ScreenName; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { screen: "tasks", label: "Tasks", icon: CalendarClock },
  { screen: "channels", label: "Channels", icon: MessagesSquare },
  { screen: "memory", label: "Memory", icon: Brain },
  { screen: "integrations", label: "Integrationen", icon: Blocks },
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
          className="ml-auto flex size-5 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 hover:bg-foreground/10 hover:text-foreground focus-visible:opacity-100"
        >
          {props.children}
        </span>
      </TooltipTrigger>
      <TooltipContent side="right">{props.label}</TooltipContent>
    </Tooltip>
  );
}

export function AppSidebar(props: AppSidebarProps) {
  return (
    <aside className="flex h-full flex-col bg-sidebar">
      <div className="flex h-12 shrink-0 items-center px-4 text-[15px] font-semibold tracking-tight">Harnold</div>

      <nav className="space-y-0.5 px-2 pb-2">
        {featureScreens.map(({ screen, label, icon: ScreenIcon }) => (
          <button key={screen} className={cn(rowClassName, props.activeScreen === screen && activeRowClassName)} onClick={() => props.onOpenScreen(screen)}>
            <ScreenIcon className="size-4 text-muted-foreground" />
            {label}
            {screen === "tasks" && props.taskCount > 0 && <span className="ml-auto text-[11.5px] text-muted-foreground tabular-nums">{props.taskCount}</span>}
            {screen === "channels" && props.channelsStatus && <StatusDot status={props.channelsStatus} className="mr-1 ml-auto" />}
          </button>
        ))}
      </nav>

      <div className="flex-1 overflow-y-auto px-2 pb-2">
        <div className="flex items-center justify-between px-2 pt-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          Projekte
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                aria-label="Neues Projekt"
                onClick={props.onNewProject}
                className="flex size-5 items-center justify-center rounded transition-colors hover:bg-foreground/10 hover:text-foreground"
              >
                <Plus className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">Neues Projekt</TooltipContent>
          </Tooltip>
        </div>

        {props.projects.length === 0 && <p className="px-2 py-1 text-[13px] text-muted-foreground">Noch keine Projekte.</p>}

        <ul className="space-y-0.5">
          {props.projects.map((project) => {
            const expanded = props.expandedProjectIds.has(project.id);
            const projectSessions = props.sessionsByProjectId[project.id] ?? [];
            return (
              <li key={project.id}>
                <Collapsible open={expanded} onOpenChange={(open) => props.onToggleProject(project.id, open)}>
                  <CollapsibleTrigger className={cn(rowClassName, "font-medium")} title={project.path}>
                    <ProjectAvatar name={project.name} />
                    <span className="truncate">{project.name}</span>
                    <ChevronRight
                      className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform duration-200", expanded && "rotate-90")}
                    />
                    <HoverAction label="Neue Session" onClick={() => props.onCreateSession(project.id)}>
                      <Plus className="size-3.5" />
                    </HoverAction>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="collapsible-animated">
                    <ul className="space-y-0.5 py-0.5 pl-3">
                      {projectSessions.length === 0 && (
                        <li>
                          <button className={cn(rowClassName, "text-muted-foreground")} onClick={() => props.onCreateSession(project.id)}>
                            <Plus className="size-3.5" /> Neue Session
                          </button>
                        </li>
                      )}
                      {projectSessions.map((session) => (
                        <li key={session.id}>
                          <button
                            className={cn(rowClassName, props.activeScreen === "workspace" && session.id === props.activeSessionId && activeRowClassName)}
                            onClick={() => props.onSelectSession(project.id, session.id)}
                          >
                            <StatusDot status={props.sessionStatusFor(session.id)} className="mx-1" />
                            <span className="truncate">{session.title}</span>
                            <HoverAction label="Session löschen" onClick={() => props.onDeleteSession(session)}>
                              <Trash2 className="size-3.5" />
                            </HoverAction>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </CollapsibleContent>
                </Collapsible>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="flex items-center gap-1 border-t p-2">
        <button
          className={cn(rowClassName, props.activeScreen === "settings" ? activeRowClassName : "text-muted-foreground hover:text-foreground")}
          onClick={() => props.onOpenScreen("settings")}
        >
          <Settings className="size-4" /> Einstellungen
        </button>
        <label className="flex shrink-0 items-center gap-1.5 px-1 text-muted-foreground" title="Hell / Dunkel">
          <Sun className={cn("size-3.5 transition-opacity duration-200", props.darkMode && "opacity-40")} />
          <Switch checked={props.darkMode} onCheckedChange={props.onDarkModeChange} aria-label="Dunkler Modus" />
          <Moon className={cn("size-3.5 transition-opacity duration-200", !props.darkMode && "opacity-40")} />
        </label>
      </div>
    </aside>
  );
}
