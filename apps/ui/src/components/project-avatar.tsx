import { cn } from "@/lib/utils";

const avatarHues = [25, 145, 265, 330, 200, 85, 0, 295];

function hueForName(name: string): number {
  let hash = 0;
  for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return avatarHues[Math.abs(hash) % avatarHues.length];
}

export function ProjectAvatar({ name, className }: { name: string; className?: string }) {
  const hue = hueForName(name);
  return (
    <span
      className={cn("inline-flex size-5 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold text-white", className)}
      style={{ background: `oklch(0.62 0.15 ${hue})` }}
      aria-hidden
    >
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}
