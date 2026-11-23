import { Label } from "@/components/ui/label";
import { currentLanguage, t } from "@/lib/i18n";

export function FormField(props: { label: string; hint?: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="grid min-w-0 gap-1.5">
      <Label htmlFor={props.htmlFor} className="text-[12px] font-medium">
        {props.label}
      </Label>
      {props.children}
      {props.hint && <p className="text-[11.5px] leading-snug text-muted-foreground">{props.hint}</p>}
    </div>
  );
}

export const permissionModeOptions = [
  { value: "default", label: t("Fragen") },
  { value: "acceptEdits", label: t("Edits erlauben") },
  { value: "plan", label: t("Planen") },
  { value: "bypassPermissions", label: t("Alles erlauben") },
] as const;

export function formatRelativeTime(timestamp: number): string {
  const differenceMs = timestamp - Date.now();
  const formatter = new Intl.RelativeTimeFormat(currentLanguage, { numeric: "auto" });
  const absoluteMinutes = Math.abs(differenceMs) / 60_000;
  if (absoluteMinutes < 60) return formatter.format(Math.round(differenceMs / 60_000), "minute");
  if (absoluteMinutes < 60 * 24) return formatter.format(Math.round(differenceMs / 3_600_000), "hour");
  return formatter.format(Math.round(differenceMs / 86_400_000), "day");
}
