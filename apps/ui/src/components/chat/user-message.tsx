import { useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, Pencil, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn, isActionEnter } from "@/lib/utils";
import { CopyButton } from "./chat-markdown";
import { SentAttachments } from "./attachment-views";
import type { Attachment } from "@/types";
import { t } from "@/lib/i18n";

type UserMessageProps = {
  text: string;
  projectId: string | null;
  attachments: Attachment[];
  /** Versions of this message (original + edits); null when there is only one. */
  versions: { currentIndex: number; total: number } | null;
  onShowVersion: (versionIndex: number) => void;
  /** False while a turn runs. */
  canEdit: boolean;
  /** Sends the edited text as a new version of the conversation from here on. */
  onSubmitEdit: (text: string) => void;
  /** Restore the project files to their state before this message (only where the agent program supports it). */
  onRewindFiles?: () => void;
};

/** Long messages (a pasted log, a long brief) start collapsed so the conversation stays readable. */
const collapsibleCharacterCount = 900;
const collapsibleLineCount = 14;
const isLongMessage = (text: string) => text.length > collapsibleCharacterCount || text.split("\n").length > collapsibleLineCount;

const hoverActionClassName = "h-6 px-1 text-[11.5px] text-muted-foreground opacity-0 transition-opacity duration-150 group-hover/user:opacity-100 focus-visible:opacity-100";

export function UserMessage(props: UserMessageProps) {
  const [editDraft, setEditDraft] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const collapsible = isLongMessage(props.text);
  const collapsed = collapsible && !expanded;

  if (editDraft !== null) {
    const submit = () => {
      if (!editDraft.trim()) return;
      props.onSubmitEdit(editDraft.trim());
      setEditDraft(null);
    };
    return (
      <form
        className="w-full animate-in self-end rounded-xl border bg-card p-2 shadow-xs fade-in duration-150"
        onSubmit={(formEvent) => {
          formEvent.preventDefault();
          submit();
        }}
      >
        <textarea
          autoFocus
          aria-label={t("Nachricht bearbeiten")}
          value={editDraft}
          onChange={(changeEvent) => setEditDraft(changeEvent.target.value)}
          onFocus={(focusEvent) => focusEvent.currentTarget.setSelectionRange(focusEvent.currentTarget.value.length, focusEvent.currentTarget.value.length)}
          onKeyDown={(keyboardEvent) => {
            if (keyboardEvent.key === "Escape") setEditDraft(null);
            if (keyboardEvent.key === "Enter" && !keyboardEvent.shiftKey) {
              keyboardEvent.preventDefault();
              if (isActionEnter(keyboardEvent)) submit();
            }
          }}
          className="max-h-80 min-h-12 w-full resize-none bg-transparent px-1.5 py-1 text-[14px] outline-none [field-sizing:content]"
        />
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" size="sm" variant="ghost" onClick={() => setEditDraft(null)}>
            {t("Abbrechen")}
          </Button>
          <Button type="submit" size="sm" disabled={!editDraft.trim() || !props.canEdit}>
            {t("Senden")}
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div className="group/user flex max-w-[85%] animate-in flex-col items-end self-end fade-in duration-200">
      {props.attachments.length > 0 && props.projectId && (
        <div className="mb-1.5">
          <SentAttachments projectId={props.projectId} attachments={props.attachments} />
        </div>
      )}
      {props.text && (
        <div className="rounded-xl bg-muted px-3.5 py-2">
          <div
            className={cn("whitespace-pre-wrap", collapsed && "max-h-60 overflow-hidden [mask-image:linear-gradient(to_bottom,black_65%,transparent)]")}
          >
            {props.text}
          </div>
          {collapsible && (
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpanded((previous) => !previous)}
              className="mt-1 flex items-center gap-1 text-[12px] text-muted-foreground transition-colors duration-150 hover:text-foreground"
            >
              <ChevronDown className={cn("size-3.5 transition-transform duration-150", expanded && "rotate-180")} />
              {expanded ? t("Weniger anzeigen") : t("Ganze Nachricht anzeigen ({0} Zeilen)", props.text.split("\n").length)}
            </button>
          )}
        </div>
      )}
      <div className="mt-0.5 flex items-center gap-0.5">
        <CopyButton readText={() => props.text} label={t("Kopieren")} className={hoverActionClassName} />
        {props.canEdit && (
          <Button variant="ghost" size="sm" className={cn(hoverActionClassName, "gap-1")} onClick={() => setEditDraft(props.text)}>
            <Pencil className="size-3" /> {t("Bearbeiten")}
          </Button>
        )}
        {props.canEdit && props.onRewindFiles && (
          <Button variant="ghost" size="sm" className={cn(hoverActionClassName, "gap-1")} title={t("Dateien auf den Stand vor dieser Nachricht zurücksetzen")} onClick={props.onRewindFiles}>
            <RotateCcw className="size-3" /> {t("Dateien zurücksetzen")}
          </Button>
        )}
        {props.versions && (
          <span className="flex items-center text-[11.5px] text-muted-foreground tabular-nums">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t("Vorherige Version")}
              disabled={props.versions.currentIndex === 0}
              onClick={() => props.onShowVersion(props.versions!.currentIndex - 1)}
            >
              <ChevronLeft />
            </Button>
            {props.versions.currentIndex + 1}/{props.versions.total}
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t("Nächste Version")}
              disabled={props.versions.currentIndex === props.versions.total - 1}
              onClick={() => props.onShowVersion(props.versions!.currentIndex + 1)}
            >
              <ChevronRight />
            </Button>
          </span>
        )}
      </div>
    </div>
  );
}
