import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Loader2, Mic, Paperclip, Square, Volume2, VolumeX, X } from "lucide-react";
import type { AgentCommand, Attachment, PermissionMode, TeamAgent } from "@/types";
import { AttachmentChip } from "./attachment-views";
import { api } from "@/api";
import { cn, isActionEnter } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { safeStorage } from "@/lib/storage";
import { useVoiceRecorder } from "@/hooks/use-voice-recorder";
import { startSystemSpeech, type SystemSpeechSession } from "@/lib/system-speech";
import { permissionModeOptions } from "@/components/form-field";
import { agentModels, ModelSelect, type InheritedModel } from "@/components/model-select";
import { t } from "@/lib/i18n";

const fieldSizingSupported = CSS.supports("field-sizing", "content");

type ComposerCommand = AgentCommand & { source: "harnold" | "agent" };

/** Harnold's own commands; /compact etc. go to the agent. */
const harnoldCommands: ComposerCommand[] = [
  { name: "clear", description: t("Verlauf und Kontext leeren"), argumentHint: "", source: "harnold" },
  { name: "new", description: t("Neue Session"), argumentHint: "", source: "harnold" },
  { name: "rename", description: t("Session umbenennen"), argumentHint: "<Titel>", source: "harnold" },
  { name: "move", description: t("In anderes Projekt / andere Umgebung verschieben"), argumentHint: "", source: "harnold" },
  { name: "model", description: t("Modell wechseln"), argumentHint: agentModels.map((agentModel) => agentModel.label.split(" ")[0].toLowerCase()).join(" | "), source: "harnold" },
  { name: "plan", description: t("Plan-Modus an/aus"), argumentHint: "", source: "harnold" },
];

function parseCommand(text: string): { name: string; commandArguments: string } | null {
  const commandMatch = /^\/([\w:.-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return commandMatch ? { name: commandMatch[1], commandArguments: (commandMatch[2] ?? "").trim() } : null;
}

type ComposerProps = {
  /** Model used when none is picked here (environment or settings). */
  inheritedModel: InheritedModel;
  placeholder: string;
  projectId: string;
  /** Session-level commands (/clear, /new, /rename, /move); returns false when it is not one. */
  onSessionCommand: (commandName: string, commandArguments: string) => boolean;
  running: boolean;
  insertion: { text: string; nonce: number } | null;
  /** Files dropped anywhere on the chat; attached like files picked here. */
  droppedFiles: { files: File[]; nonce: number } | null;
  /** "system": free recognition of the browser/OS, "server": provider configured in the Core. */
  sttMode: "off" | "system" | "server";
  sttLanguage: string;
  ttsReady: boolean;
  readAloud: boolean;
  onReadAloudChange: (readAloud: boolean) => void;
  onSend: (text: string, permissionMode: PermissionMode, model?: string, attachments?: Attachment[]) => void;
  onInterrupt: () => void;
  onError: (unknownError: unknown) => void;
  /** Team members of the project; "@" lists them, a mention hands the message to them. */
  teamAgents?: TeamAgent[];
  /** Left side of the row under the input (e.g. project quick select). */
  footerStart?: React.ReactNode;
};

/** A file in the composer: uploads right away, is sent with the next message. */
type PendingAttachment = { localId: string; name: string; mimeType: string; size: number; previewUrl?: string; status: "uploading" | "ready" | "failed"; attachment?: Attachment };

function formatDuration(totalSeconds: number) {
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

export function Composer(props: ComposerProps) {
  const [composerText, setComposerText] = useState("");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    (safeStorage.getItem("harnold.permissionMode") as PermissionMode | null) ?? "default",
  );
  // "" = inherited model (older builds stored "default").
  const [model, setModel] = useState(() => {
    const storedModel = safeStorage.getItem("harnold.model") ?? "";
    return storedModel === "default" ? "" : storedModel;
  });
  const [transcribing, setTranscribing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const voiceRecorder = useVoiceRecorder();
  const [agentCommandList, setAgentCommandList] = useState<AgentCommand[]>([]);
  const [highlightedCommandIndex, setHighlightedCommandIndex] = useState(0);
  const [commandMenuDismissed, setCommandMenuDismissed] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [caretPosition, setCaretPosition] = useState(0);
  const [highlightedMentionIndex, setHighlightedMentionIndex] = useState(0);
  const [mentionMenuDismissed, setMentionMenuDismissed] = useState(false);

  const addFiles = (files: File[]) => {
    for (const file of files) {
      const localId = crypto.randomUUID();
      const isImage = file.type.startsWith("image/");
      setPendingAttachments((previous) => [
        ...previous,
        { localId, name: file.name || t("Einfügung.png"), mimeType: file.type, size: file.size, previewUrl: isImage ? URL.createObjectURL(file) : undefined, status: "uploading" },
      ]);
      const namedFile = file.name ? file : new File([file], t("Einfügung-{0}.png", Date.now()), { type: file.type });
      api
        .uploadAttachments(props.projectId, [namedFile])
        .then(([attachment]) =>
          setPendingAttachments((previous) => previous.map((pending) => (pending.localId === localId ? { ...pending, status: "ready", attachment, name: attachment.name } : pending))),
        )
        .catch((uploadError) => {
          props.onError(uploadError);
          setPendingAttachments((previous) => previous.map((pending) => (pending.localId === localId ? { ...pending, status: "failed" } : pending)));
        });
    }
    textareaRef.current?.focus();
  };

  const removeAttachment = (localId: string) =>
    setPendingAttachments((previous) => {
      const removed = previous.find((pending) => pending.localId === localId);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return previous.filter((pending) => pending.localId !== localId);
    });

  const readyAttachments = pendingAttachments.flatMap((pending) => (pending.status === "ready" && pending.attachment ? [pending.attachment] : []));
  const uploadingAttachments = pendingAttachments.some((pending) => pending.status === "uploading");

  const commandQuery = /^\/[\w:.-]*$/.test(composerText) ? composerText.slice(1).toLowerCase() : null;
  const commandMenuOpen = commandQuery !== null && !commandMenuDismissed;

  useEffect(() => {
    if (commandMenuOpen) api.listAgentCommands(props.projectId).then(setAgentCommandList).catch(() => setAgentCommandList([]));
  }, [commandMenuOpen, props.projectId]);

  const matchingCommands = useMemo(() => {
    if (commandQuery === null) return [];
    const allCommands: ComposerCommand[] = [
      ...harnoldCommands,
      ...agentCommandList.filter((command) => !harnoldCommands.some((harnoldCommand) => harnoldCommand.name === command.name)).map((command) => ({ ...command, source: "agent" as const })),
    ];
    return allCommands
      .filter((command) => command.name.toLowerCase().includes(commandQuery))
      .sort((first, second) => Number(!first.name.toLowerCase().startsWith(commandQuery)) - Number(!second.name.toLowerCase().startsWith(commandQuery)))
      .slice(0, 50);
  }, [commandQuery, agentCommandList]);

  useEffect(() => setHighlightedCommandIndex(0), [commandQuery]);
  useEffect(() => {
    if (commandQuery === null) setCommandMenuDismissed(false);
  }, [commandQuery]);

  // "@Na|" before the caret (at start or after a space) opens the team list.
  const mentionMatch = props.teamAgents?.length ? /(^|\s)@([^\s@]*)$/.exec(composerText.slice(0, caretPosition)) : null;
  const mentionQuery = mentionMatch ? mentionMatch[2].toLowerCase() : null;
  const matchingTeamAgents = useMemo(
    () => (mentionQuery === null ? [] : (props.teamAgents ?? []).filter((agent) => agent.name.toLowerCase().includes(mentionQuery) || agent.role.toLowerCase().includes(mentionQuery))),
    [mentionQuery, props.teamAgents],
  );
  const mentionMenuOpen = mentionQuery !== null && !mentionMenuDismissed && matchingTeamAgents.length > 0;
  useEffect(() => setHighlightedMentionIndex(0), [mentionQuery]);
  useEffect(() => {
    if (mentionQuery === null) setMentionMenuDismissed(false);
  }, [mentionQuery]);

  const chooseMention = (agent: TeamAgent) => {
    const queryStart = caretPosition - (mentionMatch?.[2].length ?? 0) - 1;
    const nextText = `${composerText.slice(0, queryStart)}@${agent.name} ${composerText.slice(caretPosition)}`;
    const nextCaret = queryStart + agent.name.length + 2;
    setComposerText(nextText);
    setCaretPosition(nextCaret);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCaret, nextCaret);
    });
  };

  useEffect(() => safeStorage.setItem("harnold.permissionMode", permissionMode), [permissionMode]);
  useEffect(() => safeStorage.setItem("harnold.model", model), [model]);

  const insertText = (text: string) => {
    setComposerText((previous) => (previous && !/\s$/.test(previous) ? previous + " " : previous) + text);
    textareaRef.current?.focus();
  };

  useEffect(() => {
    if (props.insertion) insertText(props.insertion.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.insertion]);

  useEffect(() => {
    if (props.droppedFiles) addFiles(props.droppedFiles.files);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.droppedFiles]);

  // Auto-height via CSS `field-sizing: content`; JS only where unsupported (older WebKit).
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || fieldSizingSupported) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 240)}px`;
  }, [composerText]);

  const canSend = (composerText.trim().length > 0 || readyAttachments.length > 0) && !uploadingAttachments && !props.running && !voiceRecorder.recording && !transcribing;

  /** Runs commands Harnold handles itself; true when handled. */
  const runLocalCommand = (text: string): boolean => {
    const parsedCommand = parseCommand(text);
    if (!parsedCommand) return false;
    const { name, commandArguments } = parsedCommand;
    if (name === "plan") {
      setPermissionMode((previous) => (previous === "plan" ? "default" : "plan"));
      return true;
    }
    if (name === "model") {
      const wantedModel = commandArguments.toLowerCase();
      const matchedModel = agentModels.find((agentModel) => agentModel.value.includes(wantedModel) || agentModel.label.toLowerCase().includes(wantedModel));
      if (!wantedModel || !matchedModel) {
        props.onError(new Error(t("Modell: {0}", agentModels.map((agentModel) => agentModel.label).join(", "))));
        return true;
      }
      setModel(matchedModel.value);
      return true;
    }
    return props.onSessionCommand(name, commandArguments);
  };

  const submit = () => {
    if (!canSend && !(composerText.trim().startsWith("/") && !voiceRecorder.recording)) return;
    const text = composerText.trim();
    if (runLocalCommand(text)) {
      setComposerText("");
      return;
    }
    if (!canSend) return;
    props.onSend(text, permissionMode, model || undefined, readyAttachments);
    setComposerText("");
    for (const pending of pendingAttachments) if (pending.previewUrl) URL.revokeObjectURL(pending.previewUrl);
    setPendingAttachments([]);
  };

  const chooseCommand = (command: ComposerCommand) => {
    if (command.argumentHint) {
      setComposerText(`/${command.name} `);
      textareaRef.current?.focus();
      return;
    }
    const text = `/${command.name}`;
    if (runLocalCommand(text)) setComposerText("");
    else if (!props.running) {
      props.onSend(text, permissionMode, model || undefined);
      setComposerText("");
    } else setComposerText(text);
  };

  const systemSpeechRef = useRef<SystemSpeechSession | null>(null);

  const cancelRecording = () => {
    systemSpeechRef.current?.cancel();
    systemSpeechRef.current = null;
    void voiceRecorder.cancel();
  };

  const startRecording = async () => {
    if (props.sttMode === "off") {
      props.onError(new Error(t("Spracherkennung zuerst in Einstellungen → Voice einrichten.")));
      return;
    }
    try {
      await voiceRecorder.start();
      if (props.sttMode === "system") systemSpeechRef.current = startSystemSpeech(props.sttLanguage);
    } catch (microphoneError) {
      props.onError(microphoneError instanceof Error && microphoneError.name === "NotAllowedError" ? new Error(t("Kein Zugriff auf das Mikrofon.")) : microphoneError);
    }
  };

  /** Stops recording and puts the transcript into the composer for editing. */
  const finishRecording = async () => {
    const recordedAudio = await voiceRecorder.stop();
    const systemSpeech = systemSpeechRef.current;
    systemSpeechRef.current = null;
    if (!recordedAudio && !systemSpeech) return;
    setTranscribing(true);
    try {
      const transcript = systemSpeech ? await systemSpeech.finish() : await api.transcribe(recordedAudio!);
      if (transcript) insertText(transcript);
    } catch (transcriptionError) {
      props.onError(transcriptionError);
    } finally {
      setTranscribing(false);
    }
  };

  return (
    <div className="shrink-0 px-4 pt-2 pb-6">
      <div
        className={cn(
          "relative rounded-xl border bg-card shadow-xs transition-shadow duration-150 focus-within:shadow-sm focus-within:ring-1 focus-within:ring-ring/40",
        )}
      >
        {pendingAttachments.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {pendingAttachments.map((pending) => (
              <AttachmentChip
                key={pending.localId}
                name={pending.name}
                mimeType={pending.mimeType}
                size={pending.size}
                previewUrl={pending.previewUrl}
                uploading={pending.status === "uploading"}
                failed={pending.status === "failed"}
                onRemove={() => removeAttachment(pending.localId)}
              />
            ))}
          </div>
        )}
        {mentionMenuOpen && (
          <div
            role="listbox"
            className="absolute right-0 bottom-full left-0 z-20 mb-2 max-h-72 animate-in overflow-y-auto rounded-xl border bg-popover p-1 shadow-lg fade-in slide-in-from-bottom-1 duration-150"
          >
            {matchingTeamAgents.map((agent, agentIndex) => (
              <button
                key={agent.id}
                role="option"
                aria-selected={agentIndex === highlightedMentionIndex}
                className={cn("flex w-full items-baseline gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px]", agentIndex === highlightedMentionIndex && "bg-accent")}
                onMouseEnter={() => setHighlightedMentionIndex(agentIndex)}
                onMouseDown={(mouseEvent) => {
                  mouseEvent.preventDefault();
                  chooseMention(agent);
                }}
              >
                <span className="shrink-0 font-medium">@{agent.name}</span>
                {agent.role && <span className="truncate text-[12px] text-muted-foreground">{agent.role}</span>}
              </button>
            ))}
          </div>
        )}
        {commandMenuOpen && matchingCommands.length > 0 && (
          <div
            role="listbox"
            className="absolute right-0 bottom-full left-0 z-20 mb-2 max-h-72 animate-in overflow-y-auto rounded-xl border bg-popover p-1 shadow-lg fade-in slide-in-from-bottom-1 duration-150"
          >
            {matchingCommands.map((command, commandIndex) => (
              <button
                key={`${command.source}-${command.name}`}
                role="option"
                aria-selected={commandIndex === highlightedCommandIndex}
                className={cn("flex w-full items-baseline gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px]", commandIndex === highlightedCommandIndex && "bg-accent")}
                onMouseEnter={() => setHighlightedCommandIndex(commandIndex)}
                onMouseDown={(mouseEvent) => {
                  mouseEvent.preventDefault();
                  chooseCommand(command);
                }}
              >
                <span className="shrink-0 font-mono font-medium">/{command.name}</span>
                {command.argumentHint && <span className="shrink-0 font-mono text-[12px] text-muted-foreground">{command.argumentHint}</span>}
                <span className="truncate text-[12px] text-muted-foreground">{command.description}</span>
              </button>
            ))}
          </div>
        )}
        <div className="flex items-end gap-1.5 p-2 pl-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            accept="image/*,application/pdf,.txt,.md,.csv,.json,.docx,.xlsx,.pptx,.html,.xml,.yaml,.yml"
            onChange={(changeEvent) => {
              addFiles([...(changeEvent.target.files ?? [])]);
              changeEvent.target.value = "";
            }}
          />
          <Button size="icon" variant="ghost" className="size-8 shrink-0 rounded-full text-muted-foreground" aria-label={t("Datei anhängen")} onClick={() => fileInputRef.current?.click()}>
            <Paperclip className="size-4" />
          </Button>
          {voiceRecorder.recording ? (
            <div className="flex min-h-8 flex-1 animate-in items-center gap-3 py-1.5 fade-in duration-200">
              <span className="relative flex size-2.5">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-destructive/60" />
                <span className="relative inline-flex size-2.5 rounded-full bg-destructive" />
              </span>
              <span className="text-[13px] tabular-nums">{formatDuration(voiceRecorder.elapsedSeconds)}</span>
              <div className="flex h-5 flex-1 items-center gap-[3px]" aria-hidden>
                {Array.from({ length: 24 }, (_, barIndex) => (
                  <span
                    key={barIndex}
                    className="w-[3px] rounded-full bg-foreground/50 transition-[height] duration-100"
                    style={{ height: `${Math.max(12, Math.min(100, voiceRecorder.inputLevel * 220 * (0.55 + 0.45 * Math.sin(barIndex * 1.7 + voiceRecorder.elapsedSeconds))))}%` }}
                  />
                ))}
              </div>
            </div>
          ) : (
            <textarea
              ref={textareaRef}
              rows={1}
              value={composerText}
              placeholder={transcribing ? t("Transkribiere …") : props.placeholder}
              disabled={transcribing}
              onChange={(changeEvent) => {
                setComposerText(changeEvent.target.value);
                setCaretPosition(changeEvent.target.selectionStart ?? changeEvent.target.value.length);
              }}
              onSelect={(selectEvent) => setCaretPosition(selectEvent.currentTarget.selectionStart ?? 0)}
              onPaste={(clipboardEvent) => {
                const pastedFiles = [...clipboardEvent.clipboardData.files];
                if (!pastedFiles.length) return;
                clipboardEvent.preventDefault();
                addFiles(pastedFiles);
              }}
              onKeyDown={(keyboardEvent) => {
                if (mentionMenuOpen) {
                  if (keyboardEvent.key === "ArrowDown" || keyboardEvent.key === "ArrowUp") {
                    keyboardEvent.preventDefault();
                    const step = keyboardEvent.key === "ArrowDown" ? 1 : -1;
                    setHighlightedMentionIndex((previous) => (previous + step + matchingTeamAgents.length) % matchingTeamAgents.length);
                    return;
                  }
                  if ((keyboardEvent.key === "Enter" && !keyboardEvent.shiftKey) || keyboardEvent.key === "Tab") {
                    keyboardEvent.preventDefault();
                    chooseMention(matchingTeamAgents[highlightedMentionIndex] ?? matchingTeamAgents[0]);
                    return;
                  }
                  if (keyboardEvent.key === "Escape") {
                    keyboardEvent.preventDefault();
                    setMentionMenuDismissed(true);
                    return;
                  }
                }
                if (commandMenuOpen && matchingCommands.length > 0) {
                  if (keyboardEvent.key === "ArrowDown" || keyboardEvent.key === "ArrowUp") {
                    keyboardEvent.preventDefault();
                    const step = keyboardEvent.key === "ArrowDown" ? 1 : -1;
                    setHighlightedCommandIndex((previous) => (previous + step + matchingCommands.length) % matchingCommands.length);
                    return;
                  }
                  if ((isActionEnter(keyboardEvent) && !keyboardEvent.shiftKey) || keyboardEvent.key === "Tab") {
                    keyboardEvent.preventDefault();
                    chooseCommand(matchingCommands[highlightedCommandIndex] ?? matchingCommands[0]);
                    return;
                  }
                  if (keyboardEvent.key === "Escape") {
                    keyboardEvent.preventDefault();
                    setCommandMenuDismissed(true);
                    return;
                  }
                }
                if (keyboardEvent.key === "Enter" && !keyboardEvent.shiftKey) {
                  keyboardEvent.preventDefault();
                  if (isActionEnter(keyboardEvent)) submit();
                }
              }}
              className="max-h-60 min-h-8 flex-1 resize-none bg-transparent [field-sizing:content] py-1.5 text-[14px] outline-none placeholder:text-muted-foreground"
            />
          )}

          {voiceRecorder.recording ? (
            <>
              <Button size="icon" variant="ghost" className="size-8 shrink-0 rounded-full text-muted-foreground" onClick={cancelRecording} aria-label={t("Aufnahme verwerfen")}>
                <X className="size-4" />
              </Button>
              <Button size="icon" className="size-8 shrink-0 rounded-full" onClick={() => void finishRecording()} aria-label={t("Aufnahme beenden")}>
                <ArrowUp className="size-4" />
              </Button>
            </>
          ) : (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-8 shrink-0 rounded-full text-muted-foreground"
                    disabled={transcribing}
                    onClick={() => void startRecording()}
                    aria-label={t("Sprachnachricht aufnehmen")}
                  >
                    {transcribing ? <Loader2 className="size-4 animate-spin" /> : <Mic className="size-4" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{props.sttMode !== "off" ? t("Sprachnachricht") : t("Voice in den Einstellungen einrichten")}</TooltipContent>
              </Tooltip>
              {props.running ? (
                <Button size="icon" variant="secondary" className="size-8 shrink-0 rounded-full" onClick={props.onInterrupt} aria-label={t("Stopp")}>
                  <Square className="size-3 fill-current" />
                </Button>
              ) : (
                <Button
                  size="icon"
                  className={cn("size-8 shrink-0 rounded-full transition-opacity duration-150", !canSend && "opacity-30")}
                  disabled={!canSend}
                  onClick={submit}
                  aria-label={t("Senden")}
                >
                  <ArrowUp className="size-4" />
                </Button>
              )}
            </>
          )}
        </div>
      </div>
      <div className="mt-2 flex items-center justify-end gap-2">
        {props.footerStart && <div className="mr-auto min-w-0">{props.footerStart}</div>}
        {props.ttsReady && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                aria-pressed={props.readAloud}
                className={cn("h-7 gap-1.5 px-2 text-[12px] transition-colors", props.readAloud ? "text-foreground" : "text-muted-foreground")}
                onClick={() => props.onReadAloudChange(!props.readAloud)}
              >
                {props.readAloud ? <Volume2 className="size-3.5" /> : <VolumeX className="size-3.5" />}
                {t("Vorlesen")}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("Antworten automatisch vorlesen")}</TooltipContent>
          </Tooltip>
        )}
        <ModelSelect compact value={model} onChange={setModel} inherited={props.inheritedModel} />
        <Select value={permissionMode} onValueChange={(value) => setPermissionMode(value as PermissionMode)}>
          <SelectTrigger size="sm" className="h-7 border-0 bg-transparent text-[12px] shadow-none hover:bg-foreground/5">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            {permissionModeOptions.map((permissionOption) => (
              <SelectItem key={permissionOption.value} value={permissionOption.value}>
                {permissionOption.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
