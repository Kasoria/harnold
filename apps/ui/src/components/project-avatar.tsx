import { cn } from "@/lib/utils";
import { hueForName, parseEntityIcon, tileColor } from "@/lib/entity-icons";

/**
 * Avatar for projects and environments: symbol or emoji, with or without a coloured tile;
 * without an icon a coloured letter.
 */
export function ProjectAvatar({ name, icon, className }: { name: string; icon?: string | null; className?: string }) {
  const { glyph, symbol: SymbolIcon, background } = parseEntityIcon(icon);
  const content = SymbolIcon ? (
    <SymbolIcon className="size-[66%]" strokeWidth={background === "none" ? 2 : 2.25} />
  ) : glyph && !glyph.startsWith("lucide:") ? (
    glyph
  ) : (
    name.trim().charAt(0).toUpperCase() || "?"
  );
  const isEmoji = Boolean(glyph && !SymbolIcon && !glyph.startsWith("lucide:"));

  if (background === "none" && glyph) {
    return (
      <span className={cn("inline-flex size-5 shrink-0 items-center justify-center leading-none", isEmoji ? "text-[15px]" : "text-foreground/80", className)} aria-hidden>
        {content}
      </span>
    );
  }
  return (
    <span
      className={cn("inline-flex size-5 shrink-0 items-center justify-center rounded-md font-semibold text-white", isEmoji ? "text-[11px] leading-none" : "text-[11px]", className)}
      style={{ background: tileColor(background === "auto" || background === "none" ? hueForName(name) : background) }}
      aria-hidden
    >
      {content}
    </span>
  );
}
