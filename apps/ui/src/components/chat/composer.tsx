import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, FileUp, Folder, FolderPlus, Loader2, Mic, Paperclip, Square, Volume2, VolumeX, X } from "lucide-react";
import { startSystemSpeech, type SystemSpeechSession } from "@/lib/system-speech";
import type { AgentCommand, Attachment, EffortLevel, PermissionMode, TeamAgent } from "@/types";
import { AttachmentChip } from "./attachment-views";
import { api } from "@/api";
import { cn, isActionEnter } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { safeStorage } from "@/lib/storage";
import { useVoiceRecorder } from "@/hooks/use-voice-recorder";
import { permissionModeOptions } from "@/components/form-field";
import { getAgentModels, ModelEffortPicker, useAgentModels, type InheritedModel } from "@/components/model-select";
import { t } from "@/lib/i18n";

/** Window event: the agent changed the permission mode of the open session (detail = new mode). */
export const permissionModeChangedEvent = "harnold:permission-mode-changed";


const fieldSizingSupported = CSS.supports("field-sizing", "content");

type ComposerCommand = AgentCommand & { source: "harnold" | "agent" };

/** Harnold's own commands; /compact etc. go to the agent. */
const harnoldCommands: ComposerCommand[] = [
  { name: "clear", description: t("Verlauf und Kontext leeren"), argumentHint: "", source: "harnold" },
  { name: "new", description: t("Neue Session"), argumentHint: "", source: "harnold" },
  { name: "rename", description: t("Session umbenennen"), argumentHint: "<Titel>", source: "harnold" },
  { name: "move", description: t("In anderes Projekt / andere Umgebung verschieben"), argumentHint: "", source: "harnold" },
  { name: "add-dir", description: t("Lokalen Ordner zum Chat hinzufügen"), argumentHint: "[Pfad]", source: "harnold" },
  { name: "model", description: t("Modell wechseln"), argumentHint: "", source: "harnold" },
  { name: "plan", description: t("Plan-Modus an/aus"), argumentHint: "", source: "harnold" },
];

function parseCommand(text: string): { name: string; commandArguments: string } | null {
  const commandMatch = /^\/([\w:.-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return commandMatch ? { name: commandMatch[1], commandArguments: (commandMatch[2] ?? "").trim() } : null;
}

type ComposerProps = {
  /** Model used when none is picked here (environment or settings). */
  inheritedModel: InheritedModel;
  /** Identifies the conversation (session id, or the project while none exists yet): draft and model belong to it, not to the composer. */
  draftKey: string;
  /** Model saved for this conversation ("" = inherited). */
  sessionModel: string;
  /** The user picked another model for this conversation. */
  onModelChange: (model: string) => void;
  placeholder: string;
  projectId: string;
  /** Session-level commands (/clear, /new, /rename, /move); returns false when it is not one. */
  onSessionCommand: (commandName: string, commandArguments: string) => boolean;
  running: boolean;
  /** The agent takes messages into the running turn (otherwise they are queued). */
  canSteer?: boolean;
  /** The agent program supports an effort level (Claude Code). */
  canChooseEffort?: boolean;
  insertion: { text: string; nonce: number } | null;
  /** Files dropped anywhere on the chat; attached like files picked here. */
  droppedFiles: { files: File[]; nonce: number } | null;
  /** "system": free recognition of the browser/OS, "server": provider configured in the Core. */
  sttMode: "off" | "system" | "server";
  sttLanguage: string;
  ttsReady: boolean;
  readAloud: boolean;
  onReadAloudChange: (readAloud: boolean) => void;
  onSend: (text: string, permissionMode: PermissionMode, model?: string, attachments?: Attachment[], effort?: EffortLevel) => void;
  onInterrupt: () => void;
  onError: (unknownError: unknown) => void;
  /** Team members of the project; "@" lists them, a mention hands the message to them. */
  teamAgents?: TeamAgent[];
  /** Left side of the row under the input (e.g. project quick select). */
  footerStart?: React.ReactNode;
  /** Context window indicator; gets the model picked here (window size depends on it). */
  contextIndicator?: (model: string) => React.ReactNode;
  /** Local folders added to this chat; without onAddDirectory the option is hidden (no session yet). */
  directories?: string[];
  onAddDirectory?: () => void;
  /** Unlocks a folder for every session of the project (memory level "project"). */
  onAddProjectFolder?: () => void;
  onRemoveDirectory?: (directory: string) => void;
};

/** A file in the composer: uploads right away, is sent with the next message. */
type PendingAttachment = {
  localId: string;
  name: string;
  mimeType: string;
  size: number;
  previewUrl?: string;
  status: "uploading" | "ready" | "failed";
  attachment?: Attachment;
  /** Set when a long paste was turned into a text file; lets the user put it back inline. */
  pastedText?: string;
};

/** Pastes from this size on become a .txt attachment (like Claude), so the message itself stays short. */
const pastedTextAttachmentCharacterCount = 2500;
const pastedTextAttachmentLineCount = 40;
const lineCountOf = (text: string) => text.split("\n").length;

function formatDuration(totalSeconds: number) {
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

/** A running dictation: local recognition types live into the composer, the server variant transcribes at the end. */
type Listening = { kind: "system"; session: SystemSpeechSession; baseText: string } | { kind: "server"; baseText: string };

/** Appends dictation to what already stood in the composer. */
function joinSpokenText(baseText: string, transcript: string) {
  const spokenText = transcript.trim();
  if (!spokenText) return baseText;
  if (!baseText.trim()) return spokenText;
  return /\s$/.test(baseText) ? baseText + spokenText : `${baseText} ${spokenText}`;
}

/** Unsent texts per conversation, so a draft never shows up in another session. */
const drafts = new Map<string, string>();

export function Composer(props: ComposerProps) {
  const [composerText, setComposerText] = useState(() => drafts.get(props.draftKey) ?? "");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    (safeStorage.getItem("harnold.permissionMode") as PermissionMode | null) ?? "default",
  );
  // "" = inherited model.
  const [pickedModel, setPickedModel] = useState(props.sessionModel);
  const setModel = (nextModel: string) => {
    setPickedModel(nextModel);
    props.onModelChange(nextModel);
  };
  // A model of another provider (switched in the meantime) falls back to the inherited one.
  const availableModels = useAgentModels();
  const model = availableModels.some((availableModel) => availableModel.value === pickedModel) ? pickedModel : "";
  const [transcribing, setTranscribing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const voiceRecorder = useVoiceRecorder();
  const [listening, setListening] = useState<Listening | null>(null);
  const [listeningSeconds, setListeningSeconds] = useState(0);

  // Leaving the composer (session switch, project change) ends the dictation instead of keeping the mic open.
  const listeningRef = useRef<Listening | null>(null);
  listeningRef.current = listening;
  useEffect(
    () => () => {
      const session = listeningRef.current;
      if (session?.kind === "system") session.session.abort();
    },
    [],
  );

  // Counts the dictation, whatever does the recognizing.
  useEffect(() => {
    if (!listening) return;
    const startedAt = Date.now();
    setListeningSeconds(0);
    const timer = window.setInterval(() => setListeningSeconds(Math.floor((Date.now() - startedAt) / 1000)), 500);
    return () => window.clearInterval(timer);
  }, [listening]);
  const [agentCommandList, setAgentCommandList] = useState<AgentCommand[]>([]);
  const [highlightedCommandIndex, setHighlightedCommandIndex] = useState(0);
  const [commandMenuDismissed, setCommandMenuDismissed] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  // Another conversation: park this one's draft, load the other's draft and model.
  const [shownDraftKey, setShownDraftKey] = useState(props.draftKey);
  if (shownDraftKey !== props.draftKey) {
    if (composerText) drafts.set(shownDraftKey, composerText);
    else drafts.delete(shownDraftKey);
    for (const pending of pendingAttachments) if (pending.previewUrl) URL.revokeObjectURL(pending.previewUrl);
    setShownDraftKey(props.draftKey);
    setComposerText(drafts.get(props.draftKey) ?? "");
    setPendingAttachments([]);
    setPickedModel(props.sessionModel);
  }
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [caretPosition, setCaretPosition] = useState(0);
  const [highlightedMentionIndex, setHighlightedMentionIndex] = useState(0);
  const [mentionMenuDismissed, setMentionMenuDismissed] = useState(false);

  const addFiles = (files: File[], pastedText?: string) => {
    for (const file of files) {
      const localId = crypto.randomUUID();
      const isImage = file.type.startsWith("image/");
      setPendingAttachments((previous) => [
        ...previous,
        { localId, name: file.name || t("Einfügung.png"), mimeType: file.type, size: file.size, previewUrl: isImage ? URL.createObjectURL(file) : undefined, status: "uploading", pastedText },
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

  /** Inserts text at the caret (replacing a selection), as a normal paste would. */
  const insertTextAtCaret = (insertedText: string) => {
    const textarea = textareaRef.current;
    const selectionStart = textarea?.selectionStart ?? composerText.length;
    const selectionEnd = textarea?.selectionEnd ?? composerText.length;
    const nextText = composerText.slice(0, selectionStart) + insertedText + composerText.slice(selectionEnd);
    setComposerText(nextText);
    const nextCaret = selectionStart + insertedText.length;
    setCaretPosition(nextCaret);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCaret, nextCaret);
    });
  };

  const attachPastedText = (pastedText: string) => {
    const pastedNumber = pendingAttachments.filter((pending) => pending.pastedText !== undefined).length + 1;
    const fileName = pastedNumber > 1 ? t("Eingefügter Text {0}.txt", pastedNumber) : t("Eingefügter Text.txt");
    addFiles([new File([pastedText], fileName, { type: "text/plain" })], pastedText);
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
  /** "" = the model's default effort. */
  const [effort, setEffort] = useState<EffortLevel | "">((safeStorage.getItem("harnold.effort") as EffortLevel | null) ?? "");
  useEffect(() => safeStorage.setItem("harnold.effort", effort), [effort]);
  const chosenEffort = props.canChooseEffort && effort ? effort : undefined;
  // The agent switched the mode (plan approved → edits automatic or one by one).
  useEffect(() => {
    const followAgentMode = (event: Event) => setPermissionMode((event as CustomEvent<PermissionMode>).detail);
    window.addEventListener(permissionModeChangedEvent, followAgentMode);
    return () => window.removeEventListener(permissionModeChangedEvent, followAgentMode);
  }, []);

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

  // Sending works while dictating: the recording is stopped first and what was said is sent.
  const canSend = (composerText.trim().length > 0 || readyAttachments.length > 0 || listening !== null) && !uploadingAttachments && !transcribing;

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
      const agentModels = getAgentModels();
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

  /** Clears input and attachments after a message was handed over. */
  const resetComposer = () => {
    setComposerText("");
    for (const pending of pendingAttachments) if (pending.previewUrl) URL.revokeObjectURL(pending.previewUrl);
    setPendingAttachments([]);
  };

  const submit = () => {
    if (listening) {
      void sendWhatWasSaid();
      return;
    }
    if (!canSend && !composerText.trim().startsWith("/")) return;
    const text = composerText.trim();
    if (runLocalCommand(text)) {
      setComposerText("");
      return;
    }
    if (!canSend) return;
    props.onSend(text, permissionMode, model || undefined, readyAttachments, chosenEffort);
    resetComposer();
  };

  /** Send button while dictating: stop listening, keep the text, send it right away. */
  const sendWhatWasSaid = async () => {
    const text = (await stopListening()).trim();
    if (!text && !readyAttachments.length) return;
    props.onSend(text, permissionMode, model || undefined, readyAttachments, chosenEffort);
    resetComposer();
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
      props.onSend(text, permissionMode, model || undefined, undefined, chosenEffort);
      setComposerText("");
    } else setComposerText(text);
  };

  const startListening = async () => {
    if (props.sttMode === "off") {
      props.onError(new Error(t("Spracherkennung zuerst in Einstellungen → Voice einrichten.")));
      return;
    }
    const baseText = composerText;
    if (props.sttMode === "system") {
      try {
        // Local recognition types along live; the cursor stays at the end of the growing text.
        const session = startSystemSpeech(props.sttLanguage, (transcript) => {
          const nextText = joinSpokenText(baseText, transcript);
          setComposerText(nextText);
          setCaretPosition(nextText.length);
        });
        setListening({ kind: "system", session, baseText });
        requestAnimationFrame(() => textareaRef.current?.focus());
      } catch (speechError) {
        props.onError(speechError);
      }
      return;
    }
    try {
      await voiceRecorder.start();
      setListening({ kind: "server", baseText });
      requestAnimationFrame(() => textareaRef.current?.focus());
    } catch (microphoneError) {
      props.onError(microphoneError instanceof Error && microphoneError.name === "NotAllowedError" ? new Error(t("Kein Zugriff auf das Mikrofon.")) : microphoneError);
    }
  };

  /** Stops listening at that point and keeps the text – nothing is sent, nothing is lost. */
  const stopListening = async (): Promise<string> => {
    const session = listening;
    setListening(null);
    if (!session) return composerText;
    if (session.kind === "system") {
      try {
        const text = joinSpokenText(session.baseText, await session.session.finish());
        setComposerText(text);
        return text;
      } catch (speechError) {
        props.onError(speechError);
        return session.baseText;
      }
    }
    const recordedAudio = await voiceRecorder.stop();
    if (!recordedAudio) return session.baseText;
    setTranscribing(true);
    try {
      const text = joinSpokenText(session.baseText, await api.transcribe(recordedAudio));
      setComposerText(text);
      return text;
    } catch (transcriptionError) {
      props.onError(transcriptionError);
      return session.baseText;
    } finally {
      setTranscribing(false);
    }
  };

  const discardListening = () => {
    const session = listening;
    setListening(null);
    if (!session) return;
    if (session.kind === "system") session.session.abort();
    else void voiceRecorder.discard();
    setComposerText(session.baseText);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  return (
    <div className="shrink-0 px-4 pt-2 pb-6">
      <div
        className={cn(
          "relative rounded-xl border bg-card shadow-xs transition-shadow duration-150 focus-within:shadow-sm focus-within:ring-1 focus-within:ring-ring/40",
        )}
      >
        {(props.directories?.length ?? 0) > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-3">
            {props.directories?.map((directory) => (
              <span key={directory} title={directory} className="flex max-w-64 items-center gap-1.5 rounded-md border bg-foreground/[0.03] py-0.5 pr-1 pl-2 text-[12px]">
                <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{directory.split(/[\\/]/).filter(Boolean).at(-1) ?? directory}</span>
                {props.onRemoveDirectory && (
                  <button type="button" className="rounded p-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground" aria-label={t("Ordner entfernen")} onClick={() => props.onRemoveDirectory?.(directory)}>
                    <X className="size-3" />
                  </button>
                )}
              </span>
            ))}
          </div>
        )}
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
                detail={pending.pastedText !== undefined ? t("{0} Zeilen", lineCountOf(pending.pastedText)) : undefined}
                onInsertAsText={
                  pending.pastedText !== undefined
                    ? () => {
                        removeAttachment(pending.localId);
                        insertTextAtCaret(pending.pastedText!);
                      }
                    : undefined
                }
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
          {props.onAddDirectory ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon" variant="ghost" className="size-8 shrink-0 rounded-full text-muted-foreground" aria-label={t("Hinzufügen")}>
                  <Paperclip className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="top">
                <DropdownMenuItem onSelect={() => fileInputRef.current?.click()}>
                  <FileUp className="size-4" /> {t("Datei anhängen")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => props.onAddDirectory?.()}>
                  <FolderPlus className="size-4" /> {t("Ordner hinzufügen")}
                </DropdownMenuItem>
                {props.onAddProjectFolder && (
                  <DropdownMenuItem onSelect={() => props.onAddProjectFolder?.()}>
                    <Folder className="size-4" /> {t("Ordner für das ganze Projekt")}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Button size="icon" variant="ghost" className="size-8 shrink-0 rounded-full text-muted-foreground" aria-label={t("Datei anhängen")} onClick={() => fileInputRef.current?.click()}>
              <Paperclip className="size-4" />
            </Button>
          )}
          <textarea
            ref={textareaRef}
            rows={1}
            value={composerText}
            placeholder={listening ? t("Zuhören …") : transcribing ? t("Transkribiere …") : props.placeholder}
            disabled={transcribing}
            onChange={(changeEvent) => {
              setComposerText(changeEvent.target.value);
              setCaretPosition(changeEvent.target.selectionStart ?? changeEvent.target.value.length);
            }}
            onSelect={(selectEvent) => setCaretPosition(selectEvent.currentTarget.selectionStart ?? 0)}
            onPaste={(clipboardEvent) => {
              const pastedFiles = [...clipboardEvent.clipboardData.files];
              if (pastedFiles.length) {
                clipboardEvent.preventDefault();
                addFiles(pastedFiles);
                return;
              }
              const pastedText = clipboardEvent.clipboardData.getData("text/plain");
              if (pastedText.length >= pastedTextAttachmentCharacterCount || lineCountOf(pastedText) >= pastedTextAttachmentLineCount) {
                clipboardEvent.preventDefault();
                attachPastedText(pastedText);
              }
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

          {listening && (
            <div className="mb-1 flex shrink-0 animate-in items-center gap-1.5 rounded-full bg-destructive/10 px-2 py-1 text-[11.5px] tabular-nums text-destructive fade-in duration-200" aria-live="polite">
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-destructive/60" />
                <span className="relative inline-flex size-2 rounded-full bg-destructive" />
              </span>
              {formatDuration(listeningSeconds)}
            </div>
          )}

          {listening && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="icon" variant="ghost" className="size-8 shrink-0 rounded-full text-muted-foreground" onClick={discardListening} aria-label={t("Aufnahme verwerfen")}>
                  <X className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("Aufnahme verwerfen")}</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant={listening ? "secondary" : "ghost"}
                className={cn("size-8 shrink-0 rounded-full", listening ? "text-destructive" : "text-muted-foreground")}
                disabled={transcribing}
                onClick={() => (listening ? void stopListening() : void startListening())}
                aria-label={listening ? t("Zuhören beenden") : t("Diktieren")}
              >
                {transcribing ? <Loader2 className="size-4 animate-spin" /> : listening ? <Square className="size-3 fill-current" /> : <Mic className="size-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {props.sttMode === "off" ? t("Voice in den Einstellungen einrichten") : listening ? t("Zuhören beenden") : t("Diktieren")}
            </TooltipContent>
          </Tooltip>
          {props.running && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="icon" variant="secondary" className="size-8 shrink-0 rounded-full" onClick={props.onInterrupt} aria-label={t("Stopp")}>
                  <Square className="size-3 fill-current" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("Stopp")}</TooltipContent>
            </Tooltip>
          )}
          {props.running ? (
            canSend && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button size="icon" className="size-8 shrink-0 rounded-full" onClick={submit} aria-label={props.canSteer ? t("Nachschieben") : t("Einreihen")}>
                    <ArrowUp className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{props.canSteer ? t("Nachschieben – der Agent liest es nach seinem aktuellen Schritt") : t("Einreihen – startet nach dem laufenden Durchlauf")}</TooltipContent>
              </Tooltip>
            )
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
        {props.contextIndicator?.(model)}
        <ModelEffortPicker
          value={model}
          onChange={setModel}
          inherited={props.inheritedModel}
          effort={effort}
          onEffortChange={props.canChooseEffort ? setEffort : undefined}
        />
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
