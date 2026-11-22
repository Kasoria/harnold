import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRightLeft, Eraser, Layers, Loader2, MoreHorizontal, PanelRight, Paperclip, Pencil, ShieldAlert, Square, Trash2, Volume2 } from "lucide-react";
import type { Attachment, ChatItem, Environment, PermissionMode, PermissionRequest, Project, Session } from "@/types";
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
import { ToolGroup, summarizeToolInput, type ToolResultItem, type ToolUseItem } from "./tool-group";
import { Composer } from "./composer";
import { UserMessage } from "./user-message";
import { ImageGallery, imagePathsIn } from "./attachment-views";
import { ProjectQuickSelect } from "./project-quick-select";
import { messageVersions } from "@/lib/session-versions";
import type { InheritedModel } from "@/components/model-select";

type ChatPaneProps = {
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
  onSend: (text: string, permissionMode: PermissionMode, model?: string, attachments?: Attachment[]) => void;
  inheritedModel: InheritedModel;
  onInterrupt: () => void;
  onAnswerPermission: (requestId: string, allow: boolean) => void;
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
};

type RenderBlock =
  | { type: "item"; chatItem: ChatItem }
  | { type: "tools"; key: string; toolUses: ToolUseItem[] };

const statusLabels: Record<SessionStatus, string> = { idle: "Idle", running: "Läuft", waiting: "Wartet", error: "Fehler" };

/** Groups consecutive tool calls into one collapsible line. */
function buildRenderBlocks(chatItems: ChatItem[]): RenderBlock[] {
  const renderBlocks: RenderBlock[] = [];
  for (const chatItem of chatItems) {
    if (chatItem.kind === "tool_result") continue;
    if (chatItem.kind === "tool_use") {
      const previousBlock = renderBlocks.at(-1);
      if (previousBlock?.type === "tools") previousBlock.toolUses.push(chatItem);
      else renderBlocks.push({ type: "tools", key: chatItem.id, toolUses: [chatItem] });
      continue;
    }
    renderBlocks.push({ type: "item", chatItem });
  }
  return renderBlocks;
}

export function ChatPane(props: ChatPaneProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const running = props.status === "running" || props.status === "waiting";
  const [readAloud, setReadAloud] = useState(safeStorage.getItem("harnold.readAloud") === "1");
  const speechPlayback = useSpeechPlayback(props.onError);
  const previousRunningRef = useRef(running);
  const [moveDialogOpen, setMoveDialogOpen] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [droppedFiles, setDroppedFiles] = useState<{ files: File[]; nonce: number } | null>(null);
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const projectEnvironment = props.environments.find((environment) => props.project && environment.projectIds.includes(props.project.id)) ?? null;

  const commitTitle = () => {
    if (titleDraft?.trim() && titleDraft.trim() !== props.session?.title) props.onRenameSession(titleDraft.trim());
    setTitleDraft(null);
  };

  const clearSession = async () => {
    if (await confirmAction({ title: "Kontext leeren?", description: "Verlauf und Agent-Kontext dieser Session werden zurückgesetzt.", confirmLabel: "Leeren" })) props.onClearSession();
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
      default:
        return false;
    }
  };

  const lastUserItem = props.chatItems.findLast((chatItem) => chatItem.kind === "user_text");
  const lastItem = props.chatItems.at(-1);
  const toolPending = lastItem?.kind === "tool_use";
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
      if (renderBlock.type === "tools") {
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
    if (!scrollContainer) return;
    const nearBottom = scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight < 160;
    if (nearBottom) scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior: "smooth" });
  }, [props.chatItems.length, props.streamingDraft, props.streamingThinking, props.permissionRequests.length]);

  useEffect(() => {
    scrollContainerRef.current?.scrollTo({ top: scrollContainerRef.current.scrollHeight });
  }, [props.session?.id]);

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
          Dateien hier ablegen
          <span className="text-[12px] font-normal text-muted-foreground">Bilder, PDFs, Text- und Office-Dateien</span>
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
            aria-label="Session-Titel"
          />
        ) : (
          <h1 className="truncate text-[14px] font-semibold" onDoubleClick={() => props.session && setTitleDraft(props.session.title)}>
            {props.session?.title ?? props.project?.name ?? "Harnold"}
          </h1>
        )}
        {props.session && (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
            <StatusDot status={props.status} />
            {statusLabels[props.status]}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {props.session && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="size-7 text-muted-foreground" aria-label="Session-Menü">
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-52">
                <DropdownMenuItem onSelect={() => setTitleDraft(props.session!.title)}>
                  <Pencil /> Umbenennen
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setMoveDialogOpen(true)}>
                  <ArrowRightLeft /> Verschieben …
                </DropdownMenuItem>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <Layers /> Umgebung: {projectEnvironment?.name ?? "keine"}
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
                      <DropdownMenuRadioItem value="none">Keine</DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuItem disabled={running} onSelect={() => void clearSession()}>
                  <Eraser /> Kontext leeren
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={props.onDeleteSession}>
                  <Trash2 /> Löschen
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {!props.workspaceOpen && props.project && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="size-7 text-muted-foreground" onClick={props.onOpenWorkspace} aria-label="Workspace öffnen">
                  <PanelRight className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Workspace öffnen</TooltipContent>
            </Tooltip>
          )}
        </div>
      </header>

      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-3 px-5 py-5 text-[14px] leading-relaxed">
          {!props.project && <p className="text-muted-foreground">Lege links ein Projekt an, um zu starten.</p>}

          {renderBlocks.map((renderBlock) => {
            if (renderBlock.type === "tools") {
              const toolImagePaths = imagePathsByBlockKey.get(renderBlock.key);
              return (
                <div key={renderBlock.key} className="flex flex-col gap-2">
                  <ToolGroup toolUses={renderBlock.toolUses} toolResultsByToolUseId={toolResultsByToolUseId} running={running} />
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
                      label="Kopieren"
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
                        {speechPlayback.speakingKey === chatItem.id ? "Stopp" : "Vorlesen"}
                      </Button>
                    )}
                    </div>
                  </div>
                );
              case "thinking":
                return <ThinkingBlock key={chatItem.id} text={chatItem.text} />;
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
                    {(chatItem.durationMs / 1000).toFixed(1)} s · ${chatItem.costUsd.toFixed(4)}
                  </div>
                ) : (
                  <div key={chatItem.id} className="animate-in fade-in text-[13px] text-destructive duration-200">
                    Fehler: {chatItem.errorText || "unbekannt"}
                  </div>
                );
              default:
                return null;
            }
          })}

          {props.streamingThinking && <ThinkingBlock text={props.streamingThinking} live />}
          {props.streamingDraft && <ChatMarkdown text={props.streamingDraft} />}
          {showActivity && <ActivityIndicator label={toolPending ? "Führt aus" : "Arbeitet"} startedAt={lastUserItem?.createdAt ?? Date.now()} />}

          {props.permissionRequests.map((permissionRequest) => (
            <div
              key={permissionRequest.requestId}
              className="animate-in fade-in slide-in-from-bottom-1 rounded-xl border bg-card p-3 shadow-xs duration-200"
            >
              <div className="flex items-center gap-2 text-[13px]">
                <ShieldAlert className="size-4 text-status-waiting" />
                <span>
                  <strong className="font-medium">{permissionRequest.toolName}</strong> möchte ausgeführt werden
                </span>
              </div>
              <div className="mt-1.5 truncate font-mono text-[12px] text-muted-foreground">
                {summarizeToolInput(permissionRequest.input) || JSON.stringify(permissionRequest.input).slice(0, 200)}
              </div>
              <div className="mt-3 flex gap-2">
                <Button size="sm" onClick={() => props.onAnswerPermission(permissionRequest.requestId, true)}>
                  Erlauben
                </Button>
                <Button size="sm" variant="ghost" onClick={() => props.onAnswerPermission(permissionRequest.requestId, false)}>
                  Ablehnen
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {props.project && (
        <div className={cn("mx-auto w-full max-w-3xl")}>
          <Composer
            placeholder={`Nachricht an ${props.project.name} …`}
            running={running}
            inheritedModel={props.inheritedModel}
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
            onInterrupt={props.onInterrupt}
            onError={props.onError}
            footerStart={props.project.kind === "quick" && props.session ? <ProjectQuickSelect projects={props.projects} onSelect={props.onMoveSession} /> : undefined}
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
