import { useEffect, useState } from "react";
import { Activity, Check, ChevronDown, Crosshair, Loader2, Plus, X } from "lucide-react";
import type { FileActivity } from "@/lib/file-activity";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

const maximumShown = 8;

function relativeTime(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 10) return t("gerade");
  if (seconds < 60) return t("vor {0} s", String(seconds));
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("vor {0} min", String(minutes));
  return t("vor {0} h", String(Math.round(minutes / 60)));
}

/**
 * What the agent is changing right now, as a list beside the canvas – not as cards on it, so the board stays tidy.
 * Files already on the canvas light up there; the others can be placed with one click.
 */
export function CanvasActivityPanel(props: {
  activities: FileActivity[];
  isOnCanvas: (activity: FileActivity) => boolean;
  rootLabel: (root: string) => string | undefined;
  onPlace: (activity: FileActivity) => void;
  onLocate: (activity: FileActivity) => void;
}) {
  const [open, setOpen] = useState(true);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const clockTimer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(clockTimer);
  }, []);
  if (!props.activities.length) return null;
  const editingCount = props.activities.filter((activity) => activity.phase === "editing").length;

  return (
    <div
      className="absolute top-3 right-3 z-20 w-72 overflow-hidden rounded-lg border bg-popover shadow-md max-md:w-60"
      onPointerDown={(pointerEvent) => pointerEvent.stopPropagation()}
      onWheel={(wheelEvent) => wheelEvent.stopPropagation()}
    >
      <button type="button" className="flex h-8 w-full items-center gap-2 px-2.5 text-left text-[12px] font-medium" onClick={() => setOpen((wasOpen) => !wasOpen)}>
        <Activity className={cn("size-3.5", editingCount ? "animate-pulse text-emerald-500" : "text-muted-foreground")} />
        {t("Live-Aktivität")}
        {editingCount > 0 && <span className="text-[11px] font-normal text-emerald-600 dark:text-emerald-400">{t("{0} in Arbeit", String(editingCount))}</span>}
        <ChevronDown className={cn("ml-auto size-3.5 text-muted-foreground transition-transform duration-200", !open && "-rotate-90")} />
      </button>
      {open && (
        <ul className="border-t py-1">
          {props.activities.slice(0, maximumShown).map((activity) => {
            const fileName = activity.path.split("/").pop();
            const folderLabel = [props.rootLabel(activity.root), activity.path.split("/").slice(0, -1).join("/")].filter(Boolean).join(" / ");
            const onCanvas = props.isOnCanvas(activity);
            return (
              <li key={`${activity.root}:${activity.path}`} className="group/activity flex h-9 items-center gap-2 px-2.5 hover:bg-foreground/5">
                {activity.phase === "editing" ? (
                  <Loader2 className="size-3.5 shrink-0 animate-spin text-emerald-500" />
                ) : activity.phase === "failed" ? (
                  <X className="size-3.5 shrink-0 text-destructive" />
                ) : (
                  <Check className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="flex min-w-0 flex-1 flex-col leading-tight">
                  <span className="truncate text-[12px]">{fileName}</span>
                  <span className="truncate text-[10.5px] text-muted-foreground">
                    {folderLabel ? `${folderLabel} · ` : ""}
                    {relativeTime(activity.at, now)}
                  </span>
                </span>
                <button
                  type="button"
                  className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-60 group-hover/activity:opacity-100 hover:bg-foreground/10 hover:text-foreground"
                  title={onCanvas ? t("Auf dem Canvas zeigen") : t("Auf den Canvas legen")}
                  aria-label={onCanvas ? t("Auf dem Canvas zeigen") : t("Auf den Canvas legen")}
                  onClick={() => (onCanvas ? props.onLocate(activity) : props.onPlace(activity))}
                >
                  {onCanvas ? <Crosshair className="size-3.5" /> : <Plus className="size-3.5" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
