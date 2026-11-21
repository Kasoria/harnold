import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

type NewProjectDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (name: string, projectPath?: string) => void;
};

export function NewProjectDialog({ open, onOpenChange, onCreate }: NewProjectDialogProps) {
  const [projectName, setProjectName] = useState("");
  const [projectPath, setProjectPath] = useState("");

  const submit = (formEvent: React.FormEvent) => {
    formEvent.preventDefault();
    if (!projectName.trim()) return;
    onCreate(projectName.trim(), projectPath.trim() || undefined);
    setProjectName("");
    setProjectPath("");
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Neues Projekt</DialogTitle>
            <DialogDescription>Ohne Ordner wird einer im Harnold-Projektverzeichnis angelegt.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Input autoFocus placeholder="Name" value={projectName} onChange={(event) => setProjectName(event.target.value)} />
            <Input
              placeholder="Vorhandener Ordner (optional, absoluter Pfad)"
              value={projectPath}
              onChange={(event) => setProjectPath(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Abbrechen
            </Button>
            <Button type="submit" disabled={!projectName.trim()}>
              Anlegen
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
