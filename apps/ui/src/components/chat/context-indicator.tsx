import { useEffect, useState } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { Loader2, RefreshCw } from "lucide-react";
import { api } from "@/api";
import type { ContextBreakdown } from "@/types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { locale, t } from "@/lib/i18n";

const categoryLabels: Record<string, string> = {
  system_prompt: "System-Prompt",
  system_tools: "System-Tools",
  mcp_tools: "MCP-Tools",
  mcp_instructions: "MCP-Anweisungen",
  custom_agents: "Eigene Agents",
  memory_files: "Memory-Dateien",
  skills: "Skills",
  messages: "Nachrichten",
  autocompact_buffer: "Reserve fürs Komprimieren",
  compact_buffer: "Reserve fürs Komprimieren",
  free_space: "Frei",
};

// Distinct, calm colors for the used categories; free/buffer stay neutral.
const categoryColors = ["#3b82f6", "#8b5cf6", "#14b8a6", "#f59e0b", "#ec4899", "#22c55e", "#ef4444", "#0ea5e9"];

export function formatTokens(tokenCount: number): string {
  if (tokenCount >= 1_000_000) return `${(tokenCount / 1_000_000).toLocaleString(locale(), { maximumFractionDigits: 1 })}M`;
  if (tokenCount >= 1000) return `${Math.round(tokenCount / 1000)}k`;
  return String(tokenCount);
}

function ProgressRing(props: { fraction: number; className?: string }) {
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  const clampedFraction = Math.min(1, Math.max(0, props.fraction));
  return (
    <svg viewBox="0 0 16 16" className={cn("size-3.5 -rotate-90", props.className)} aria-hidden>
      <circle cx="8" cy="8" r={radius} fill="none" stroke="currentColor" strokeOpacity={0.2} strokeWidth="2.5" />
      <circle cx="8" cy="8" r={radius} fill="none" stroke="currentColor" strokeWidth="2.5" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - clampedFraction)} strokeLinecap="round" />
    </svg>
  );
}

/**
 * Shows how full the context window is (always visible next to the model);
 * click opens the breakdown by category, measured fresh (like /context).
 */
export function ContextIndicator(props: {
  sessionId: string | null;
  model: string;
  /** Tokens after the last turn / live during a turn; window size from the last turn. */
  contextTokens: number | null;
  contextWindow: number | null;
  running: boolean;
  onCompact: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [breakdown, setBreakdown] = useState<ContextBreakdown | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    setBreakdown(null);
    setLoadError(null);
  }, [props.sessionId]);

  const measure = () => {
    if (!props.sessionId) return;
    setLoading(true);
    setLoadError(null);
    api
      .readContext(props.sessionId, props.model || undefined)
      .then(setBreakdown)
      .catch((measureError: unknown) => setLoadError(measureError instanceof Error ? measureError.message : String(measureError)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (open) measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!props.sessionId) return null;
  const usedTokens = props.contextTokens ?? breakdown?.totalTokens ?? null;
  const windowTokens = props.contextWindow ?? breakdown?.maxTokens ?? null;
  const fraction = usedTokens !== null && windowTokens ? usedTokens / windowTokens : 0;
  const percentLabel = usedTokens !== null && windowTokens ? `${Math.round(fraction * 100)} %` : t("Kontext");

  const visibleCategories = (breakdown?.categories ?? []).filter((category) => category.tokens > 0 && category.kind !== "deferred");
  const usedCategories = visibleCategories.filter((category) => category.kind === "used");
  const reserveCategories = visibleCategories.filter((category) => category.kind !== "used");
  const colorFor = (categoryIndex: number) => categoryColors[categoryIndex % categoryColors.length];
  const labelFor = (category: ContextBreakdown["categories"][number]) => (category.id && categoryLabels[category.id] ? t(categoryLabels[category.id]) : category.name);

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          className={cn(
            "flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground",
            fraction >= 0.8 && "text-status-waiting",
          )}
          aria-label={t("Kontextfenster")}
          title={usedTokens !== null && windowTokens ? t("{0} von {1} Tokens im Kontext", usedTokens.toLocaleString(locale()), windowTokens.toLocaleString(locale())) : t("Kontextfenster")}
        >
          <ProgressRing fraction={fraction} />
          {percentLabel}
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="end"
          side="top"
          sideOffset={6}
          className="z-50 w-80 rounded-xl border bg-popover p-4 text-popover-foreground shadow-md data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[13px] font-medium">{t("Kontextfenster")}</span>
            <button type="button" className="text-muted-foreground hover:text-foreground disabled:opacity-50" onClick={measure} disabled={loading} aria-label={t("Neu messen")}>
              {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            </button>
          </div>
          <div className="mt-1 text-[12px] text-muted-foreground">
            {breakdown
              ? t("{0} von {1} Tokens · {2}", formatTokens(breakdown.totalTokens), formatTokens(breakdown.maxTokens), breakdown.model)
              : usedTokens !== null && windowTokens
                ? t("{0} von {1} Tokens", formatTokens(usedTokens), formatTokens(windowTokens))
                : t("Noch nicht gemessen")}
          </div>

          {breakdown && (
            <>
              <div className="mt-3 flex h-2.5 overflow-hidden rounded-full bg-foreground/[0.06]">
                {usedCategories.map((category, categoryIndex) => (
                  <div key={`${category.name}-${categoryIndex}`} style={{ width: `${(category.tokens / breakdown.maxTokens) * 100}%`, backgroundColor: colorFor(categoryIndex) }} />
                ))}
              </div>
              <div className="mt-3 grid gap-1.5 text-[12px]">
                {usedCategories.map((category, categoryIndex) => (
                  <div key={`${category.name}-${categoryIndex}`} className="flex items-center gap-2">
                    <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: colorFor(categoryIndex) }} />
                    <span className="min-w-0 flex-1 truncate">{labelFor(category)}</span>
                    <span className="tabular-nums text-muted-foreground">{formatTokens(category.tokens)}</span>
                  </div>
                ))}
                {reserveCategories.map((category, categoryIndex) => (
                  <div key={`${category.name}-reserve-${categoryIndex}`} className="flex items-center gap-2 text-muted-foreground">
                    <span className="size-2 shrink-0 rounded-full border border-foreground/25" />
                    <span className="min-w-0 flex-1 truncate">{labelFor(category)}</span>
                    <span className="tabular-nums">{formatTokens(category.tokens)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
          {loading && !breakdown && <div className="mt-3 text-[12px] text-muted-foreground">{t("Wird gemessen …")}</div>}
          {loadError && <div className="mt-3 text-[12px] text-destructive">{loadError}</div>}

          <div className="mt-4 flex items-center justify-between gap-2 border-t pt-3">
            <span className="text-[11.5px] text-muted-foreground">{t("Komprimieren fasst den Verlauf zusammen.")}</span>
            <Button
              size="sm"
              variant="secondary"
              className="h-7 shrink-0 text-[12px]"
              disabled={props.running}
              onClick={() => {
                setOpen(false);
                props.onCompact();
              }}
            >
              {t("Komprimieren")}
            </Button>
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
