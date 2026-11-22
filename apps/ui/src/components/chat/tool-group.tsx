import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { ChatItem } from "@/types";
import { cn } from "@/lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { t } from "@/lib/i18n";

export type ToolUseItem = Extract<ChatItem, { kind: "tool_use" }>;
export type ToolResultItem = Extract<ChatItem, { kind: "tool_result" }>;

type ToolCategory = { singular: string; plural: (count: number) => string };

function categorizeTool(toolName: string): ToolCategory {
  if (toolName === "Bash") return { singular: t("Befehl ausgeführt"), plural: (count) => t("{0} Befehle ausgeführt", count) };
  if (toolName === "Read") return { singular: t("Datei gelesen"), plural: (count) => t("{0} Dateien gelesen", count) };
  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(toolName))
    return { singular: t("Datei bearbeitet"), plural: (count) => t("{0} Dateien bearbeitet", count) };
  if (["Grep", "Glob"].includes(toolName)) return { singular: t("Gesucht"), plural: (count) => t("{0}× gesucht", count) };
  if (["WebSearch", "WebFetch"].includes(toolName)) return { singular: t("Im Web recherchiert"), plural: (count) => t("{0}× im Web", count) };
  if (toolName === "Skill") return { singular: t("Skill genutzt"), plural: (count) => t("{0} Skills genutzt", count) };
  if (["Task", "Agent"].includes(toolName)) return { singular: t("Subagent gestartet"), plural: (count) => t("{0} Subagents gestartet", count) };
  if (toolName.startsWith("mcp__harnold__")) return { singular: t("Harnold genutzt"), plural: (count) => t("{0}× Harnold", count) };
  if (toolName.startsWith("mcp__harnold_memory__")) return { singular: t("Memory genutzt"), plural: (count) => t("{0}× Memory", count) };
  if (toolName.startsWith("mcp__")) return { singular: t("Integration genutzt"), plural: (count) => t("{0}× Integrationen", count) };
  return { singular: toolName, plural: (count) => `${toolName} ×${count}` };
}

export function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const inputRecord = input as Record<string, unknown>;
  const primaryValue =
    inputRecord.command ?? inputRecord.file_path ?? inputRecord.path ?? inputRecord.pattern ?? inputRecord.url ?? inputRecord.query ?? inputRecord.description ?? inputRecord.skill;
  return typeof primaryValue === "string" ? primaryValue : "";
}

function buildGroupLabel(toolUses: ToolUseItem[]): string {
  const countsByLabel = new Map<string, { category: ToolCategory; count: number }>();
  for (const toolUse of toolUses) {
    const category = categorizeTool(toolUse.toolName);
    const existing = countsByLabel.get(category.singular);
    countsByLabel.set(category.singular, { category, count: (existing?.count ?? 0) + 1 });
  }
  return [...countsByLabel.values()]
    .map(({ category, count }) => (count === 1 ? category.singular : category.plural(count)))
    .join(", ");
}

function ToolCallRow({ toolUse, toolResult }: { toolUse: ToolUseItem; toolResult?: ToolResultItem }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-[12px] text-muted-foreground transition-colors hover:text-foreground">
        <ChevronRight className={cn("size-3 shrink-0 transition-transform duration-200", open && "rotate-90")} />
        <span className="shrink-0 font-medium">{toolUse.toolName.replace(/^mcp__/, "")}</span>
        <span className={cn("truncate font-mono", toolResult?.isError && "text-destructive")}>{summarizeToolInput(toolUse.input)}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="collapsible-animated">
        <div className="ml-5 space-y-1 py-1">
          <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono text-[11px] whitespace-pre-wrap">
            {JSON.stringify(toolUse.input, null, 2)}
          </pre>
          {toolResult && (
            <pre
              className={cn(
                "max-h-64 overflow-auto rounded-md bg-muted p-2 font-mono text-[11px] whitespace-pre-wrap text-muted-foreground",
                toolResult.isError && "text-destructive",
              )}
            >
              {toolResult.content || t("(keine Ausgabe)")}
            </pre>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ToolGroup(props: {
  toolUses: ToolUseItem[];
  toolResultsByToolUseId: Map<string, ToolResultItem>;
  running: boolean;
}) {
  const [open, setOpen] = useState(false);
  const pending = props.running && props.toolUses.some((toolUse) => !props.toolResultsByToolUseId.has(toolUse.toolUseId));
  const failed = props.toolUses.some((toolUse) => props.toolResultsByToolUseId.get(toolUse.toolUseId)?.isError);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="animate-in fade-in duration-200">
      <CollapsibleTrigger className="flex items-center gap-1.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground">
        <span className={cn(pending && "animate-pulse", failed && "text-destructive")}>{buildGroupLabel(props.toolUses)}</span>
        <ChevronRight className={cn("size-3.5 transition-transform duration-200", open && "rotate-90")} />
      </CollapsibleTrigger>
      <CollapsibleContent className="collapsible-animated">
        <div className="mt-1 border-l pl-2">
          {props.toolUses.map((toolUse) => (
            <ToolCallRow key={toolUse.id} toolUse={toolUse} toolResult={props.toolResultsByToolUseId.get(toolUse.toolUseId)} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
