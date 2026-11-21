import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Loader2, MoreHorizontal, PanelRight, ShieldAlert, Square, Trash2, Volume2 } from "lucide-react";
import type { ChatItem, PermissionMode, PermissionRequest, Project, Session } from "@/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { StatusDot, type SessionStatus } from "@/components/status-dot";
import { safeStorage } from "@/lib/storage";
import { useSpeechPlayback } from "@/hooks/use-speech-playback";
import { ToolGroup, summarizeToolInput, type ToolResultItem, type ToolUseItem } from "./tool-group";
import { Composer } from "./composer";

type ChatPaneProps = {
  project: Project | null;
  session: Session | null;
  status: SessionStatus;
  chatItems: ChatItem[];
  streamingDraft: string;
  permissionRequests: PermissionRequest[];
  composerInsertion: { text: string; nonce: number } | null;
  workspaceOpen: boolean;
  onOpenWorkspace: () => void;
  onSend: (text: string, permissionMode: PermissionMode, model?: string) => void;
  onInterrupt: () => void;
  onAnswerPermission: (requestId: string, allow: boolean) => void;
  onDeleteSession: () => void;
  sttReady: boolean;
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

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) return;
    const nearBottom = scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight < 160;
    if (nearBottom) scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior: "smooth" });
  }, [props.chatItems.length, props.streamingDraft, props.permissionRequests.length]);

  useEffect(() => {
    scrollContainerRef.current?.scrollTo({ top: scrollContainerRef.current.scrollHeight });
  }, [props.session?.id]);

  return (
    <section className="flex h-full min-w-0 flex-col bg-background">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <h1 className="truncate text-[14px] font-semibold">{props.session?.title ?? props.project?.name ?? "Harnold"}</h1>
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
              <DropdownMenuContent align="end">
                <DropdownMenuItem variant="destructive" onSelect={props.onDeleteSession}>
                  <Trash2 /> Session löschen
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
          {props.project && renderBlocks.length === 0 && !props.streamingDraft && (
            <p className="text-muted-foreground">Schreib einfach los – eine Session wird automatisch angelegt.</p>
          )}

          {renderBlocks.map((renderBlock) => {
            if (renderBlock.type === "tools") {
              return (
                <ToolGroup
                  key={renderBlock.key}
                  toolUses={renderBlock.toolUses}
                  toolResultsByToolUseId={toolResultsByToolUseId}
                  running={running}
                />
              );
            }
            const { chatItem } = renderBlock;
            switch (chatItem.kind) {
              case "user_text":
                return (
                  <div key={chatItem.id} className="animate-in fade-in self-end rounded-xl bg-muted px-3.5 py-2 whitespace-pre-wrap duration-200 max-w-[85%]">
                    {chatItem.text}
                  </div>
                );
              case "assistant_text":
                return (
                  <div key={chatItem.id} className="group/answer relative animate-in fade-in duration-200">
                    <div className="chat-markdown">
                      <ReactMarkdown>{chatItem.text}</ReactMarkdown>
                    </div>
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

          {props.streamingDraft && (
            <div className="chat-markdown">
              <ReactMarkdown>{props.streamingDraft}</ReactMarkdown>
            </div>
          )}

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
            insertion={props.composerInsertion}
            sttReady={props.sttReady}
            ttsReady={props.ttsReady}
            readAloud={readAloud}
            onReadAloudChange={(nextReadAloud) => {
              setReadAloud(nextReadAloud);
              if (!nextReadAloud) speechPlayback.stopSpeaking();
            }}
            onSend={props.onSend}
            onInterrupt={props.onInterrupt}
            onError={props.onError}
          />
        </div>
      )}
    </section>
  );
}
