import { useEffect, useState } from "react";
import { RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { eventToCombo, firesWhileTyping, formatCombo, isOverridden, resetAllShortcuts, resetShortcut, setShortcut, shortcutDefinitions, useShortcutBindings, type ShortcutId } from "@/lib/shortcuts";

/** Shortcut help and editor: click a combo, press the new keys. Esc cancels, ⌫ unassigns. */
export function ShortcutsSection() {
  const bindings = useShortcutBindings();
  const [recordingId, setRecordingId] = useState<ShortcutId | null>(null);
  const groups = [...new Set(shortcutDefinitions.map((definition) => definition.group))];
  const anyOverridden = shortcutDefinitions.some((definition) => isOverridden(definition.id));

  useEffect(() => {
    if (!recordingId) return;
    const handleKeyDown = (keyboardEvent: KeyboardEvent) => {
      // Capture phase: nothing else (global shortcuts, inputs) sees the keys while recording.
      keyboardEvent.preventDefault();
      keyboardEvent.stopImmediatePropagation();
      if (keyboardEvent.key === "Escape") return setRecordingId(null);
      if (keyboardEvent.key === "Backspace" || keyboardEvent.key === "Delete") {
        setShortcut(recordingId, "");
        return setRecordingId(null);
      }
      const combo = eventToCombo(keyboardEvent);
      if (!combo) return;
      if (!firesWhileTyping(combo)) return toast.info(t("Mit ⌘, Strg oder Alt kombinieren"));
      const conflictLabel = setShortcut(recordingId, combo);
      if (conflictLabel) return toast.error(t("{0} ist schon für „{1}“ vergeben", formatCombo(combo), conflictLabel));
      setRecordingId(null);
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [recordingId]);

  return (
    <div className="grid gap-6">
      {groups.map((group) => (
        <section key={group}>
          <h3 className="mb-1.5 text-[12px] font-medium text-muted-foreground">{group}</h3>
          <div className="divide-y rounded-lg border">
            {shortcutDefinitions
              .filter((definition) => definition.group === group)
              .map((definition) => {
                const recording = recordingId === definition.id;
                const combo = bindings[definition.id];
                return (
                  <div key={definition.id} className="flex h-10 items-center gap-2 px-3 text-[13px]">
                    <span className="flex-1 truncate">{definition.label}</span>
                    {isOverridden(definition.id) && !recording && (
                      <button aria-label={t("Zurücksetzen")} title={t("Zurücksetzen")} className="text-muted-foreground transition-colors hover:text-foreground" onClick={() => resetShortcut(definition.id)}>
                        <RotateCcw className="size-3.5" />
                      </button>
                    )}
                    <button
                      onClick={() => setRecordingId(recording ? null : definition.id)}
                      onBlur={() => recording && setRecordingId(null)}
                      className={cn(
                        "flex h-7 min-w-24 items-center justify-center gap-1 rounded-md border px-2 text-[12px] transition-colors",
                        recording ? "border-primary text-primary ring-[3px] ring-ring/30" : "hover:bg-foreground/5",
                        !combo && !recording && "text-muted-foreground",
                      )}
                    >
                      {recording ? t("Taste drücken …") : combo ? <kbd className="font-sans">{formatCombo(combo)}</kbd> : t("Nicht belegt")}
                    </button>
                    {recording && combo && (
                      <button aria-label={t("Entfernen")} title={t("Entfernen")} className="text-muted-foreground hover:text-foreground" onMouseDown={(mouseEvent) => mouseEvent.preventDefault()} onClick={() => { setShortcut(definition.id, ""); setRecordingId(null); }}>
                        <X className="size-3.5" />
                      </button>
                    )}
                  </div>
                );
              })}
          </div>
        </section>
      ))}
      <div>
        <Button variant="outline" size="sm" disabled={!anyOverridden} onClick={resetAllShortcuts}>
          {t("Alle zurücksetzen")}
        </Button>
      </div>
    </div>
  );
}
