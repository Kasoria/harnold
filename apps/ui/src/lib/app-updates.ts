import { useEffect, useState } from "react";

/** App version and on-demand updates. Updates only exist in the desktop app (Tauri commands in updates.rs). */
type TauriInternals = { invoke: <Result>(command: string, args?: Record<string, unknown>) => Promise<Result> };
export type AvailableUpdate = { version: string; notes: string | null };

const tauriInternals = () => (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;

export const appVersion = __HARNOLD_VERSION__;
export const updatesSupported = () => Boolean(tauriInternals());

export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  const internals = tauriInternals();
  return internals ? internals.invoke<AvailableUpdate | null>("check_for_update") : null;
}

/** Downloads, installs and restarts the app; resolves only on error (rejects). */
export async function installUpdate(): Promise<void> {
  const internals = tauriInternals();
  if (internals) await internals.invoke("install_update");
}

let backgroundCheck: Promise<AvailableUpdate | null> | null = null;

/** Newer version found by one quiet check per app start (desktop only); shared by sidebar and settings. */
export function useAvailableUpdate(): AvailableUpdate | null {
  const [availableUpdate, setAvailableUpdate] = useState<AvailableUpdate | null>(null);
  useEffect(() => {
    if (!updatesSupported()) return;
    backgroundCheck ??= checkForUpdate().catch(() => null);
    let active = true;
    void backgroundCheck.then((update) => active && setAvailableUpdate(update));
    return () => {
      active = false;
    };
  }, []);
  return availableUpdate;
}
