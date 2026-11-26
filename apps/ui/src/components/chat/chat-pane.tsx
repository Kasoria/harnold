import { useEffect, useMemo, useRef, useState } from "react";
import { QuestionCard, isQuestionRequest } from "@/components/chat/question-card";
import { SecretInputCard, isSecretInputRequest } from "@/components/chat/secret-input-card";
import { PermissionCard } from "@/components/chat/permission-card";
import { BackgroundTasksBar, TodoPanel, todosFromChat } from "@/components/chat/agent-progress";
import { ArrowDown, ArrowRightLeft, Clock, CornerDownLeft, Eraser, Layers, Loader2, MoreHorizontal, PanelRight, Paperclip, Pencil, Square, Trash2, Users, Volume2 } from "lucide-react";
import type { BackgroundTask, EffortLevel, TeamAgent, Attachment, ChatItem, QueuedMessage, Environment, PermissionAnswer, PermissionMode, PermissionRequest, Project, Session } from "@/types";
import { cn, isActionEnter } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { confirmAction } from "@/components/confirm-dialog";
import { ChatMarkdown, CopyButton } from "./chat-markdown";
import { ActivityIndicator, ThinkingBlock } from "./activity";
import { MoveSessionDialog } from "./move-session-dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { StatusDot, type SessionStatus } from "@/components/status-dot";
import { safeStorage } from "@/lib/storage";
import { useSpeechPlayback } from "@/hooks/use-speech-playback";
import { WorkGroup, type ToolResultItem, type ToolUseItem, type WorkStep } from "./tool-group";
import { Composer } from "./composer";
import { UserMessage } from "./user-message";
import { ImageGallery, imagePathsIn } from "./attachment-views";
import { WorktreeControl } from "./worktree-control";
import { ProjectQuickSelect } from "./project-quick-select";
import { ContextIndicator } from "./context-indicator";
import { useSessionBackend } from "@/lib/agent-backends";
import { messageVersions } from "@/lib/session-versions";
import type { InheritedModel } from "@/components/model-select";
import { t } from "@/lib/i18n";
import { api } from "@/api";
import { pickFolder } from "@/lib/folder-picker";
import { toast } from "@/lib/toast";

type ChatPaneProps = {
  /** Team of this project; empty = no agent picker. */
  teamAgents: TeamAgent[];
  onSetAgent: (agentId: string | null) => void;
  project: Project | null;
  session: Session | null;
  status: SessionStatus;
  chatItems: ChatItem[];
  streamingDraft: string;
  streamingThinking: string;
  projects: Project[];
  environments: Environment[];
  onNewSession: () => void;
  onRenameSession: (title: string) => void;
  onMoveSession: (projectId: string) => void;
  onSetProjectEnvironment: (environmentId: string | null) => void;
  /** Clears timeline and agent context (/clear). */
  onClearSession: () => void;
  permissionRequests: PermissionRequest[];
  composerInsertion: { text: string; nonce: number } | null;
  workspaceOpen: boolean;
  onOpenWorkspace: () => void;
  onSend: (text: string, permissionMode: PermissionMode, model?: string, attachments?: Attachment[], effort?: EffortLevel) => void;
  /** Saves the model picked in the composer on the open session (no-op while there is none). */
  /** Saves a requested secret ("" = skipped); the value goes to the core only. */
  onSubmitSecret: (requestId: string, value: string) => void;
  onSessionModelChange: (model: string) => void;
  inheritedModel: InheritedModel;
  onInterrupt: () => void;
  onAnswerPermission: (requestId: string, answer: PermissionAnswer) => void;
  onDeleteSession: () => void;
  /** All sessions of the project – needed to find the versions of edited messages. */
  projectSessions: Session[];
  onOpenVersion: (sessionId: string) => void;
  /** Edit a sent message: continues as a new version from there. */
  onEditMessage: (itemId: string, text: string) => void;
  sttMode: "off" | "system" | "server";
  sttLanguage: string;
  ttsReady: boolean;
  onError: (unknownError: unknown) => void;
  /** Messages sent during the running turn; they start one after another once it is done. */
  queuedMessages: QueuedMessage[];
  onSendQueuedNow: (queuedMessageId: string) => void;
  onRemoveQueued: (queuedMessageId: string) => void;
  /** Context size reported live during the running turn. */
  liveContextTokens: number | null;
  agentStatus: string | null;
  backgroundTasks: BackgroundTask[];
  onStopBackgroundTask: (taskId: string) => void;
};

type RenderBlock =
  | { type: "item"; chatItem: ChatItem }
  | { type: "work"; key: string; steps: WorkStep[]; toolUses: ToolUseItem[] };

const statusLabels: Record<SessionStatus, string> = { idle: t("Idle"), recent: t("Kürzlich aktiv"), running: t("Läuft"), waiting: t("Wartet"), error: t("Fehler") };

/** Groups consecutive thoughts and tool calls into one collapsible line (answers stay visible). */
function buildRenderBlocks(chatItems: ChatItem[]): RenderBlock[] {
  const renderBlocks: RenderBlock[] = [];
  for (const chatItem of chatItems) {
    if (chatItem.kind === "tool_result") continue;
    if (chatItem.kind === "tool_use" || chatItem.kind === "thinking") {
      const previousBlock = renderBlocks.at(-1);
      const workBlock = previousBlock?.type === "work" ? previousBlock : { type: "work" as const, key: chatItem.id, steps: [], toolUses: [] };
      if (workBlock !== previousBlock) renderBlocks.push(workBlock);
      workBlock.steps.push(chatItem);
      if (chatItem.kind === "tool_use") workBlock.toolUses.push(chatItem);
      continue;
    }
    renderBlocks.push({ type: "item", chatItem });
  }
  return renderBlocks;
}

export function ChatPane(props: ChatPaneProps) {
  const sessionBackend = useSessionBackend(props.session?.backendId);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  /** Follow new content while the view sits at the end; stops as soon as the user scrolls up. */
  const stickToBottomRef = useRef(true);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const running = props.status === "running" || props.status === "waiting";
  const [readAloud, setReadAloud] = useState(safeStorage.getItem("harnold.readAloud") === "1");
  const speechPlayback = useSpeechPlayback(props.onError);
  const previousRunningRef = useRef(running);
  const [moveDialogOpen, setMoveDialogOpen] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [droppedFiles, setDroppedFiles] = useState<{ files: File[]; nonce: number } | null>(null);
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const projectEnvironment = props.environments.find((environment) => props.project && environment.projectIds.includes(props.project.id)) ?? null;

  /** Like Claude's "restore code": preview what changes, ask, then restore the files (the conversation stays). */
  const rewindFilesTo = async (userItemId: string) => {
    if (!props.session) return;
    try {
      const preview = await api.rewindFiles(props.session.id, userItemId, true);
      if (!preview.canRewind) return void toast.error(preview.error || t("Für diese Nachricht gibt es keinen Datei-Stand"));
      const changedFiles = preview.filesChanged ?? [];
      if (!changedFiles.length) return void toast.success(t("Seit dieser Nachricht wurden keine Dateien geändert"));
      const projectPrefix = props.project ? `${props.project.path}/` : "";
      const fileList = changedFiles.slice(0, 8).map((filePath) => (filePath.startsWith(projectPrefix) ? filePath.slice(projectPrefix.length) : filePath)).join(", ");
      const confirmed = await confirmAction({
        title: t("{0} Dateien zurücksetzen?", changedFiles.length),
        description: `${fileList}${changedFiles.length > 8 ? " …" : ""} · +${preview.insertions ?? 0} / −${preview.deletions ?? 0}. ${t("Der Chat bleibt erhalten.")}`,
        confirmLabel: t("Zurücksetzen"),
      });
      if (!confirmed) return;
      const rewindResult = await api.rewindFiles(props.session.id, userItemId, false);
      if (rewindResult.canRewind) toast.success(t("Dateien zurückgesetzt"));
      else toast.error(rewindResult.error || t("Zurücksetzen nicht möglich"));
    } catch (rewindError) {
      props.onError(rewindError);
    }
  };

  const commitTitle = () => {
    if (titleDraft?.trim() && titleDraft.trim() !== props.session?.title) props.onRenameSession(titleDraft.trim());
    setTitleDraft(null);
  };

  const clearSession = async () => {
    if (await confirmAction({ title: t("Kontext leeren?"), description: t("Verlauf und Agent-Kontext dieser Session werden zurückgesetzt."), confirmLabel: t("Leeren") })) props.onClearSession();
  };

  const saveDirectories = (directories: string[]) => {
    if (props.session) void api.updateSession(props.session.id, { directories }).catch(props.onError);
  };
  const addDirectory = async (typedPath?: string) => {
    if (!props.session) return;
    const directory = typedPath || (await pickFolder(t("Ordner zum Chat hinzufügen")).catch((pickError) => (props.onError(pickError), null)));
    if (directory) saveDirectories([...(props.session.directories ?? []), directory]);
  };

  /** A folder for the whole project: memory level "project", so every session and every task run sees it. */
  const addProjectFolder = async () => {
    if (!props.session) return;
    const directory = await pickFolder(t("Ordner für das ganze Projekt freigeben")).catch((pickError) => (props.onError(pickError), null));
    if (!directory) return;
    await api
      .addFolder("project", directory, props.session.projectId)
      .then(() => toast.success(t("Ordner „{0}“ gehört jetzt zum Projekt", directory.split(/[\\/]/).filter(Boolean).at(-1) ?? directory)))
      .catch(props.onError);
  };

  /** Slash commands Harnold handles itself; false = send to the agent. */
  const runSessionCommand = (commandName: string, commandArguments: string): boolean => {
    switch (commandName) {
      case "clear":
        if (props.session) void clearSession();
        return true;
      case "new":
        props.onNewSession();
        return true;
      case "rename":
        if (!props.session) return true;
        if (commandArguments) props.onRenameSession(commandArguments);
        else setTitleDraft(props.session.title);
        return true;
      case "move":
        if (props.session) setMoveDialogOpen(true);
        return true;
      case "add-dir":
        void addDirectory(commandArguments || undefined);
        return true;
      default:
        return false;
    }
  };

  const lastUserItem = props.chatItems.findLast((chatItem) => chatItem.kind === "user_text");
  // A turn the agent started itself (after a background task) begins after the last finished turn.
  const lastTurnEnd = props.chatItems.findLast((chatItem) => chatItem.kind === "turn_result")?.createdAt ?? 0;
  const turnStartedAt = Math.max(lastUserItem?.createdAt ?? 0, lastTurnEnd) || Date.now();
  const lastMeasuredTurn = props.chatItems.findLast((chatItem) => chatItem.kind === "turn_result" && chatItem.contextTokens !== undefined);
  const lastTurnContext = lastMeasuredTurn?.kind === "turn_result" ? lastMeasuredTurn : null;
  const contextTokens = running && props.liveContextTokens !== null ? props.liveContextTokens : (lastTurnContext?.contextTokens ?? null);
  const lastItem = props.chatItems.at(-1);
  const toolPending = lastItem?.kind === "tool_use";
  const todos = useMemo(() => todosFromChat(props.chatItems), [props.chatItems]);
  // Like Claude Code: visible while work is left (or the turn still runs).
  const showTodoPanel = todos.length > 0 && (running || todos.some((todo) => todo.status !== "completed"));
  const showActivity = running && !props.streamingDraft && !props.streamingThinking && props.permissionRequests.length === 0;

  useEffect(() => safeStorage.setItem("harnold.readAloud", readAloud ? "1" : "0"), [readAloud]);

  // Auto-read: when a turn finishes, speak its last answer.
  useEffect(() => {
    const turnJustFinished = previousRunningRef.current && !running;
    previousRunningRef.current = running;
    if (!turnJustFinished || !readAloud || !props.ttsReady) return;
    const lastAssistantItem = props.chatItems.findLast((chatItem) => chatItem.kind === "assistant_text");
    if (lastAssistantItem?.kind === "assistant_text") void speechPlayback.speak(lastAssistantItem.id, lastAssistantItem.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  useEffect(() => speechPlayback.stopSpeaking, [props.session?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const renderBlocks = useMemo(() => buildRenderBlocks(props.chatItems), [props.chatItems]);
  const toolResultsByToolUseId = useMemo(
    () =>
      new Map(
        props.chatItems.flatMap((chatItem) => (chatItem.kind === "tool_result" ? [[chatItem.toolUseId, chatItem as ToolResultItem] as const] : [])),
      ),
    [props.chatItems],
  );
  /**
   * Images to preview inline per block: results of generate_image, image files the agent read, and image paths
   * in answers. Each image appears once per turn (where it first shows up).
   */
  const imagePathsByBlockKey = useMemo(() => {
    const pathsByKey = new Map<string, string[]>();
    let shownInTurn = new Set<string>();
    const take = (blockKey: string, candidatePaths: string[]) => {
      const newPaths = candidatePaths.filter((candidatePath) => !shownInTurn.has(candidatePath));
      for (const newPath of newPaths) shownInTurn.add(newPath);
      if (newPaths.length) pathsByKey.set(blockKey, newPaths);
    };
    for (const renderBlock of renderBlocks) {
      if (renderBlock.type === "work") {
        const toolImagePaths = renderBlock.toolUses.flatMap((toolUse) => {
          const toolResult = toolResultsByToolUseId.get(toolUse.toolUseId);
          if (!toolResult || toolResult.isError) return [];
          if (toolUse.toolName.endsWith("generate_image")) return imagePathsIn(toolResult.content);
          const readPath = toolUse.toolName === "Read" ? String((toolUse.input as { file_path?: string })?.file_path ?? "") : "";
          return readPath && props.project && readPath.startsWith(props.project.path + "/") ? imagePathsIn(readPath.slice(props.project.path.length + 1)) : [];
        });
        take(renderBlock.key, toolImagePaths);
      } else if (renderBlock.chatItem.kind === "user_text") shownInTurn = new Set();
      else if (renderBlock.chatItem.kind === "assistant_text") take(renderBlock.chatItem.id, imagePathsIn(renderBlock.chatItem.text));
    }
    return pathsByKey;
  }, [renderBlocks, toolResultsByToolUseId, props.project]);

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer || !stickToBottomRef.current) return;
    scrollContainer.scrollTop = scrollContainer.scrollHeight;
  }, [props.chatItems.length, props.streamingDraft, props.streamingThinking, props.permissionRequests.length, props.queuedMessages.length]);

  // A session always opens at its last message.
  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    stickToBottomRef.current = true;
    setShowJumpToBottom(false);
    if (!scrollContainer) return;
    scrollContainer.scrollTop = scrollContainer.scrollHeight;
    // Messages arrive a moment later; keep following them until the user scrolls.
    const frame = requestAnimationFrame(() => {
      if (stickToBottomRef.current) scrollContainer.scrollTop = scrollContainer.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [props.session?.id]);

  // Late layout (images, markdown, loaded history) must not leave the view behind.
  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    const content = contentRef.current;
    if (!scrollContainer || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (stickToBottomRef.current) scrollContainer.scrollTop = scrollContainer.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  const scrollToBottom = () => {
    const scrollContainer = scrollContainerRef.current;
    stickToBottomRef.current = true;
    setShowJumpToBottom(false);
    scrollContainer?.scrollTo({ top: scrollContainer.scrollHeight, behavior: "smooth" });
  };

  const trackScrollPosition = () => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) return;
    const distanceFromBottom = scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 80;
    setShowJumpToBottom(distanceFromBottom > 320);
  };

  return (
    <section
      className="relative flex h-full min-w-0 flex-col bg-background"
      onDragOver={(dragEvent) => {
        if (!props.project || !dragEvent.dataTransfer.types.includes("Files")) return;
        dragEvent.preventDefault();
        dragEvent.dataTransfer.dropEffect = "copy";
        setDragActive(true);
      }}
      onDragLeave={(dragEvent) => {
        if (!dragEvent.currentTarget.contains(dragEvent.relatedTarget as Node | null)) setDragActive(false);
      }}
      onDrop={(dragEvent) => {
        setDragActive(false);
        if (!props.project || !dragEvent.dataTransfer.files.length) return;
        dragEvent.preventDefault();
        setDroppedFiles({ files: [...dragEvent.dataTransfer.files], nonce: Date.now() });
      }}
    >
      {dragActive && (
        <div className="pointer-events-none absolute inset-2 z-30 flex animate-in flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary bg-primary/10 text-[13px] font-medium text-foreground backdrop-blur-[2px] fade-in duration-150">
          <Paperclip className="size-5 text-primary" />
          {t("Dateien hier ablegen")}
          <span className="text-[12px] font-normal text-muted-foreground">{t("Bilder, PDFs, Text- und Office-Dateien")}</span>
        </div>
      )}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        {titleDraft !== null ? (
          <input
            autoFocus
            value={titleDraft}
            onChange={(changeEvent) => setTitleDraft(changeEvent.target.value)}
            onBlur={commitTitle}
            onKeyDown={(keyboardEvent) => {
              if (isActionEnter(keyboardEvent)) commitTitle();
              if (keyboardEvent.key === "Escape") setTitleDraft(null);
            }}
            className="min-w-0 flex-1 rounded-md bg-muted px-2 py-0.5 text-[14px] font-semibold outline-none"
            aria-label={t("Session-Titel")}
          />
        ) : (
          <h1 className="truncate text-[14px] font-semibold" onDoubleClick={() => props.session && setTitleDraft(props.session.title)}>
            {props.session?.title ?? props.project?.name ?? t("Harnold")}
          </h1>
        )}
        {props.session && (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
            <StatusDot status={props.status} />
            {statusLabels[props.status]}
          </span>
        )}
        {props.session && props.teamAgents.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-[12px] text-muted-foreground" aria-label={t("Agent dieser Session")}>
                <Users className="size-3.5" />
                {props.teamAgents.find((agent) => agent.id === props.session?.agentId)?.name ?? t("Harnold")}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-52">
              <DropdownMenuRadioGroup value={props.session.agentId ?? "default"} onValueChange={(agentId) => props.onSetAgent(agentId === "default" ? null : agentId)}>
                <DropdownMenuRadioItem value="default">{t("Harnold (Standard)")}</DropdownMenuRadioItem>
                {props.teamAgents.map((agent) => (
                  <DropdownMenuRadioItem key={agent.id} value={agent.id}>
                    <span className="truncate">{agent.name}</span>
                    {agent.role && <span className="truncate text-[11.5px] text-muted-foreground">{agent.role}</span>}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <div className="ml-auto flex items-center gap-1">
          {props.session && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="size-7 text-muted-foreground" aria-label={t("Session-Menü")}>
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-52">
                <DropdownMenuItem onSelect={() => setTitleDraft(props.session!.title)}>
                  <Pencil /> {t("Umbenennen")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setMoveDialogOpen(true)}>
                  <ArrowRightLeft /> {t("Verschieben …")}
                </DropdownMenuItem>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <Layers /> {t("Umgebung:")} {projectEnvironment?.name ?? "keine"}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <DropdownMenuRadioGroup
                      value={projectEnvironment?.id ?? "none"}
                      onValueChange={(environmentId) => props.onSetProjectEnvironment(environmentId === "none" ? null : environmentId)}
                    >
                      {props.environments.map((environment) => (
                        <DropdownMenuRadioItem key={environment.id} value={environment.id}>
                          {environment.name}
                        </DropdownMenuRadioItem>
                      ))}
                      <DropdownMenuRadioItem value="none">{t("Keine")}</DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuItem disabled={running} onSelect={() => void clearSession()}>
                  <Eraser /> {t("Kontext leeren")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={props.onDeleteSession}>
                  <Trash2 /> {t("Löschen")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {!props.workspaceOpen && props.project && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="size-7 text-muted-foreground" onClick={props.onOpenWorkspace} aria-label={t("Workspace öffnen")}>
                  <PanelRight className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("Workspace öffnen")}</TooltipContent>
            </Tooltip>
          )}
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div ref={scrollContainerRef} onScroll={trackScrollPosition} className="flex-1 overflow-y-auto">
          <div ref={contentRef} className="mx-auto flex max-w-3xl flex-col gap-3 px-5 py-5 text-[14px] leading-relaxed">
          {!props.project && <p className="text-muted-foreground">{t("Lege links ein Projekt an, um zu starten.")}</p>}

          {renderBlocks.map((renderBlock, blockIndex) => {
            if (renderBlock.type === "work") {
              const toolImagePaths = imagePathsByBlockKey.get(renderBlock.key);
              return (
                <div key={renderBlock.key} className="flex flex-col gap-2">
                  <WorkGroup
                    steps={renderBlock.steps}
                    toolResultsByToolUseId={toolResultsByToolUseId}
                    running={running}
                    isLatest={blockIndex === renderBlocks.length - 1}
                  />
                  {toolImagePaths && props.project && <ImageGallery projectId={props.project.id} imagePaths={toolImagePaths} />}
                </div>
              );
            }
            const { chatItem } = renderBlock;
            switch (chatItem.kind) {
              case "user_text": {
                const versions = props.session ? messageVersions(props.session, chatItem.id, props.projectSessions) : null;
                return (
                  <UserMessage
                    key={chatItem.id}
                    text={chatItem.text}
                    projectId={props.project?.id ?? null}
                    attachments={chatItem.attachments ?? []}
                    versions={versions && versions.versionSessionIds.length > 1 ? { currentIndex: versions.currentIndex, total: versions.versionSessionIds.length } : null}
                    onShowVersion={(versionIndex) => versions && props.onOpenVersion(versions.versionSessionIds[versionIndex])}
                    canEdit={!running}
                    onSubmitEdit={(editedText) => props.onEditMessage(chatItem.id, editedText)}
                    onRewindFiles={sessionBackend?.capabilities.rewindFiles && props.session ? () => void rewindFilesTo(chatItem.id) : undefined}
                  />
                );
              }
              case "assistant_text":
                return (
                  <div key={chatItem.id} className="group/answer relative animate-in fade-in duration-200">
                    <ChatMarkdown text={chatItem.text} />
                    {imagePathsByBlockKey.has(chatItem.id) && props.project && (
                      <ImageGallery projectId={props.project.id} imagePaths={imagePathsByBlockKey.get(chatItem.id)!} className="mt-2" />
                    )}
                    <div className="mt-0.5 flex items-center gap-1">
                    <CopyButton
                      readText={() => chatItem.text}
                      label={t("Kopieren")}
                      className="h-6 px-1 text-[11.5px] opacity-0 transition-opacity duration-150 group-hover/answer:opacity-100 focus-visible:opacity-100"
                    />
                    {props.ttsReady && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className={cn(
                          "-ml-2 h-6 gap-1 px-2 text-[11.5px] text-muted-foreground opacity-0 transition-opacity duration-150 group-hover/answer:opacity-100 focus-visible:opacity-100",
                          (speechPlayback.speakingKey === chatItem.id || speechPlayback.loadingKey === chatItem.id) && "opacity-100",
                        )}
                        onClick={() =>
                          speechPlayback.speakingKey === chatItem.id ? speechPlayback.stopSpeaking() : void speechPlayback.speak(chatItem.id, chatItem.text)
                        }
                      >
                        {speechPlayback.loadingKey === chatItem.id ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : speechPlayback.speakingKey === chatItem.id ? (
                          <Square className="size-2.5 fill-current" />
                        ) : (
                          <Volume2 className="size-3" />
                        )}
                        {speechPlayback.speakingKey === chatItem.id ? t("Stopp") : t("Vorlesen")}
                      </Button>
                    )}
                    </div>
                  </div>
                );
              case "notice":
                return (
                  <div key={chatItem.id} className="flex animate-in items-center gap-3 py-1 text-[11.5px] text-muted-foreground fade-in duration-200">
                    <span className="h-px flex-1 bg-border" />
                    {chatItem.text}
                    <span className="h-px flex-1 bg-border" />
                  </div>
                );
              case "turn_result":
                return chatItem.success ? (
                  <div key={chatItem.id} className="text-[11px] text-muted-foreground">
                    {(chatItem.durationMs / 1000).toFixed(1)} {t("s · $")}{chatItem.costUsd.toFixed(4)}
                  </div>
                ) : (
                  <div key={chatItem.id} className="animate-in fade-in text-[13px] text-destructive duration-200">
                    {t("Fehler:")} {chatItem.errorText || "unbekannt"}
                  </div>
                );
              default:
                return null;
            }
          })}

          {props.streamingThinking && <ThinkingBlock text={props.streamingThinking} live />}
          {props.streamingDraft && <ChatMarkdown text={props.streamingDraft} />}
          {showActivity && <ActivityIndicator label={props.agentStatus || (toolPending ? t("Führt aus") : t("Arbeitet"))} startedAt={turnStartedAt} />}

          {props.permissionRequests.map((permissionRequest) =>
            isSecretInputRequest(permissionRequest.toolName) ? (
              <SecretInputCard
                key={permissionRequest.requestId}
                input={permissionRequest.input}
                onSubmit={(value) => props.onSubmitSecret(permissionRequest.requestId, value)}
                onCancel={() => props.onSubmitSecret(permissionRequest.requestId, "")}
              />
            ) : isQuestionRequest(permissionRequest.toolName) ? (
              <QuestionCard
                key={permissionRequest.requestId}
                input={permissionRequest.input}
                onAnswer={(answers) => props.onAnswerPermission(permissionRequest.requestId, { allow: true, answers })}
                onSkip={() => props.onAnswerPermission(permissionRequest.requestId, { allow: false })}
              />
            ) : (
              <PermissionCard key={permissionRequest.requestId} request={permissionRequest} onAnswer={(answer) => props.onAnswerPermission(permissionRequest.requestId, answer)} />
            ),
          )}

          {props.queuedMessages.map((queuedMessage, queueIndex) => (
            <div key={queuedMessage.id} className="flex animate-in justify-end fade-in slide-in-from-bottom-1 duration-200">
              <div className="grid max-w-[85%] gap-1.5 rounded-2xl border border-dashed bg-foreground/[0.02] px-3.5 py-2.5">
                <div className="whitespace-pre-wrap break-words text-[14px] text-muted-foreground">{queuedMessage.text}</div>
                {!!queuedMessage.attachments?.length && (
                  <div className="flex items-center gap-1 text-[11.5px] text-muted-foreground">
                    <Paperclip className="size-3" />
                    {queuedMessage.attachments.map((attachment) => attachment.name).join(", ")}
                  </div>
                )}
                <div className="flex items-center gap-3 text-[11.5px] text-muted-foreground">
                  <span className="mr-auto flex items-center gap-1">
                    <Clock className="size-3" />
                    {queueIndex === 0 ? (running ? t("Wartet auf den laufenden Durchlauf") : t("Wartet – Durchlauf wurde gestoppt")) : t("Wartet · Platz {0}", queueIndex + 1)}
                  </span>
                  <button
                    type="button"
                    className="flex items-center gap-1 font-medium text-foreground hover:underline"
                    title={running ? t("Stoppt den laufenden Durchlauf und sendet diese Nachricht") : undefined}
                    onClick={() => props.onSendQueuedNow(queuedMessage.id)}
                  >
                    <CornerDownLeft className="size-3" />
                    {t("Sofort senden")}
                  </button>
                  <button type="button" className="hover:text-foreground" onClick={() => props.onRemoveQueued(queuedMessage.id)} aria-label={t("Entfernen")}>
                    <Trash2 className="size-3" />
                  </button>
                </div>
              </div>
            </div>
          ))}
          </div>
        </div>
        {showJumpToBottom && (
          <div className="pointer-events-none absolute inset-x-0 bottom-2 z-20 flex justify-center">
            <Button
              size="icon"
              variant="secondary"
              className="pointer-events-auto size-8 animate-in rounded-full border shadow-sm fade-in slide-in-from-bottom-1 duration-150"
              onClick={scrollToBottom}
              aria-label={t("Zum Ende springen")}
            >
              <ArrowDown className="size-4" />
            </Button>
          </div>
        )}
      </div>

      {props.project && (
        <div className={cn("mx-auto w-full max-w-3xl")}>
          {(showTodoPanel || props.backgroundTasks.length > 0) && (
            <div className="grid gap-2 px-4 pb-2">
              {showTodoPanel && <TodoPanel todos={todos} />}
              {props.backgroundTasks.length > 0 && <BackgroundTasksBar tasks={props.backgroundTasks} onStop={props.onStopBackgroundTask} />}
            </div>
          )}
          <Composer
            placeholder={t("Nachricht an {0} …", props.project.name)}
            running={running}
            canSteer={Boolean(sessionBackend?.capabilities.steering)}
            canChooseEffort={Boolean(sessionBackend?.capabilities.effort)}
            inheritedModel={props.inheritedModel}
            draftKey={props.session?.id ?? `project:${props.project.id}`}
            sessionModel={props.session?.model ?? ""}
            onModelChange={(nextModel) => props.onSessionModelChange(nextModel)}
            insertion={props.composerInsertion}
            droppedFiles={droppedFiles}
            sttMode={props.sttMode}
            sttLanguage={props.sttLanguage}
            ttsReady={props.ttsReady}
            readAloud={readAloud}
            onReadAloudChange={(nextReadAloud) => {
              setReadAloud(nextReadAloud);
              if (!nextReadAloud) speechPlayback.stopSpeaking();
            }}
            projectId={props.project.id}
            onSessionCommand={runSessionCommand}
            onSend={props.onSend}
            teamAgents={props.teamAgents}
            onInterrupt={props.onInterrupt}
            onError={props.onError}
            contextIndicator={(composerModel) =>
              sessionBackend && !sessionBackend.capabilities.contextBreakdown ? null : (
              <ContextIndicator
                sessionId={props.session?.id ?? null}
                model={composerModel}
                contextTokens={contextTokens}
                contextWindow={lastTurnContext?.contextWindow ?? null}
                running={running}
                onCompact={() => props.onSend("/compact", "default", composerModel || undefined)}
              />
              )
            }
            directories={props.session?.directories}
            onAddDirectory={props.session ? () => void addDirectory() : undefined}
            onAddProjectFolder={props.session ? () => void addProjectFolder() : undefined}
            onRemoveDirectory={(directory) => saveDirectories((props.session?.directories ?? []).filter((existing) => existing !== directory))}
            footerStart={
              props.project.kind === "quick" && props.session ? (
                <ProjectQuickSelect projects={props.projects} onSelect={props.onMoveSession} />
              ) : props.session ? (
                <WorktreeControl project={props.project} session={props.session} hasMessages={props.chatItems.length > 0} running={running} />
              ) : undefined
            }
          />
        </div>
      )}
      <MoveSessionDialog
        open={moveDialogOpen}
        onOpenChange={setMoveDialogOpen}
        projects={props.projects}
        environments={props.environments}
        currentProjectId={props.project?.id ?? null}
        onMove={props.onMoveSession}
      />
    </section>
  );
}
