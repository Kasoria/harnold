import { Check } from "lucide-react";
import type { Environment, Project } from "@/types";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ProjectAvatar } from "@/components/project-avatar";

type MoveSessionDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: Project[];
  environments: Environment[];
  currentProjectId: string | null;
  onMove: (projectId: string) => void;
};

/** Target projects grouped by environment – moving a session into another environment means moving it into one of its projects. */
export function MoveSessionDialog(props: MoveSessionDialogProps) {
  const groups = [
    ...props.environments.map((environment) => ({ key: environment.id, title: environment.name, projects: props.projects.filter((project) => environment.projectIds.includes(project.id)) })),
    {
      key: "none",
      title: "Ohne Umgebung",
      projects: props.projects.filter((project) => !props.environments.some((environment) => environment.projectIds.includes(project.id))),
    },
  ].filter((group) => group.projects.length > 0);

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[70vh] gap-3 overflow-y-auto sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-[15px]">Session verschieben</DialogTitle>
        </DialogHeader>
        {groups.map((group) => (
          <div key={group.key}>
            {props.environments.length > 0 && <div className="mb-1 px-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{group.title}</div>}
            {group.projects.map((project) => {
              const current = project.id === props.currentProjectId;
              return (
                <button
                  key={project.id}
                  disabled={current}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-accent disabled:opacity-60 disabled:hover:bg-transparent"
                  onClick={() => {
                    props.onMove(project.id);
                    props.onOpenChange(false);
                  }}
                >
                  <ProjectAvatar name={project.name} className="size-4 rounded text-[9px]" />
                  <span className="flex-1 truncate">{project.name}</span>
                  {current && <Check className="size-3.5 text-muted-foreground" />}
                </button>
              );
            })}
          </div>
        ))}
      </DialogContent>
    </Dialog>
  );
}
