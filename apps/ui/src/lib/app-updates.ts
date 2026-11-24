import { useEffect, useState } from "react";
import { accessToken, coreBaseUrl } from "@/api";

/** App version and updates: desktop (Tauri commands in updates.rs) installs itself, a Docker server only reports a newer release. */
type TauriInternals = { invoke: <Result>(command: string, args?: Record<string, unknown>) => Promise<Result> };
export type AvailableUpdate = { version: string; notes: string | null };

const tauriInternals = () => (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;

export const appVersion = __HARNOLD_VERSION__;
/** Desktop app: updates install themselves. Docker server: the UI only reports; the update runs on the server. */
export type UpdateMode = "desktop" | "docker";
type ServerUpdateInfo = { deployment: string; latest: { version: string; notes: string | null; url: string } | null; canInstall?: boolean };

export const updatesSupported = () => Boolean(tauriInternals());

let serverInfoRequest: Promise<ServerUpdateInfo | null> | null = null;
function loadServerInfo(forceRefresh = false): Promise<ServerUpdateInfo | null> {
  if (forceRefresh || !serverInfoRequest) {
    serverInfoRequest = fetch(`${coreBaseUrl}/api/update-check`, { headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {} })
      .then((response) => (response.ok ? (response.json() as Promise<ServerUpdateInfo>) : null))
      .catch(() => null);
  }
  return serverInfoRequest;
}

/** True when `candidate` is a higher MAJOR.MINOR.PATCH than `current`. */
const isNewerVersion = (candidate: string, current: string): boolean => {
  const candidateParts = candidate.split(".").map(Number);
  const currentParts = current.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    const difference = (candidateParts[index] ?? 0) - (currentParts[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
};

export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  const internals = tauriInternals();
  if (internals) return internals.invoke<AvailableUpdate | null>("check_for_update");
  const info = await loadServerInfo(true);
  if (info?.deployment !== "docker" || !info.latest || !isNewerVersion(info.latest.version, appVersion)) return null;
  return { version: info.latest.version, notes: info.latest.notes };
}

/** Docker server with an update service: the "Update" button works there, otherwise the UI shows the command. */
export const useCanInstallOnServer = (): boolean => {
  const [canInstall, setCanInstall] = useState(false);
  useEffect(() => {
    let active = true;
    void loadServerInfo().then((info) => active && setCanInstall(Boolean(info?.canInstall)));
    return () => {
      active = false;
    };
  }, []);
  return canInstall;
};

const serverIsReachable = (): Promise<boolean> =>
  fetch(`${coreBaseUrl}/api/auth/check`, { headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {} })
    .then((response) => response.ok)
    .catch(() => false);

/** Desktop: downloads, installs and restarts the app. Docker server: asks the update service, waits for the restart and reloads. Resolves only on error (rejects). */
export async function installUpdate(): Promise<void> {
  const internals = tauriInternals();
  if (internals) return void (await internals.invoke("install_update"));
  const response = await fetch(`${coreBaseUrl}/api/update-install`, { method: "POST", headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {} });
  if (!response.ok) throw new Error(((await response.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${response.status}`);
  // The container goes down while the update service swaps the image, then comes back with the new version.
  const deadline = Date.now() + 10 * 60 * 1000;
  let wentDown = false;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const reachable = await serverIsReachable();
    if (!reachable) wentDown = true;
    else if (wentDown) return void location.reload();
  }
  throw new Error("Das Update dauert ungewöhnlich lange. Prüfe den Server.");
}

/** How updates work here: null in plain local/dev setups (nothing to check). */
export function useUpdateMode(): UpdateMode | null {
  const [mode, setMode] = useState<UpdateMode | null>(updatesSupported() ? "desktop" : null);
  useEffect(() => {
    if (updatesSupported()) return;
    let active = true;
    void loadServerInfo().then((info) => active && setMode(info?.deployment === "docker" ? "docker" : null));
    return () => {
      active = false;
    };
  }, []);
  return mode;
}

let backgroundCheck: Promise<AvailableUpdate | null> | null = null;

/** Newer version found by one quiet check per app start; shared by sidebar and settings. */
export function useAvailableUpdate(): AvailableUpdate | null {
  const [availableUpdate, setAvailableUpdate] = useState<AvailableUpdate | null>(null);
  useEffect(() => {
    backgroundCheck ??= checkForUpdate().catch(() => null);
    let active = true;
    void backgroundCheck.then((update) => active && setAvailableUpdate(update));
    return () => {
      active = false;
    };
  }, []);
  return availableUpdate;
}
