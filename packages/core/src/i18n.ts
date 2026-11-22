import { AsyncLocalStorage } from "node:async_hooks";
import { settingsStore } from "./settings.ts";
import { englishTexts } from "./i18n-en.ts";

/**
 * Language of messages the Core shows to people (errors, channel replies). German texts are the source and wrapped
 * in t(); the language comes from the request (x-harnold-language) or, outside requests, from the stored setting.
 */
export type Language = "de" | "en";
const requestLanguage = new AsyncLocalStorage<Language>();
const dictionaries: Record<Language, Record<string, string>> = { de: {}, en: englishTexts };

export const languageSettings = {
  read: (): Language => (settingsStore.read<string>("language", "de") === "en" ? "en" : "de"),
  write: (language: Language) => settingsStore.write("language", language),
};

export const parseLanguage = (value: string | undefined | null): Language | null => (value === "en" || value === "de" ? value : null);

export function runWithLanguage<Result>(language: Language, work: () => Result): Result {
  return requestLanguage.run(language, work);
}

export function currentLanguage(): Language {
  return requestLanguage.getStore() ?? languageSettings.read();
}

export function t(sourceText: string, ...values: (string | number | null | undefined)[]): string {
  const translated = dictionaries[currentLanguage()][sourceText] ?? sourceText;
  return values.length ? translated.replace(/\{(\d+)\}/g, (_placeholder, index: string) => String(values[Number(index)] ?? "")) : translated;
}
