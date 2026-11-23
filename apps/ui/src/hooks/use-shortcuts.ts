import { useEffect, useRef } from "react";
import { currentBindings, eventToCombo, firesWhileTyping, type ShortcutId } from "@/lib/shortcuts";

const isTypingTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/** One window listener for all app shortcuts; handlers may change every render. */
export function useGlobalShortcuts(handlers: Partial<Record<ShortcutId, () => void>>) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const handleKeyDown = (keyboardEvent: KeyboardEvent) => {
      // Editors (Monaco) and the shortcut recorder claim their keys by preventing the default.
      if (keyboardEvent.defaultPrevented || keyboardEvent.isComposing || keyboardEvent.repeat) return;
      const combo = eventToCombo(keyboardEvent);
      if (!combo) return;
      const bindings = currentBindings();
      const matchedId = (Object.keys(bindings) as ShortcutId[]).find((shortcutId) => bindings[shortcutId] === combo);
      if (!matchedId) return;
      if (isTypingTarget(keyboardEvent.target) && !firesWhileTyping(combo)) return;
      const handler = handlersRef.current[matchedId];
      if (!handler) return;
      keyboardEvent.preventDefault();
      handler();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}
