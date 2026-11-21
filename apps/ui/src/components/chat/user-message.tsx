import { useState } from "react";
import { ChevronLeft, ChevronRight, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn, isActionEnter } from "@/lib/utils";
import { CopyButton } from "./chat-markdown";

type UserMessageProps = {
  text: string;
  /** Versions of this message (original + edits); null when there is only one. */
  versions: { currentIndex: number; total: number } | null;
  onShowVersion: (versionIndex: number) => void;
  /** False while a turn runs. */
  canEdit: boolean;
  /** Sends the edited text as a new version of the conversation from here on. */
  onSubmitEdit: (text: string) => void;
};

const hoverActionClassName = "h-6 px-1 text-[11.5px] text-muted-foreground opacity-0 transition-opacity duration-150 group-hover/user:opacity-100 focus-visible:opacity-100";

export function UserMessage(props: UserMessageProps) {
  const [editDraft, setEditDraft] = useState<string | null>(null);

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
          aria-label="Nachricht bearbeiten"
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
            Abbrechen
          </Button>
          <Button type="submit" size="sm" disabled={!editDraft.trim() || !props.canEdit}>
            Senden
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div className="group/user flex max-w-[85%] animate-in flex-col items-end self-end fade-in duration-200">
      <div className="rounded-xl bg-muted px-3.5 py-2 whitespace-pre-wrap">{props.text}</div>
      <div className="mt-0.5 flex items-center gap-0.5">
        <CopyButton readText={() => props.text} label="Kopieren" className={hoverActionClassName} />
        {props.canEdit && (
          <Button variant="ghost" size="sm" className={cn(hoverActionClassName, "gap-1")} onClick={() => setEditDraft(props.text)}>
            <Pencil className="size-3" /> Bearbeiten
          </Button>
        )}
        {props.versions && (
          <span className="flex items-center text-[11.5px] text-muted-foreground tabular-nums">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Vorherige Version"
              disabled={props.versions.currentIndex === 0}
              onClick={() => props.onShowVersion(props.versions!.currentIndex - 1)}
            >
              <ChevronLeft />
            </Button>
            {props.versions.currentIndex + 1}/{props.versions.total}
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Nächste Version"
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
