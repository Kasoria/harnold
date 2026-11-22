import { ChevronDown, FolderInput } from "lucide-react";
import type { Project } from "@/types";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ProjectAvatar } from "@/components/project-avatar";
import { t } from "@/lib/i18n";

/** Quick Chat → project in one click (moves the session incl. agent context). */
export function ProjectQuickSelect(props: { projects: Project[]; onSelect: (projectId: string) => void }) {
  const targetProjects = props.projects.filter((project) => project.kind !== "quick");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-muted-foreground transition-colors duration-150 hover:bg-foreground/5 hover:text-foreground disabled:opacity-50" disabled={targetProjects.length === 0}>
        <FolderInput className="size-3.5" />
        {t("Kein Projekt")}
        <ChevronDown className="size-3 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 w-56 overflow-y-auto">
        <DropdownMenuLabel className="text-[11px] font-medium text-muted-foreground">{t("Projekt zuweisen")}</DropdownMenuLabel>
        {targetProjects.map((project) => (
          <DropdownMenuItem key={project.id} className="text-[13px]" onSelect={() => props.onSelect(project.id)}>
            <ProjectAvatar name={project.name} icon={project.icon} className="size-4 text-[9px]" />
            <span className="truncate">{project.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
