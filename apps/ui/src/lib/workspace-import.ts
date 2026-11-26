/** Imports an exported Harnold file into the connected Core. Lives outside the screen, so it survives closing it. */
import { useSyncExternalStore } from "react";
import { accessToken, coreBaseUrl } from "@/api";
import { currentLanguage, t } from "@/lib/i18n";
import { transferArchive, type ServerAnswer, type TransferRequest } from "../../../../packages/core/src/archive-transfer.ts";

export type ImportState = {
  phase: "idle" | "uploading" | "unpacking" | "restarting" | "done" | "restartRequired" | "failed" | "cancelled";
  sentBytes: number;
  totalBytes: number;
  remainingSeconds: number | null;
  reconnecting: boolean;
  error: string | null;
  warning: string | null;
};

/** Browsers allow six connections per server; the app keeps some for itself. */
const parallelUploads = 4;
const idleState: ImportState = { phase: "idle", sentBytes: 0, totalBytes: 0, remainingSeconds: null, reconnecting: false, error: null, warning: null };
let state = idleState;
let abortController: AbortController | null = null;
const listeners = new Set<() => void>();

const update = (changes: Partial<ImportState>) => {
  state = { ...state, ...changes };
  for (const listener of listeners) listener();
};

export const isImportRunning = (phase: ImportState["phase"]) => phase === "uploading" || phase === "unpacking" || phase === "restarting";

export const useWorkspaceImport = (): ImportState =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );

const request: TransferRequest = async (method, route, { body, contentType, signal }) => {
  const response = await fetch(coreBaseUrl + route, {
    method,
    headers: {
      ...(contentType ? { "content-type": contentType } : {}),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      "x-harnold-language": currentLanguage,
    },
    body,
    signal,
  });
  return { status: response.status, answer: (await response.json().catch(() => ({}))) as ServerAnswer };
};

/** Closing the page would end the upload. */
const warnBeforeLeaving = (event: BeforeUnloadEvent) => event.preventDefault();

export async function startWorkspaceImport(file: File): Promise<void> {
  if (isImportRunning(state.phase)) return;
  const controller = new AbortController();
  abortController = controller;
  update({ ...idleState, phase: "uploading", totalBytes: file.size });
  window.addEventListener("beforeunload", warnBeforeLeaving);
  try {
    const { restartRequired, warning } = await transferArchive({
      totalBytes: file.size,
      read: async (start, end) => file.slice(start, end),
      request,
      parallelUploads,
      signal: controller.signal,
      messages: {
        serverError: (statusCode, detail) => detail ?? t("Der Server antwortet mit Fehler {0}.", statusCode),
        connectionLost: (reason) => t("Die Verbindung ist abgebrochen: {0}", reason),
        uploadLimit: () => t("Der Reverse-Proxy vor dem Server lehnt selbst kleine Uploads ab. Erhöhe dort das Upload-Limit (nginx: client_max_body_size)."),
        notResponding: () => t("Der Server meldet sich nach dem Neustart nicht. Prüfe ihn und seine Logs."),
      },
      onProgress: (progress) => update(progress),
    });
    update({ phase: restartRequired ? "restartRequired" : "done", warning });
  } catch (importError) {
    if (controller.signal.aborted) update({ phase: "cancelled" });
    else update({ phase: "failed", error: importError instanceof Error ? importError.message : String(importError) });
  } finally {
    window.removeEventListener("beforeunload", warnBeforeLeaving);
  }
}

export function cancelWorkspaceImport(): void {
  if (state.phase === "uploading") abortController?.abort();
}
