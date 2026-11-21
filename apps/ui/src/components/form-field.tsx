import { Label } from "@/components/ui/label";

export function FormField(props: { label: string; hint?: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={props.htmlFor} className="text-[12px] font-medium">
        {props.label}
      </Label>
      {props.children}
      {props.hint && <p className="text-[11.5px] leading-snug text-muted-foreground">{props.hint}</p>}
    </div>
  );
}

export const permissionModeOptions = [
  { value: "default", label: "Fragen" },
  { value: "acceptEdits", label: "Edits erlauben" },
  { value: "plan", label: "Planen" },
  { value: "bypassPermissions", label: "Alles erlauben" },
] as const;

export const modelOptions = [
  { value: "default", label: "Standard" },
  { value: "claude-opus-5-5", label: "Opus 5.5" },
  { value: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  { value: "claude-haiku-5-5", label: "Haiku 5.5" },
] as const;

export function formatRelativeTime(timestamp: number): string {
  const differenceMs = timestamp - Date.now();
  const formatter = new Intl.RelativeTimeFormat("de", { numeric: "auto" });
  const absoluteMinutes = Math.abs(differenceMs) / 60_000;
  if (absoluteMinutes < 60) return formatter.format(Math.round(differenceMs / 60_000), "minute");
  if (absoluteMinutes < 60 * 24) return formatter.format(Math.round(differenceMs / 3_600_000), "hour");
  return formatter.format(Math.round(differenceMs / 86_400_000), "day");
}
