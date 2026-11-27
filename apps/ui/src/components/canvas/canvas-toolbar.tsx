import { AppWindow, FolderPlus, Hand, Hash, MousePointer2, MoveUpRight, Pencil, Sparkles, Square, StickyNote, Type } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { t } from "@/lib/i18n";

export type CanvasTool = "select" | "hand" | "text" | "frame" | "note" | "pen" | "rect" | "connector";

export const canvasTools: { tool: CanvasTool; label: string; shortcut: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { tool: "select", label: t("Auswahl"), shortcut: "V", icon: MousePointer2 },
  { tool: "hand", label: t("Hand"), shortcut: "H", icon: Hand },
  { tool: "text", label: t("Text"), shortcut: "T", icon: Type },
  { tool: "frame", label: t("Frame"), shortcut: "F", icon: Hash },
  { tool: "note", label: t("Notiz"), shortcut: "N", icon: StickyNote },
  { tool: "pen", label: t("Stift"), shortcut: "P", icon: Pencil },
  { tool: "rect", label: t("Rechteck"), shortcut: "R", icon: Square },
  { tool: "connector", label: t("Verbinden"), shortcut: "A", icon: MoveUpRight },
];

const buttonSize = 32;
const buttonGap = 2;

export function CanvasToolbar({
  activeTool,
  onToolChange,
  imagePanelOpen,
  onToggleImagePanel,
  onAddApp,
  onAddFiles,
}: {
  activeTool: CanvasTool;
  onToolChange: (tool: CanvasTool) => void;
  imagePanelOpen: boolean;
  onToggleImagePanel: () => void;
  onAddApp: () => void;
  onAddFiles?: () => void;
}) {
  const activeIndex = canvasTools.findIndex((entry) => entry.tool === activeTool);
  return (
    <div
      className="absolute bottom-4 left-1/2 z-20 -translate-x-1/2 rounded-xl border bg-popover p-1 shadow-lg"
      onPointerDown={(pointerEvent) => pointerEvent.stopPropagation()}
    >
      <div className="flex items-center gap-1">
      <div className="relative flex" style={{ gap: buttonGap }}>
        <span
          aria-hidden
          className="absolute top-0 left-0 rounded-lg bg-primary transition-transform duration-200 ease-out"
          style={{ width: buttonSize, height: buttonSize, transform: `translateX(${activeIndex * (buttonSize + buttonGap)}px)` }}
        />
        {canvasTools.map(({ tool, label, shortcut, icon: ToolIcon }) => (
          <Tooltip key={tool}>
            <TooltipTrigger asChild>
              <button
                aria-label={label}
                aria-pressed={tool === activeTool}
                onClick={() => onToolChange(tool)}
                className={cn(
                  "relative z-10 flex items-center justify-center rounded-lg transition-colors duration-200",
                  tool === activeTool ? "text-primary-foreground" : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
                )}
                style={{ width: buttonSize, height: buttonSize }}
              >
                <ToolIcon className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {label} <span className="ml-1 opacity-60">{shortcut}</span>
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
      <span aria-hidden className="mx-0.5 h-5 w-px bg-border" />
      {onAddFiles && (
        <ExtraButton label={t("Dateien & Ordner hinzufügen")} hint={t("Aus dem Dateibaum ziehen")} onClick={onAddFiles}>
          <FolderPlus className="size-4" />
        </ExtraButton>
      )}
      <ExtraButton label={t("Live-App hinzufügen")} onClick={onAddApp}>
        <AppWindow className="size-4" />
      </ExtraButton>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            aria-label={t("Bild generieren")}
            aria-pressed={imagePanelOpen}
            onClick={onToggleImagePanel}
            className={cn(
              "flex items-center justify-center rounded-lg transition-colors duration-200",
              imagePanelOpen ? "bg-foreground/10 text-foreground" : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
            )}
            style={{ width: buttonSize, height: buttonSize }}
          >
            <Sparkles className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">
          {t("Bild generieren")} <span className="ml-1 opacity-60">G</span>
        </TooltipContent>
      </Tooltip>
      </div>
    </div>
  );
}

function ExtraButton(props: { label: string; hint?: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label={props.label}
          onClick={props.onClick}
          className="flex items-center justify-center rounded-lg text-muted-foreground transition-colors duration-200 hover:bg-foreground/5 hover:text-foreground"
          style={{ width: buttonSize, height: buttonSize }}
        >
          {props.children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">
        {props.label}
        {props.hint && <span className="ml-1 opacity-60">{props.hint}</span>}
      </TooltipContent>
    </Tooltip>
  );
}
