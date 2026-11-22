import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

/** Harnold-Symbol (Kleingrößen-Schnitt aus docs/brand): Hantel als grinsendes H. Farbe über currentColor. */
function SymbolShapes() {
  return (
    <>
      <path d="M18 110 Q128 160 238 110" fill="none" stroke="currentColor" strokeWidth="34" strokeLinecap="round" />
      <rect x="42" y="36" width="64" height="184" rx="32" fill="currentColor" transform="rotate(10 74 128)" />
      <rect x="150" y="36" width="64" height="184" rx="32" fill="currentColor" transform="rotate(-10 182 128)" />
    </>
  );
}

export function HarnoldSymbol(props: { className?: string }) {
  return (
    <svg viewBox="0 0 256 256" aria-hidden className={cn("text-primary", props.className)}>
      <SymbolShapes />
    </svg>
  );
}

/** Symbol (Primärfarbe) + Wortmarke (Textfarbe). Höhe über className steuern, z. B. h-5. */
export function HarnoldLogo(props: { className?: string }) {
  return (
    <svg viewBox="0 0 1155 256" role="img" aria-label={t("Harnold")} className={cn("w-auto", props.className)}>
      <g className="text-primary">
        <SymbolShapes />
      </g>
      <g transform="translate(308 25)" fill="currentColor">
        <path d="M0 46 A16.0 16.0 0 0 1 32 46 V184 A16.0 16.0 0 0 1 0 184 Z" />
        <path d="M0 136 A56 56 0 0 1 112 136 L80 136 A24 24 0 0 0 32 136 Z" />
        <path d="M80 136 A16.0 16.0 0 0 1 112 136 V184 A16.0 16.0 0 0 1 80 184 Z" />
        <path d="M132 140 A62 62 0 1 1 256 140 A62 62 0 1 1 132 140 Z M164 140 A30 30 0 1 0 224 140 A30 30 0 1 0 164 140 Z" />
        <path d="M224 96 A16.0 16.0 0 0 1 256 96 V184 A16.0 16.0 0 0 1 224 184 Z" />
        <path d="M282 96 A16.0 16.0 0 0 1 314 96 V184 A16.0 16.0 0 0 1 282 184 Z" />
        <path d="M282 136 A56 56 0 0 1 364.29 86.55 L349.27 114.81 A24 24 0 0 0 314 136 Z" />
        <path d="M340.78 100.68 A16.0 16.0 0 1 0 372.78 100.68 A16.0 16.0 0 1 0 340.78 100.68 Z" />
        <path d="M386.78 96 A16.0 16.0 0 0 1 418.78 96 V184 A16.0 16.0 0 0 1 386.78 184 Z" />
        <path d="M386.78 136 A56 56 0 0 1 498.78 136 L466.78 136 A24 24 0 0 0 418.78 136 Z" />
        <path d="M466.78 136 A16.0 16.0 0 0 1 498.78 136 V184 A16.0 16.0 0 0 1 466.78 184 Z" />
        <path d="M518.78 140 A62 62 0 1 1 642.78 140 A62 62 0 1 1 518.78 140 Z M550.78 140 A30 30 0 1 0 610.78 140 A30 30 0 1 0 550.78 140 Z" />
        <path d="M662.78 46 A16.0 16.0 0 0 1 694.78 46 V184 A16.0 16.0 0 0 1 662.78 184 Z" />
        <path d="M714.78 140 A62 62 0 1 1 838.78 140 A62 62 0 1 1 714.78 140 Z M746.78 140 A30 30 0 1 0 806.78 140 A30 30 0 1 0 746.78 140 Z" />
        <path d="M806.78 46 A16.0 16.0 0 0 1 838.78 46 V184 A16.0 16.0 0 0 1 806.78 184 Z" />
      </g>
    </svg>
  );
}
