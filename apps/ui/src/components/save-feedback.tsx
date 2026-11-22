import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { t } from "@/lib/i18n";

/** Short inline confirmation for a save: `saved` true for ~1.8 s after the save went through. */
export function useSavedFlash() {
  const [saved, setSaved] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timerRef.current), []);
  const flashSaved = () => {
    window.clearTimeout(timerRef.current);
    setSaved(true);
    timerRef.current = window.setTimeout(() => setSaved(false), 1800);
  };
  return { saved, flashSaved };
}

/** Green check next to a save button – enough feedback, no extra words (docs/UI.md). */
export function SavedCheck({ saved }: { saved: boolean }) {
  if (!saved) return null;
  return <Check aria-label={t("Gespeichert")} className="size-3.5 shrink-0 animate-in text-status-running fade-in duration-150" />;
}

/** Async action with busy state and a short saved confirmation – for API calls behind a button. */
export function useAsyncAction(onError: (unknownError: unknown) => void) {
  const [busy, setBusy] = useState(false);
  const { saved, flashSaved } = useSavedFlash();
  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    try {
      await operation();
      flashSaved();
    } catch (operationError) {
      onError(operationError);
    } finally {
      setBusy(false);
    }
  };
  return { busy, saved, run, flashSaved };
}
