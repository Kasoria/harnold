import { askForText } from "@/components/text-prompt-dialog";
import { browseForFolder, folderPickerAvailable } from "@/components/folder-picker-dialog";
import { t } from "@/lib/i18n";

type TauriInternals = { invoke: <Result>(command: string, args?: Record<string, unknown>) => Promise<Result> };
const tauriInternals = () => (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;

/** Lets the user choose a local folder: the system dialog in the desktop app, a folder browser of the server in the browser. null = cancelled. */
export async function pickFolder(title: string): Promise<string | null> {
  const internals = tauriInternals();
  if (internals) {
    const chosen = await internals.invoke<string | string[] | null>("plugin:dialog|open", { options: { directory: true, multiple: false, title } });
    return Array.isArray(chosen) ? (chosen[0] ?? null) : chosen;
  }
  if (folderPickerAvailable()) return browseForFolder(title);
  const typedPath = await askForText({ title, placeholder: t("Absoluter Pfad, z. B. ~/Code/projekt"), confirmLabel: t("Hinzufügen") });
  return typedPath?.trim() || null;
}
