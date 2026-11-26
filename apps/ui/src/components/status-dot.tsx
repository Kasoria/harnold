import { cn } from "@/lib/utils";

/** "recent" = idle, but active in the last minutes (probably waiting for the next message). */
export type SessionStatus = "idle" | "recent" | "running" | "waiting" | "error";

const statusClassNames: Record<SessionStatus, string> = {
  idle: "bg-muted-foreground/40",
  recent: "bg-status-recent",
  running: "bg-status-running animate-pulse",
  waiting: "bg-status-waiting",
  error: "bg-status-error",
};

export function StatusDot({ status, className }: { status: SessionStatus; className?: string }) {
  return <span className={cn("inline-block size-1.5 shrink-0 rounded-full transition-colors duration-200", statusClassNames[status], className)} />;
}
