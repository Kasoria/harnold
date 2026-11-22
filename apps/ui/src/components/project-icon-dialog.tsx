import { useEffect, useState } from "react";
import { Ban } from "lucide-react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/segmented-control";
import { ProjectAvatar } from "@/components/project-avatar";
import { entityIcons, formatEntityIcon, hueForName, isSymbolGlyph, parseEntityIcon, pickerHues, symbolIconValue, tileColor, type IconBackground } from "@/lib/entity-icons";
import { cn } from "@/lib/utils";

const suggestedEmojis = ["🚀", "💡", "🎨", "🛠️", "📱", "🌐", "🧪", "📊", "🛒", "📚", "🎵", "🎬", "🏠", "🌱", "🔥", "⚡", "🧠", "🤖", "🔒", "💬", "📝", "🗂️", "🎯", "🏢", "🐞", "☕", "🍵", "🌙", "⭐", "❤️"];

type IconKind = "symbol" | "emoji";

type ProjectIconDialogProps = {
  /** Project or environment whose icon is edited; null = closed. */
  target: { name: string; icon: string | null } | null;
  onOpenChange: (open: boolean) => void;
  onSave: (icon: string | null) => void;
};

const tileClassName = "flex aspect-square items-center justify-center rounded-md transition-colors duration-150 hover:bg-foreground/[0.07]";
const swatchClassName = "flex size-6 items-center justify-center rounded-full ring-offset-2 ring-offset-background transition-shadow duration-150";

/** Icon for projects and environments: symbol or emoji, with a coloured tile or without background. */
export function ProjectIconDialog({ target, onOpenChange, onSave }: ProjectIconDialogProps) {
  const [glyphDraft, setGlyphDraft] = useState("");
  const [backgroundDraft, setBackgroundDraft] = useState<IconBackground>("auto");
  const [iconKind, setIconKind] = useState<IconKind>("symbol");

  useEffect(() => {
    const parsedIcon = parseEntityIcon(target?.icon);
    setGlyphDraft(parsedIcon.glyph ?? "");
    setBackgroundDraft(parsedIcon.background);
    setIconKind(parsedIcon.glyph && !isSymbolGlyph(parsedIcon.glyph) ? "emoji" : "symbol");
  }, [target]);

  const glyph = glyphDraft.trim();
  // Without a glyph the letter stays; only a chosen colour is stored.
  const iconValue = glyph ? formatEntityIcon(glyph, backgroundDraft) : typeof backgroundDraft === "number" ? `;bg=${backgroundDraft}` : null;
  const nameHue = hueForName(target?.name ?? "");
  const selectedHue = backgroundDraft === "auto" ? nameHue : backgroundDraft;

  /** Picking a glyph of the other kind starts with that kind's usual background. */
  const pickGlyph = (nextGlyph: string) => {
    if (isSymbolGlyph(nextGlyph) !== isSymbolGlyph(glyph) || !glyph) setBackgroundDraft(isSymbolGlyph(nextGlyph) ? "auto" : "none");
    setGlyphDraft(nextGlyph);
  };

  const save = (icon: string | null) => {
    onSave(icon);
    onOpenChange(false);
  };

  return (
    <Dialog open={Boolean(target)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <form
          className="grid gap-4"
          onSubmit={(formEvent) => {
            formEvent.preventDefault();
            save(iconValue);
          }}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-[15px]">
              <ProjectAvatar name={target?.name ?? ""} icon={iconValue} /> Icon für {target?.name}
            </DialogTitle>
          </DialogHeader>
          <SegmentedControl
            options={[
              { value: "symbol", label: "Symbole" },
              { value: "emoji", label: "Emoji" },
            ]}
            value={iconKind}
            onValueChange={setIconKind}
          />
          {iconKind === "symbol" ? (
            <div key="symbol" className="grid animate-in grid-cols-8 gap-1 fade-in duration-150" role="listbox" aria-label="Symbole">
              {Object.entries(entityIcons).map(([iconName, SymbolIcon]) => {
                const symbolValue = symbolIconValue(iconName);
                return (
                  <button
                    key={iconName}
                    type="button"
                    role="option"
                    title={iconName}
                    aria-label={iconName}
                    aria-selected={glyph === symbolValue}
                    onClick={() => pickGlyph(symbolValue)}
                    className={cn(tileClassName, "text-muted-foreground hover:text-foreground", glyph === symbolValue && "bg-primary/15 text-foreground")}
                  >
                    <SymbolIcon className="size-[18px]" />
                  </button>
                );
              })}
            </div>
          ) : (
            <div key="emoji" className="grid animate-in gap-3 fade-in duration-150">
              <div className="grid grid-cols-10 gap-1" role="listbox" aria-label="Emojis">
                {suggestedEmojis.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    role="option"
                    aria-selected={glyph === emoji}
                    onClick={() => pickGlyph(emoji)}
                    className={cn(tileClassName, "text-[17px]", glyph === emoji && "bg-primary/15")}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
              <Input
                value={isSymbolGlyph(glyphDraft) ? "" : glyphDraft}
                maxLength={16}
                placeholder="Eigenes Emoji (⌃⌘Leertaste)"
                onChange={(changeEvent) => pickGlyph(changeEvent.target.value)}
              />
            </div>
          )}

          <div className="flex items-center gap-3">
            <span className="text-[12.5px] text-muted-foreground">Hintergrund</span>
            <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Hintergrund">
              <button
                type="button"
                role="radio"
                aria-checked={backgroundDraft === "none"}
                aria-label="Ohne Hintergrund"
                title="Ohne Hintergrund"
                disabled={!glyph}
                onClick={() => setBackgroundDraft("none")}
                className={cn(swatchClassName, "border text-muted-foreground disabled:opacity-40", backgroundDraft === "none" && "ring-2 ring-primary")}
              >
                <Ban className="size-3.5" />
              </button>
              {pickerHues.map((hue) => (
                <button
                  key={hue}
                  type="button"
                  role="radio"
                  aria-checked={backgroundDraft !== "none" && selectedHue === hue}
                  aria-label={hue === nameHue ? "Standardfarbe" : `Farbe ${hue}`}
                  title={hue === nameHue ? "Standardfarbe" : undefined}
                  onClick={() => setBackgroundDraft(hue === nameHue ? "auto" : hue)}
                  className={cn(swatchClassName, backgroundDraft !== "none" && selectedHue === hue && "ring-2 ring-primary")}
                  style={{ background: tileColor(hue) }}
                />
              ))}
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" className="sm:mr-auto" disabled={!target?.icon} onClick={() => save(null)}>
              Buchstabe verwenden
            </Button>
            <Button type="submit">Speichern</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
