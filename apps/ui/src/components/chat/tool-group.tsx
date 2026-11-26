import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { ChatItem } from "@/types";
import { cn } from "@/lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { t } from "@/lib/i18n";
import { ToolResultImages, ToolResultView } from "./tool-result-view";

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
          {toolResult && <ToolResultView toolName={toolUse.toolName} toolResult={toolResult} />}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export type ThinkingItem = Extract<ChatItem, { kind: "thinking" }>;
/** One step of the agent's work between two answers: a thought or a tool call. */
export type WorkStep = ToolUseItem | ThinkingItem;

function ThinkingRow({ thinking }: { thinking: ThinkingItem }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-[12px] text-muted-foreground transition-colors hover:text-foreground">
        <ChevronRight className={cn("size-3 shrink-0 transition-transform duration-200", open && "rotate-90")} />
        <span className="shrink-0 font-medium">{t("Gedanken")}</span>
        {!open && <span className="truncate">{thinking.text.replace(/\s+/g, " ").slice(0, 140)}</span>}
      </CollapsibleTrigger>
      <CollapsibleContent className="collapsible-animated">
        <div className="ml-5 border-l py-1 pl-3 text-[12.5px] whitespace-pre-wrap text-muted-foreground">{thinking.text}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * All thoughts and tool calls between two answers as one line (like the Claude desktop app):
 * "5 Befehle ausgeführt, 2 Dateien gelesen". Open: every step in order, each expandable.
 */
export function WorkGroup(props: { steps: WorkStep[]; toolResultsByToolUseId: Map<string, ToolResultItem>; running: boolean; isLatest: boolean }) {
  const [open, setOpen] = useState(false);
  const toolUses = props.steps.filter((step): step is ToolUseItem => step.kind === "tool_use");
  const pending = props.running && toolUses.some((toolUse) => !props.toolResultsByToolUseId.has(toolUse.toolUseId));
  const active = props.running && props.isLatest;
  const failedCount = toolUses.filter((toolUse) => props.toolResultsByToolUseId.get(toolUse.toolUseId)?.isError).length;
  const lastToolUse = toolUses.at(-1);
  const label = toolUses.length ? buildGroupLabel(toolUses) : t("Nachgedacht");

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="animate-in fade-in duration-200">
      <CollapsibleTrigger className="flex max-w-full items-center gap-1.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground">
        <span className={cn("shrink-0", (pending || active) && "text-shimmer")}>{label}</span>
        {failedCount > 0 && <span className="shrink-0 text-destructive">· {t("{0} fehlgeschlagen", failedCount)}</span>}
        {active && !open && lastToolUse && <span className="truncate font-mono text-[12px] opacity-70">{summarizeToolInput(lastToolUse.input)}</span>}
        <ChevronRight className={cn("size-3.5 shrink-0 transition-transform duration-200", open && "rotate-90")} />
      </CollapsibleTrigger>
      <CollapsibleContent className="collapsible-animated">
        <div className="mt-1 border-l pl-2">
          {props.steps.map((step) =>
            step.kind === "thinking" ? (
              <ThinkingRow key={step.id} thinking={step} />
            ) : (
              <ToolCallRow key={step.id} toolUse={step} toolResult={props.toolResultsByToolUseId.get(step.toolUseId)} />
            ),
          )}
        </div>
      </CollapsibleContent>
      {!open &&
        toolUses.map((toolUse) => {
          const toolResult = toolUse.toolName.startsWith("mcp__") ? props.toolResultsByToolUseId.get(toolUse.toolUseId) : undefined;
          return (toolResult?.images?.length || toolResult?.html?.length) ? (
            <div key={toolUse.id} className="mt-2">
              <ToolResultImages toolResult={toolResult} />
            </div>
          ) : null;
        })}
    </Collapsible>
  );
}
