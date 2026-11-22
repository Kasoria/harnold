import {
  BookOpen, Bot, Brain, Briefcase, Building2, Calendar, Camera, ChartLine, Cloud, Code, Coffee, CreditCard, Database, Film, FlaskConical, Folder, Globe,
  GraduationCap, Heart, House, Leaf, Lightbulb, Mail, Megaphone, MessageCircle, Monitor, Music, Palette, PenTool, Rocket, Server, Shield, ShoppingCart,
  Smartphone, Sparkles, Star, Terminal, User, Users, Wrench, type LucideIcon,
} from "lucide-react";

/**
 * Icons for projects and environments. Stored as one string: `<glyph>[;bg=<background>]`
 * - glyph: an emoji or "lucide:<name>"; empty = letter (then only a tile colour is stored, e.g. ";bg=145")
 * - background: "none", "auto" (colour from the name) or a hue (0–360). Default: symbols "auto", emojis "none".
 * Keep the symbol names in sync with `entityIconNames` in packages/core/src/setup-tools.ts (the agent can set them too).
 */
export const entityIcons: Record<string, LucideIcon> = {
  folder: Folder, briefcase: Briefcase, "building-2": Building2, house: House, user: User, users: Users, globe: Globe, code: Code, terminal: Terminal,
  database: Database, server: Server, cloud: Cloud, smartphone: Smartphone, monitor: Monitor, palette: Palette, "pen-tool": PenTool, camera: Camera,
  film: Film, music: Music, "book-open": BookOpen, "graduation-cap": GraduationCap, "flask-conical": FlaskConical, rocket: Rocket, lightbulb: Lightbulb,
  sparkles: Sparkles, bot: Bot, brain: Brain, "shopping-cart": ShoppingCart, "credit-card": CreditCard, "chart-line": ChartLine, megaphone: Megaphone,
  mail: Mail, "message-circle": MessageCircle, calendar: Calendar, heart: Heart, star: Star, leaf: Leaf, coffee: Coffee, shield: Shield, wrench: Wrench,
};

/** Tile colours (oklch hues) for the automatic colour from the name – order fixed, it decides existing colours. */
const avatarHues = [25, 145, 265, 330, 200, 85, 0, 295];
/** Same colours sorted along the colour wheel, for the picker. */
export const pickerHues = [0, 25, 85, 145, 200, 265, 295, 330];

export function hueForName(name: string): number {
  let hash = 0;
  for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return avatarHues[Math.abs(hash) % avatarHues.length];
}

export const tileColor = (hue: number) => `oklch(0.62 0.15 ${hue})`;

const symbolPrefix = "lucide:";
export const symbolIconValue = (iconName: string) => `${symbolPrefix}${iconName}`;
export const isSymbolGlyph = (glyph: string) => glyph.startsWith(symbolPrefix);

export type IconBackground = "none" | "auto" | number;
export type ParsedEntityIcon = { glyph: string | null; symbol: LucideIcon | null; background: IconBackground };

const defaultBackgroundFor = (glyph: string): IconBackground => (isSymbolGlyph(glyph) ? "auto" : "none");

export function parseEntityIcon(icon: string | null | undefined): ParsedEntityIcon {
  if (!icon) return { glyph: null, symbol: null, background: "auto" };
  const [glyphPart, backgroundPart] = icon.split(";bg=");
  const glyph = glyphPart || null;
  const parsedBackground: IconBackground =
    backgroundPart === "none" || backgroundPart === "auto" ? backgroundPart : backgroundPart && !Number.isNaN(Number(backgroundPart)) ? Number(backgroundPart) : defaultBackgroundFor(glyph ?? "lucide:");
  const background = !glyph && parsedBackground === "none" ? "auto" : parsedBackground; // a letter always has a tile
  if (!glyph) return { glyph: null, symbol: null, background };
  return { glyph, symbol: isSymbolGlyph(glyph) ? (entityIcons[glyph.slice(symbolPrefix.length)] ?? null) : null, background };
}

/** Builds the stored value; the background suffix is left out when it is the default for that glyph. */
export function formatEntityIcon(glyph: string, background: IconBackground): string {
  return background === defaultBackgroundFor(glyph) ? glyph : `${glyph};bg=${background}`;
}
