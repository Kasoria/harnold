import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";

type NewProjectDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (name: string, projectPath?: string) => void;
  /** Active environment the new project joins. */
  environmentName?: string;
};

export function NewProjectDialog({ open, onOpenChange, onCreate, environmentName }: NewProjectDialogProps) {
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
            <DialogTitle>{t("Neues Projekt")}</DialogTitle>
            <DialogDescription>
              {t("Ohne Ordner wird einer im Harnold-Projektverzeichnis angelegt.")}{environmentName && t(" Gehört zur Umgebung {0}.", environmentName)}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Input autoFocus placeholder={t("Name")} value={projectName} onChange={(event) => setProjectName(event.target.value)} />
            <Input
              placeholder={t("Vorhandener Ordner (optional, absoluter Pfad)")}
              value={projectPath}
              onChange={(event) => setProjectPath(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t("Abbrechen")}
            </Button>
            <Button type="submit" disabled={!projectName.trim()}>
              {t("Anlegen")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
