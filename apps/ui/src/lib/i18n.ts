import { safeStorage } from "@/lib/storage";
import { englishTexts } from "@/i18n/en";

/**
 * UI languages. German is the source: texts are written in German and wrapped in t(); other languages map them.
 * Changing the language reloads the app, so t() can be a plain function (also usable outside components).
 */
export type Language = "de" | "en";
export const languages: { value: Language; label: string }[] = [
  { value: "de", label: "Deutsch" },
  { value: "en", label: "English" },
];

const languageStorageKey = "harnold.language";
const dictionaries: Record<Language, Record<string, string>> = { de: {}, en: englishTexts };

function detectLanguage(): Language {
  const stored = safeStorage.getItem(languageStorageKey);
  if (stored === "de" || stored === "en") return stored;
  return typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("de") ? "de" : "en";
}

export const currentLanguage: Language = detectLanguage();
if (typeof document !== "undefined") document.documentElement.lang = currentLanguage;

/** BCP 47 locale for dates and numbers. */
export const locale = () => (currentLanguage === "de" ? "de-DE" : "en-US");

/** Translates a German source text; {0}, {1} … are replaced by the arguments. */
export function t(sourceText: string, ...values: (string | number | null | undefined)[]): string {
  const translated = dictionaries[currentLanguage][sourceText] ?? sourceText;
  return values.length ? translated.replace(/\{(\d+)\}/g, (placeholder, index: string) => String(values[Number(index)] ?? "")) : translated;
}

export function setLanguage(language: Language): void {
  safeStorage.setItem(languageStorageKey, language);
  window.location.reload();
}
