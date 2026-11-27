type TauriInternals = { invoke: <Result>(command: string, args?: Record<string, unknown>) => Promise<Result> };
const tauriInternals = () => (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;

const allowedOrigins = new Set<string>();

/**
 * Desktop app: frames from another origin (remote Core, preview proxy) must be allowed first, otherwise the
 * window's navigation guard cancels them and opens them in the browser. No-op in the browser and for old apps.
 */
export async function allowEmbeddedOrigin(url: string): Promise<void> {
  const internals = tauriInternals();
  if (!internals) return;
  let origin: string;
  try {
    origin = new URL(url, window.location.href).origin;
  } catch {
    return;
  }
  if (origin === window.location.origin || allowedOrigins.has(origin)) return;
  try {
    await internals.invoke("allow_embedded_origin", { url: origin });
    allowedOrigins.add(origin);
  } catch {
    // older desktop app without the command
  }
}
