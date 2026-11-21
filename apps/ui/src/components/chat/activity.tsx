import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

/** Summarized reasoning of the model; live while it is still streaming. */
export function ThinkingBlock({ text, live }: { text: string; live?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="animate-in fade-in duration-200">
      <CollapsibleTrigger className="flex items-center gap-1.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground">
        <span className={cn(live && "text-shimmer")}>{live ? "Denkt nach" : "Gedanken"}</span>
        <ChevronRight className={cn("size-3.5 transition-transform duration-200", open && "rotate-90")} />
      </CollapsibleTrigger>
      <CollapsibleContent className="collapsible-animated">
        <div className="mt-1 border-l pl-3 text-[13px] whitespace-pre-wrap text-muted-foreground">{text}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Shown while a turn runs and nothing else streams – so a sent message never looks ignored. */
export function ActivityIndicator({ label, startedAt }: { label: string; startedAt: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const ticker = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(ticker);
  }, []);
  const elapsedSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return (
    <div className="flex animate-in items-center gap-2 text-[13px] fade-in duration-300" role="status">
      <span className="flex gap-1" aria-hidden>
        {[0, 1, 2].map((dotIndex) => (
          <span key={dotIndex} className="size-1.5 animate-pulse rounded-full bg-muted-foreground/70" style={{ animationDelay: `${dotIndex * 200}ms` }} />
        ))}
      </span>
      <span className="text-shimmer">{label}</span>
      {elapsedSeconds >= 2 && <span className="text-[12px] text-muted-foreground tabular-nums">{elapsedSeconds} s</span>}
    </div>
  );
}
