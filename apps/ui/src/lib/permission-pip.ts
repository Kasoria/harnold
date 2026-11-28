import { useSyncExternalStore } from "react";

/** Document Picture-in-Picture (Chromium): a small always-on-top window that stays visible in other tabs/apps. */
type DocumentPip = { requestWindow: (options?: { width?: number; height?: number }) => Promise<Window> };
const pipApi = () => (window as unknown as { documentPictureInPicture?: DocumentPip }).documentPictureInPicture;

export const permissionPipSupported = () => Boolean(pipApi());

let pipWindow: Window | null = null;
const listeners = new Set<() => void>();
const publish = () => {
  for (const listener of listeners) listener();
};

export function usePermissionPipWindow(): Window | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => pipWindow,
  );
}

/** Must run inside a click handler (user gesture). */
export async function openPermissionPip(): Promise<void> {
  const api = pipApi();
  if (!api) return;
  if (pipWindow && !pipWindow.closed) {
    pipWindow.focus();
    return;
  }
  const newWindow = await api.requestWindow({ width: 400, height: 320 });
  // The window starts empty: take over styles and the theme class.
  for (const styleSource of document.querySelectorAll("link[rel=stylesheet], style")) newWindow.document.head.appendChild(styleSource.cloneNode(true));
  newWindow.document.documentElement.className = document.documentElement.className;
  newWindow.document.body.className = "bg-background text-foreground";
  newWindow.addEventListener("pagehide", () => {
    if (pipWindow === newWindow) pipWindow = null;
    publish();
  });
  pipWindow = newWindow;
  publish();
}

export function closePermissionPip(): void {
  pipWindow?.close();
}
