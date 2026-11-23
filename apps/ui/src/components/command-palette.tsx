import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Brain, CalendarClock, CornerDownLeft, FileText, Layers, MessageSquare, MessagesSquare, Mail, Search, User } from "lucide-react";
import { api } from "@/api";
import type { Channel, Environment, MailInbox, MemorySearchHit, Project, Session, Task, TeamAgent } from "@/types";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { ProjectAvatar } from "@/components/project-avatar";

export type PaletteCommand = {
  id: string;
  group: string;
  label: string;
  /** Secondary text right of the label (project name, schedule …). */
  detail?: string;
  /** Extra words that match but are not shown. */
  keywords?: string;
  icon?: React.ComponentType<{ className?: string }>;
  avatar?: { name: string; icon: string | null };
  /** Shortcut hint shown at the end of the row. */
  shortcut?: string;
  run: () => void;
};

type CommandPaletteProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Static commands (screens, actions). */
  commands: PaletteCommand[];
  projects: Project[];
  sessionsByProjectId: Record<string, Session[]>;
  tasks: Task[];
  channels: Channel[];
  inboxes: MailInbox[];
  teamAgents: TeamAgent[];
  environments: Environment[];
  activeProjectId: string | null;
  onOpenProject: (projectId: string) => void;
  onOpenSession: (projectId: string, sessionId: string) => void;
  onOpenTask: (taskId: string) => void;
  onOpenChannel: (channelId: string) => void;
  onOpenInbox: (inboxId: string) => void;
  onOpenTeamAgent: (agentId: string) => void;
  onOpenEnvironment: (environmentId: string) => void;
  onOpenMemoryNote: (hit: MemorySearchHit) => void;
};

const maxResultsPerGroup = 6;
const memorySearchDelayMs = 200;

/** Case- and accent-insensitive "all words appear" match; returns a rank (lower = better) or null. */
function matchRank(searchWords: string[], label: string, extra: string): number | null {
  const normalizedLabel = label.toLowerCase();
  const haystack = `${normalizedLabel} ${extra.toLowerCase()}`;
  let rank = 0;
  for (const searchWord of searchWords) {
    const labelIndex = normalizedLabel.indexOf(searchWord);
    if (labelIndex === 0) rank += 0;
    else if (labelIndex > 0) rank += normalizedLabel[labelIndex - 1] === " " ? 1 : 2;
    else if (haystack.includes(searchWord)) rank += 4;
    else return null;
  }
  return rank;
}

/** Global search and command center (⌘K): jump to anything in Harnold or run an action. */
export function CommandPalette(props: CommandPaletteProps) {
  const { open, onOpenChange, commands, projects, sessionsByProjectId, tasks, channels, inboxes, teamAgents, environments, activeProjectId } = props;
  const [query, setQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [memoryHits, setMemoryHits] = useState<MemorySearchHit[]>([]);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setHighlightedIndex(0);
    setMemoryHits([]);
  }, [open]);

  // Memory runs on the core (full text, optionally embeddings): debounced, only with at least 2 characters.
  useEffect(() => {
    const trimmedQuery = query.trim();
    if (!open || trimmedQuery.length < 2) {
      setMemoryHits([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api
        .searchMemory(trimmedQuery, activeProjectId)
        .then((hits) => !cancelled && setMemoryHits(hits.slice(0, maxResultsPerGroup)))
        .catch(() => !cancelled && setMemoryHits([]));
    }, memorySearchDelayMs);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, open, activeProjectId]);

  const projectNameById = useMemo(() => new Map(projects.map((project) => [project.id, project.name])), [projects]);

  const results = useMemo(() => {
    const searchWords = query.toLowerCase().split(/\s+/).filter(Boolean);
    const searching = searchWords.length > 0;
    const groups: { title: string; items: PaletteCommand[] }[] = [];
    const addGroup = (title: string, candidates: { command: PaletteCommand; extra: string }[], limit = maxResultsPerGroup) => {
      const ranked = candidates
        .map(({ command, extra }) => ({ command, rank: searching ? matchRank(searchWords, command.label, `${command.detail ?? ""} ${command.keywords ?? ""} ${extra}`) : 0 }))
        .filter((entry): entry is { command: PaletteCommand; rank: number } => entry.rank !== null)
        .sort((first, second) => first.rank - second.rank);
      if (ranked.length) groups.push({ title, items: ranked.slice(0, limit).map((entry) => entry.command) });
    };

    // Static commands keep their own group names (Navigation, Aktionen).
    for (const groupTitle of [...new Set(commands.map((command) => command.group))]) {
      addGroup(groupTitle, commands.filter((command) => command.group === groupTitle).map((command) => ({ command, extra: "" })), 20);
    }
    // Entities only show up while searching – an empty palette stays short.
    if (!searching) return groups;

    addGroup(
      t("Projekte"),
      projects
        .filter((project) => project.kind !== "quick")
        .map((project) => ({
          command: { id: `project:${project.id}`, group: t("Projekte"), label: project.name, detail: project.path, avatar: { name: project.name, icon: project.icon }, run: () => props.onOpenProject(project.id) },
          extra: "",
        })),
    );
    addGroup(
      t("Sessions"),
      Object.values(sessionsByProjectId)
        .flat()
        // Edited versions are shown through their conversation's top session in the sidebar.
        .filter((session) => !session.forkOriginSessionId)
        .map((session) => ({
          command: { id: `session:${session.id}`, group: t("Sessions"), label: session.title, detail: projectNameById.get(session.projectId), icon: MessageSquare, run: () => props.onOpenSession(session.projectId, session.id) },
          extra: "",
        })),
    );
    addGroup(
      t("Tasks"),
      tasks.map((task) => ({
        command: { id: `task:${task.id}`, group: t("Tasks"), label: task.name, detail: projectNameById.get(task.projectId), icon: CalendarClock, run: () => props.onOpenTask(task.id) },
        extra: task.prompt,
      })),
    );
    addGroup(
      t("Channels"),
      channels.map((channel) => ({ command: { id: `channel:${channel.id}`, group: t("Channels"), label: channel.name, detail: channel.type, icon: MessagesSquare, run: () => props.onOpenChannel(channel.id) }, extra: "" })),
    );
    addGroup(
      t("Postfächer"),
      inboxes.map((inbox) => ({ command: { id: `inbox:${inbox.id}`, group: t("Postfächer"), label: inbox.name, icon: Mail, run: () => props.onOpenInbox(inbox.id) }, extra: "" })),
    );
    addGroup(
      t("Team"),
      teamAgents.map((agent) => ({ command: { id: `agent:${agent.id}`, group: t("Team"), label: agent.name, detail: agent.role, icon: User, run: () => props.onOpenTeamAgent(agent.id) }, extra: "" })),
    );
    addGroup(
      t("Umgebungen"),
      environments.map((environment) => ({
        command: { id: `environment:${environment.id}`, group: t("Umgebungen"), label: environment.name, avatar: { name: environment.name, icon: environment.icon }, icon: Layers, run: () => props.onOpenEnvironment(environment.id) },
        extra: "",
      })),
    );
    if (memoryHits.length) {
      groups.push({
        title: t("Memory"),
        items: memoryHits.map((hit) => ({
          id: `memory:${hit.scope}:${hit.projectId}:${hit.path}`,
          group: t("Memory"),
          label: hit.title || hit.path,
          detail: hit.snippet.replace(/\s+/g, " ").trim().slice(0, 80) || hit.path,
          icon: hit.path.endsWith("HARNOLD.md") ? Brain : FileText,
          run: () => props.onOpenMemoryNote(hit),
        })),
      });
    }
    return groups;
    // props.* callbacks are recreated each render; the data below decides the results.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, commands, projects, sessionsByProjectId, tasks, channels, inboxes, teamAgents, environments, memoryHits, projectNameById]);

  const flatItems = useMemo(() => results.flatMap((group) => group.items), [results]);

  useEffect(() => setHighlightedIndex(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${highlightedIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex]);

  const runItem = (item: PaletteCommand | undefined) => {
    if (!item) return;
    onOpenChange(false);
    item.run();
  };

  const handleKeyDown = (keyboardEvent: React.KeyboardEvent) => {
    if (keyboardEvent.nativeEvent.isComposing) return;
    if (keyboardEvent.key === "ArrowDown" || (keyboardEvent.ctrlKey && keyboardEvent.key === "n")) {
      keyboardEvent.preventDefault();
      setHighlightedIndex((previous) => (flatItems.length ? (previous + 1) % flatItems.length : 0));
    } else if (keyboardEvent.key === "ArrowUp" || (keyboardEvent.ctrlKey && keyboardEvent.key === "p")) {
      keyboardEvent.preventDefault();
      setHighlightedIndex((previous) => (flatItems.length ? (previous - 1 + flatItems.length) % flatItems.length : 0));
    } else if (keyboardEvent.key === "Enter") {
      keyboardEvent.preventDefault();
      runItem(flatItems[highlightedIndex]);
    }
  };

  let flatIndex = -1;
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onKeyDown={handleKeyDown}
          className="fixed top-[14vh] left-1/2 z-50 flex max-h-[min(520px,70vh)] w-[min(640px,calc(100%-2rem))] -translate-x-1/2 flex-col overflow-hidden rounded-xl border bg-background shadow-2xl outline-none duration-150 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          <DialogPrimitive.Title className="sr-only">{t("Suchen & Befehle")}</DialogPrimitive.Title>
          <div className="flex items-center gap-2.5 border-b px-3.5">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(changeEvent) => setQuery(changeEvent.target.value)}
              placeholder={t("Suchen oder Befehl ausführen …")}
              className="h-12 w-full bg-transparent text-[14px] outline-none placeholder:text-muted-foreground"
              role="combobox"
              aria-expanded
              aria-controls="command-palette-list"
              aria-activedescendant={flatItems[highlightedIndex] ? `palette-item-${highlightedIndex}` : undefined}
            />
          </div>
          <div ref={listRef} id="command-palette-list" role="listbox" className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {flatItems.length === 0 && <p className="px-3 py-8 text-center text-[13px] text-muted-foreground">{t("Keine Treffer")}</p>}
            {results.map((group) => (
              <div key={group.title} role="group" aria-label={group.title} className="mb-1">
                <div className="px-2.5 pt-2 pb-1 text-[11.5px] font-medium text-muted-foreground">{group.title}</div>
                {group.items.map((item) => {
                  flatIndex += 1;
                  const itemIndex = flatIndex;
                  const ItemIcon = item.icon;
                  const highlighted = itemIndex === highlightedIndex;
                  return (
                    <div
                      key={item.id}
                      id={`palette-item-${itemIndex}`}
                      data-index={itemIndex}
                      role="option"
                      aria-selected={highlighted}
                      onMouseMove={() => setHighlightedIndex(itemIndex)}
                      onClick={() => runItem(item)}
                      className={cn("flex h-9 cursor-default items-center gap-2.5 rounded-md px-2.5 text-[13px]", highlighted && "bg-foreground/[0.07]")}
                    >
                      {item.avatar ? <ProjectAvatar name={item.avatar.name} icon={item.avatar.icon} /> : ItemIcon && <ItemIcon className="size-4 shrink-0 text-muted-foreground" />}
                      <span className="truncate">{item.label}</span>
                      {item.detail && <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">{item.detail}</span>}
                      {!item.detail && <span className="flex-1" />}
                      {item.shortcut && <kbd className="shrink-0 font-sans text-[11.5px] text-muted-foreground">{item.shortcut}</kbd>}
                      {highlighted && !item.shortcut && <CornerDownLeft className="size-3.5 shrink-0 text-muted-foreground" />}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
