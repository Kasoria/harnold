import { useSyncExternalStore } from "react";
import { safeStorage } from "@/lib/storage";
import { t } from "@/lib/i18n";

/**
 * Keyboard shortcuts: one registry (defaults) plus the user's overrides (localStorage).
 * A combo is a string like "Mod+Shift+N": Mod = ⌘ on macOS, Ctrl elsewhere; "Ctrl" is the literal Control key on macOS.
 * Symbol keys carry no Shift (the symbol already is the result of Shift on some layouts), so "Mod+/" works on German keyboards too.
 */
export type ShortcutId =
  | "search"
  | "newSession"
  | "newQuickChat"
  | "newProject"
  | "toggleWorkspace"
  | "toggleTheme"
  | "interrupt"
  | "previousSession"
  | "nextSession"
  | "openSettings"
  | "openShortcuts"
  | "goChat"
  | "goToday"
  | "goTasks"
  | "goChannels"
  | "goMail"
  | "goMemory"
  | "goFiles"
  | "goIntegrations"
  | "goDesign"
  | "goEnvironments"
  | "goTeam";

export type ShortcutDefinition = { id: ShortcutId; group: string; label: string; defaultCombo: string };

export const shortcutDefinitions: ShortcutDefinition[] = [
  { id: "search", group: t("Allgemein"), label: t("Suchen & Befehle"), defaultCombo: "Mod+K" },
  { id: "openShortcuts", group: t("Allgemein"), label: t("Tastenkürzel anzeigen"), defaultCombo: "Mod+/" },
  { id: "openSettings", group: t("Allgemein"), label: t("Einstellungen"), defaultCombo: "Mod+," },
  { id: "toggleTheme", group: t("Allgemein"), label: t("Hell/Dunkel wechseln"), defaultCombo: "Mod+Shift+D" },
  { id: "newSession", group: t("Chat"), label: t("Neue Session im aktiven Projekt"), defaultCombo: "Mod+N" },
  { id: "newQuickChat", group: t("Chat"), label: t("Neuer Quick Chat"), defaultCombo: "Mod+T" },
  { id: "newProject", group: t("Chat"), label: t("Neues Projekt"), defaultCombo: "Mod+Shift+N" },
  { id: "previousSession", group: t("Chat"), label: t("Vorherige Session"), defaultCombo: "Mod+Alt+ArrowUp" },
  { id: "nextSession", group: t("Chat"), label: t("Nächste Session"), defaultCombo: "Mod+Alt+ArrowDown" },
  { id: "interrupt", group: t("Chat"), label: t("Durchlauf stoppen"), defaultCombo: "Mod+." },
  { id: "toggleWorkspace", group: t("Chat"), label: t("Workspace ein-/ausblenden"), defaultCombo: "Mod+B" },
  { id: "goChat", group: t("Navigation"), label: t("Chat & Workspace"), defaultCombo: "Mod+0" },
  { id: "goToday", group: t("Navigation"), label: t("Heute"), defaultCombo: "Mod+1" },
  { id: "goTasks", group: t("Navigation"), label: t("Tasks"), defaultCombo: "Mod+2" },
  { id: "goChannels", group: t("Navigation"), label: t("Channels"), defaultCombo: "Mod+3" },
  { id: "goMail", group: t("Navigation"), label: t("Postfächer"), defaultCombo: "Mod+4" },
  { id: "goMemory", group: t("Navigation"), label: t("Memory"), defaultCombo: "Mod+5" },
  { id: "goFiles", group: t("Navigation"), label: t("Dateien"), defaultCombo: "Mod+6" },
  { id: "goIntegrations", group: t("Navigation"), label: t("Integrationen"), defaultCombo: "Mod+7" },
  { id: "goDesign", group: t("Navigation"), label: t("Design Systems"), defaultCombo: "Mod+8" },
  { id: "goEnvironments", group: t("Navigation"), label: t("Umgebungen"), defaultCombo: "Mod+9" },
  { id: "goTeam", group: t("Navigation"), label: t("Team"), defaultCombo: "" },
];

const storageKey = "harnold.shortcuts";
export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Overrides by id; "" = deliberately unassigned. */
type Overrides = Partial<Record<ShortcutId, string>>;

function readOverrides(): Overrides {
  try {
    const parsed: unknown = JSON.parse(safeStorage.getItem(storageKey) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Overrides) : {};
  } catch {
    return {};
  }
}

let overrides = readOverrides();
let bindingsSnapshot = computeBindings();
const listeners = new Set<() => void>();

function computeBindings(): Record<ShortcutId, string> {
  const bindings = {} as Record<ShortcutId, string>;
  for (const definition of shortcutDefinitions) bindings[definition.id] = overrides[definition.id] ?? definition.defaultCombo;
  return bindings;
}

function publish() {
  safeStorage.setItem(storageKey, JSON.stringify(overrides));
  bindingsSnapshot = computeBindings();
  for (const listener of listeners) listener();
}

export const currentBindings = () => bindingsSnapshot;
export const isOverridden = (shortcutId: ShortcutId) => shortcutId in overrides;

/** Sets a combo ("" = unassign). Returns the label of the shortcut that already uses it, if any – then nothing changes. */
export function setShortcut(shortcutId: ShortcutId, combo: string): string | null {
  if (combo) {
    const conflict = shortcutDefinitions.find((definition) => definition.id !== shortcutId && bindingsSnapshot[definition.id] === combo);
    if (conflict) return conflict.label;
  }
  const definition = shortcutDefinitions.find((candidate) => candidate.id === shortcutId);
  if (definition && combo === definition.defaultCombo) delete overrides[shortcutId];
  else overrides = { ...overrides, [shortcutId]: combo };
  publish();
  return null;
}

export function resetShortcut(shortcutId: ShortcutId) {
  const { [shortcutId]: _removed, ...rest } = overrides;
  overrides = rest;
  publish();
}

export function resetAllShortcuts() {
  overrides = {};
  publish();
}

/** Re-renders the caller whenever a binding changes. */
export function useShortcutBindings(): Record<ShortcutId, string> {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    currentBindings,
  );
}

const modifierKeys = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock"]);

/** Key name of an event; falls back to the physical key where ⌥ replaces the typed character (macOS). */
function keyName(keyboardEvent: KeyboardEvent): string | null {
  if (modifierKeys.has(keyboardEvent.key)) return null;
  if (keyboardEvent.altKey && /^(Key[A-Z]|Digit\d)$/.test(keyboardEvent.code)) return keyboardEvent.code.slice(-1);
  if (keyboardEvent.key === " ") return "Space";
  return keyboardEvent.key.length === 1 ? keyboardEvent.key.toUpperCase() : keyboardEvent.key;
}

/** Combo of a keyboard event, or null for a bare modifier / unsupported modifier (Windows key). */
export function eventToCombo(keyboardEvent: KeyboardEvent): string | null {
  const key = keyName(keyboardEvent);
  if (!key) return null;
  if (!isMac && keyboardEvent.metaKey) return null;
  const parts: string[] = [];
  if (isMac ? keyboardEvent.metaKey : keyboardEvent.ctrlKey) parts.push("Mod");
  if (isMac && keyboardEvent.ctrlKey) parts.push("Ctrl");
  if (keyboardEvent.altKey) parts.push("Alt");
  const isLetterOrDigit = /^[A-Z0-9]$/.test(key);
  const isSymbol = key.length === 1 && !isLetterOrDigit;
  if (keyboardEvent.shiftKey && !isSymbol) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

const keySymbols: Record<string, string> = { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Enter: "↵", Escape: "Esc", Backspace: "⌫", Tab: "⇥", Space: "␣" };

/** Human-readable combo: ⌘⇧N on macOS, Strg+Umschalt+N elsewhere. */
export function formatCombo(combo: string): string {
  if (!combo) return "";
  const parts = combo.split("+");
  const key = parts[parts.length - 1] === "" ? "+" : parts[parts.length - 1];
  const modifiers = parts.slice(0, -1);
  const keyLabel = keySymbols[key] ?? key;
  if (isMac) {
    const order: [string, string][] = [["Ctrl", "⌃"], ["Alt", "⌥"], ["Shift", "⇧"], ["Mod", "⌘"]];
    return order.filter(([modifier]) => modifiers.includes(modifier)).map(([, symbol]) => symbol).join("") + keyLabel;
  }
  const order: [string, string][] = [["Mod", t("Strg")], ["Alt", "Alt"], ["Shift", t("Umschalt")]];
  return [...order.filter(([modifier]) => modifiers.includes(modifier)).map(([, label]) => label), keyLabel].join("+");
}

/** Whether a combo may fire while typing in a text field: only with a real modifier (not Shift alone). */
export const firesWhileTyping = (combo: string) => /(^|\+)(Mod|Ctrl|Alt)\+/.test(combo);
