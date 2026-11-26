import { cn } from "@/lib/utils";
import { locale } from "@/lib/i18n";

const timestampFormat = () => new Intl.DateTimeFormat(locale(), { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

/** Date and time of a chat message; shown only while the message is hovered (the parent sets the hover group). */
export function MessageTimestamp(props: { createdAt: number; className?: string }) {
  const sentAt = new Date(props.createdAt);
  return (
    <time
      dateTime={sentAt.toISOString()}
      title={sentAt.toLocaleString(locale(), { dateStyle: "full", timeStyle: "medium" })}
      className={cn("px-1 text-[11px] text-muted-foreground/80 tabular-nums opacity-0 transition-opacity duration-150", props.className)}
    >
      {timestampFormat().format(sentAt)}
    </time>
  );
}
