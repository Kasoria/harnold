import { settingsStore } from "../../settings.ts";
import { providerStore } from "../../providers.ts";
import { t } from "../../i18n.ts";

/** Model value of Harnold's agent: provider and model in one string. */
export const nativeModelSeparator = "::";
export const parseNativeModel = (model: string): { providerId: string; modelId: string } | null => {
  const separatorIndex = model.indexOf(nativeModelSeparator);
  if (separatorIndex <= 0) return null;
  return { providerId: model.slice(0, separatorIndex), modelId: model.slice(separatorIndex + nativeModelSeparator.length) };
};

/** Every model of every ready provider, as "providerId::modelId". */
export const nativeModels = (): string[] =>
  providerStore
    .list()
    .filter((provider) => provider.ready)
    .flatMap((provider) => provider.models.map((modelId) => `${provider.id}${nativeModelSeparator}${modelId}`));

const defaultModelKey = "native.defaultModel";

export const nativeSettings = {
  defaultModel(): string {
    const stored = settingsStore.read<string>(defaultModelKey, "");
    const available = nativeModels();
    return available.includes(stored) ? stored : (available[0] ?? "");
  },
  writeDefaultModel(model: string): string {
    if (!parseNativeModel(model)) throw new Error(t("Unbekanntes Modell"));
    settingsStore.write(defaultModelKey, model);
    return model;
  },
};
