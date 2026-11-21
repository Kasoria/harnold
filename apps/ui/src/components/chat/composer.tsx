import { useEffect, useRef, useState } from "react";
import { ArrowUp, Loader2, Mic, Square, Volume2, VolumeX, X } from "lucide-react";
import type { PermissionMode } from "@/types";
import { api } from "@/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { safeStorage } from "@/lib/storage";
import { useVoiceRecorder } from "@/hooks/use-voice-recorder";
import { modelOptions, permissionModeOptions } from "@/components/form-field";

type ComposerProps = {
  placeholder: string;
  running: boolean;
  insertion: { text: string; nonce: number } | null;
  sttReady: boolean;
  ttsReady: boolean;
  readAloud: boolean;
  onReadAloudChange: (readAloud: boolean) => void;
  onSend: (text: string, permissionMode: PermissionMode, model?: string) => void;
  onInterrupt: () => void;
  onError: (unknownError: unknown) => void;
};

function formatDuration(totalSeconds: number) {
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

export function Composer(props: ComposerProps) {
  const [composerText, setComposerText] = useState("");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    (safeStorage.getItem("harnold.permissionMode") as PermissionMode | null) ?? "default",
  );
  const [model, setModel] = useState(safeStorage.getItem("harnold.model") ?? "default");
  const [transcribing, setTranscribing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const voiceRecorder = useVoiceRecorder();

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
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 240)}px`;
  }, [composerText]);

  const canSend = composerText.trim().length > 0 && !props.running && !voiceRecorder.recording && !transcribing;

  const submit = () => {
    if (!canSend) return;
    props.onSend(composerText.trim(), permissionMode, model === "default" ? undefined : model);
    setComposerText("");
  };

  const startRecording = async () => {
    if (!props.sttReady) {
      props.onError(new Error("Spracherkennung zuerst in Einstellungen → Voice einrichten."));
      return;
    }
    try {
      await voiceRecorder.start();
    } catch (microphoneError) {
      props.onError(microphoneError instanceof Error && microphoneError.name === "NotAllowedError" ? new Error("Kein Zugriff auf das Mikrofon.") : microphoneError);
    }
  };

  /** Stops recording and puts the transcript into the composer for editing. */
  const finishRecording = async () => {
    const recordedAudio = await voiceRecorder.stop();
    if (!recordedAudio) return;
    setTranscribing(true);
    try {
      const transcript = await api.transcribe(recordedAudio);
      if (transcript) insertText(transcript);
    } catch (transcriptionError) {
      props.onError(transcriptionError);
    } finally {
      setTranscribing(false);
    }
  };

  return (
    <div className="shrink-0 px-4 pt-2 pb-3">
      <div className="relative rounded-xl border bg-card shadow-xs transition-shadow duration-150 focus-within:shadow-sm focus-within:ring-1 focus-within:ring-ring/40">
        <div className="flex items-end gap-1.5 p-2 pl-3">
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
              placeholder={transcribing ? "Transkribiere …" : props.placeholder}
              disabled={transcribing}
              onChange={(changeEvent) => setComposerText(changeEvent.target.value)}
              onKeyDown={(keyboardEvent) => {
                if (keyboardEvent.key === "Enter" && !keyboardEvent.shiftKey && !keyboardEvent.nativeEvent.isComposing) {
                  keyboardEvent.preventDefault();
                  submit();
                }
              }}
              className="max-h-60 min-h-8 flex-1 resize-none bg-transparent py-1.5 text-[14px] outline-none placeholder:text-muted-foreground"
            />
          )}

          {voiceRecorder.recording ? (
            <>
              <Button size="icon" variant="ghost" className="size-8 shrink-0 rounded-full text-muted-foreground" onClick={() => void voiceRecorder.cancel()} aria-label="Aufnahme verwerfen">
                <X className="size-4" />
              </Button>
              <Button size="icon" className="size-8 shrink-0 rounded-full" onClick={() => void finishRecording()} aria-label="Aufnahme beenden">
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
                    aria-label="Sprachnachricht aufnehmen"
                  >
                    {transcribing ? <Loader2 className="size-4 animate-spin" /> : <Mic className="size-4" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{props.sttReady ? "Sprachnachricht" : "Voice in den Einstellungen einrichten"}</TooltipContent>
              </Tooltip>
              {props.running ? (
                <Button size="icon" variant="secondary" className="size-8 shrink-0 rounded-full" onClick={props.onInterrupt} aria-label="Stopp">
                  <Square className="size-3 fill-current" />
                </Button>
              ) : (
                <Button
                  size="icon"
                  className={cn("size-8 shrink-0 rounded-full transition-opacity duration-150", !canSend && "opacity-30")}
                  disabled={!canSend}
                  onClick={submit}
                  aria-label="Senden"
                >
                  <ArrowUp className="size-4" />
                </Button>
              )}
            </>
          )}
        </div>
      </div>
      <div className="mt-2 flex items-center justify-end gap-2">
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
                Vorlesen
              </Button>
            </TooltipTrigger>
            <TooltipContent>Antworten automatisch vorlesen</TooltipContent>
          </Tooltip>
        )}
        <Select value={model} onValueChange={setModel}>
          <SelectTrigger size="sm" className="h-7 border-0 bg-transparent text-[12px] shadow-none hover:bg-foreground/5">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            {modelOptions.map((modelOption) => (
              <SelectItem key={modelOption.value} value={modelOption.value}>
                {modelOption.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
