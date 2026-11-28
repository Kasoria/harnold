import { safeStorage } from "@/lib/storage";

type TauriInternals = { invoke: <Result>(command: string, args?: Record<string, unknown>) => Promise<Result> };
const tauriInternals = () => (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
const browserNotificationsSupported = () => typeof Notification !== "undefined";

/** Desktop app: system notification via the Tauri plugin (asks for permission once, the OS remembers it). */
async function notifyInDesktopApp(internals: TauriInternals, title: string, body: string): Promise<void> {
  let granted = await internals.invoke<boolean>("plugin:notification|is_permission_granted");
  if (!granted) granted = (await internals.invoke<string>("plugin:notification|request_permission")) === "granted";
  if (granted) await internals.invoke("plugin:notification|notify", { options: { title, body } });
}

/** Browsers only show the permission prompt after a user gesture – ask on the first click. */
export function askForNotificationPermissionOnFirstClick(): () => void {
  if (tauriInternals() || !browserNotificationsSupported() || Notification.permission !== "default" || safeStorage.getItem("harnold.notificationsAsked")) return () => {};
  const ask = () => {
    safeStorage.setItem("harnold.notificationsAsked", "1");
    void Notification.requestPermission();
  };
  window.addEventListener("pointerdown", ask, { once: true });
  return () => window.removeEventListener("pointerdown", ask);
}

/** System notification for a new approval – only while the user is not looking at Harnold. */
export function notifyPermissionRequest(title: string, body: string, onClick: () => void): void {
  if (document.visibilityState === "visible" && document.hasFocus()) return;
  const internals = tauriInternals();
  if (internals) {
    notifyInDesktopApp(internals, title, body).catch(() => {});
    return;
  }
  if (!browserNotificationsSupported() || Notification.permission !== "granted") return;
  const notification = new Notification(title, { body, tag: "harnold-permission", icon: "/icon-192.png" });
  notification.onclick = () => {
    window.focus();
    onClick();
    notification.close();
  };
}

/** Number of open approvals on the dock / taskbar icon of the desktop app. */
export function setAppBadgeCount(count: number): void {
  tauriInternals()?.invoke("plugin:window|set_badge_count", { count: count > 0 ? count : null }).catch(() => {});
}
