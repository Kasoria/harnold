import { useSyncExternalStore } from "react";
import { AlertCircle, CheckCircle2, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { dismissToast, subscribeToasts, toastList } from "@/lib/toast";

const toneIcon = {
  success: <CheckCircle2 className="size-4 shrink-0 text-status-running" />,
  error: <AlertCircle className="size-4 shrink-0 text-destructive" />,
  info: <Info className="size-4 shrink-0 text-muted-foreground" />,
};

/** Stack of short confirmations/errors at the bottom right (docs/UI.md: quiet, no chrome). */
export function Toaster() {
  const toasts = useSyncExternalStore(subscribeToasts, toastList, toastList);
  if (!toasts.length) return null;
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
      {toasts.map((toastItem) => (
        <div
          key={toastItem.id}
          role={toastItem.tone === "error" ? "alert" : "status"}
          className={cn(
            "pointer-events-auto flex animate-in items-start gap-2.5 rounded-lg border bg-popover px-3.5 py-2.5 text-[13px] shadow-lg fade-in slide-in-from-bottom-2 duration-200",
            toastItem.tone === "error" ? "text-destructive" : "text-foreground",
          )}
        >
          <span className="mt-0.5">{toneIcon[toastItem.tone]}</span>
          <span className="min-w-0 flex-1 cursor-pointer break-words" onClick={() => dismissToast(toastItem.id)}>
            {toastItem.message}
          </span>
          {toastItem.action && (
            <Button
              size="sm"
              variant="secondary"
              className="h-6 shrink-0 text-[12px]"
              onClick={() => {
                toastItem.action!.run();
                dismissToast(toastItem.id);
              }}
            >
              {toastItem.action.label}
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}
