import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ProjectAvatar } from "@/components/project-avatar";
import { cn } from "@/lib/utils";
import type { Project } from "@/types";

const suggestedIcons = ["🚀", "💡", "🎨", "🛠️", "📱", "🌐", "🧪", "📊", "🛒", "📚", "🎵", "🎬", "🏠", "🌱", "🔥", "⚡", "🧠", "🤖", "🔒", "💬", "📝", "🗂️", "🎯", "🏢", "🐞", "☕", "🍵", "🌙", "⭐", "❤️"];

type ProjectIconDialogProps = {
  project: Project | null;
  onOpenChange: (open: boolean) => void;
  onSave: (icon: string | null) => void;
};

/** Emoji per project for a quicker overview in the sidebar; any emoji can be typed or pasted. */
export function ProjectIconDialog({ project, onOpenChange, onSave }: ProjectIconDialogProps) {
  const [iconDraft, setIconDraft] = useState("");
  useEffect(() => setIconDraft(project?.icon ?? ""), [project]);

  const save = (icon: string | null) => {
    onSave(icon?.trim() || null);
    onOpenChange(false);
  };

  return (
    <Dialog open={Boolean(project)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <form
          className="grid gap-4"
          onSubmit={(formEvent) => {
            formEvent.preventDefault();
            save(iconDraft);
          }}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-[15px]">
              <ProjectAvatar name={project?.name ?? ""} icon={iconDraft.trim() || null} /> Icon für {project?.name}
            </DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-10 gap-1" role="listbox" aria-label="Vorschläge">
            {suggestedIcons.map((icon) => (
              <button
                key={icon}
                type="button"
                role="option"
                aria-selected={iconDraft === icon}
                onClick={() => setIconDraft(icon)}
                className={cn("flex aspect-square items-center justify-center rounded-md text-[17px] transition-colors duration-150 hover:bg-foreground/[0.07]", iconDraft === icon && "bg-primary/15")}
              >
                {icon}
              </button>
            ))}
          </div>
          <Input autoFocus value={iconDraft} maxLength={16} placeholder="Eigenes Emoji (⌃⌘Leertaste)" onChange={(changeEvent) => setIconDraft(changeEvent.target.value)} />
          <DialogFooter>
            <Button type="button" variant="ghost" className="sm:mr-auto" disabled={!project?.icon} onClick={() => save(null)}>
              Buchstabe verwenden
            </Button>
            <Button type="submit">Speichern</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
