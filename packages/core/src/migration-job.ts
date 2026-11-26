/** Moving to a server and exporting to a file: one background job at a time, which the UI can watch. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { config } from "./config.ts";
import { createExportArchive, exportFolderName, removeStaleExports, temporaryArchivePath, type TransferSelection } from "./migration-export.ts";
import { restartsItself } from "./migration-receive.ts";
import { transferArchive, type ServerAnswer, type TransferRequest } from "./archive-transfer.ts";
import { currentLanguage, t } from "./i18n.ts";

export type JobPhase = "idle" | "packing" | "uploading" | "unpacking" | "restarting" | "done" | "failed" | "cancelled";
export type JobStatus = {
  kind: "push" | "export";
  phase: JobPhase;
  sentBytes: number;
  totalBytes: number;
  remainingSeconds: number | null;
  /** The connection dropped; the upload continues where it stopped. */
  reconnecting: boolean;
  error: string | null;
  warning: string | null;
  /** Export: where the file is. */
  filePath: string | null;
};

const parallelUploads = 6;
const idleStatus: JobStatus = { kind: "push", phase: "idle", sentBytes: 0, totalBytes: 0, remainingSeconds: null, reconnecting: false, error: null, warning: null, filePath: null };
let status: JobStatus = idleStatus;
let abortController: AbortController | null = null;

export const readJob = (): JobStatus => status;
const isRunning = () => Boolean(abortController) && !["done", "failed", "cancelled"].includes(status.phase);

const update = (changes: Partial<JobStatus>) => {
  status = { ...status, ...changes };
};

function claimJob(kind: JobStatus["kind"]): { controller: AbortController; release: () => void } {
  if (isRunning()) throw new Error(t("Es läuft bereits eine Übertragung."));
  const previousStatus = status;
  const controller = new AbortController();
  abortController = controller;
  status = { ...idleStatus, kind, phase: "packing" };
  return {
    controller,
    release: () => {
      status = previousStatus;
      abortController = null;
    },
  };
}

/** A sleeping Mac would stall the transfer for hours. */
function keepAwake(): () => void {
  if (process.platform !== "darwin") return () => {};
  const caffeinate = spawn("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" });
  caffeinate.on("error", () => {});
  return () => void caffeinate.kill();
}

async function runJob(signal: AbortSignal, work: () => Promise<void>): Promise<void> {
  const allowSleep = keepAwake();
  try {
    removeStaleExports();
    await work();
  } catch (jobError) {
    if (signal.aborted) update({ phase: "cancelled", reconnecting: false, remainingSeconds: null });
    else {
      console.error("[migration]", jobError);
      update({ phase: "failed", reconnecting: false, remainingSeconds: null, error: jobError instanceof Error ? jobError.message : String(jobError) });
    }
  } finally {
    allowSleep();
  }
}

// --- Move to a server ---

const normalizeServerUrl = (rawUrl: string): string => {
  const address = rawUrl.trim().replace(/\/+$/, "");
  return address && !/^https?:\/\//i.test(address) ? `https://${address}` : address;
};

const serverError = (statusCode: number, detail?: string) => detail ?? t("Der Server antwortet mit Fehler {0}. Läuft dort Harnold in der aktuellen Version?", statusCode);

/** Fails early, before minutes are spent packing. */
async function checkServer(address: string, request: TransferRequest, signal: AbortSignal): Promise<void> {
  type Check = ServerAnswer & { features?: string[]; canImport?: boolean };
  let check: { status: number };
  try {
    check = await request("GET", "/api/auth/check", { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
  } catch {
    throw new Error(t("Keine Verbindung zu {0}", address));
  }
  if (check.status === 401) throw new Error(t("Das Zugriffstoken stimmt nicht."));
  if (check.status >= 300) throw new Error(serverError(check.status));
  const response = await request("GET", "/api/migration/status", { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
  const answer = response.answer as Check;
  if (response.status >= 300 || !answer.features?.includes("parallel-upload")) throw new Error(t("Der Server ist zu alt für diese Übertragung. Aktualisiere zuerst Harnold auf dem Server."));
  if (!answer.canImport) throw new Error(t("Nur auf einem Docker-Server möglich"));
}

/** Checks the server, then transfers in the background. Errors of the check are thrown right away. */
export async function startPush(serverUrl: string, token: string, selection: TransferSelection): Promise<JobStatus> {
  const address = normalizeServerUrl(serverUrl);
  if (!address) throw new Error(t("Server-Adresse fehlt"));
  const { controller, release } = claimJob("push");
  const headers = { "x-harnold-language": currentLanguage(), ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const request: TransferRequest = async (method, route, { body, contentType, signal }) => {
    const response = await fetch(`${address}${route}`, { method, headers: { ...headers, ...(contentType ? { "content-type": contentType } : {}) }, body, signal });
    return { status: response.status, answer: (await response.json().catch(() => ({}))) as ServerAnswer };
  };
  try {
    await checkServer(address, request, controller.signal);
  } catch (checkError) {
    release();
    throw checkError;
  }
  void runJob(controller.signal, async () => {
    const archivePath = temporaryArchivePath();
    try {
      const { unpackedBytes } = await createExportArchive(selection, archivePath, controller.signal);
      const totalBytes = fs.statSync(archivePath).size;
      update({ phase: "uploading", totalBytes });
      const archive = await fs.promises.open(archivePath, "r");
      try {
        const { warning } = await transferArchive({
          totalBytes,
          unpackedBytes,
          read: async (start, end) => {
            const chunk = Buffer.alloc(end - start);
            await archive.read(chunk, 0, chunk.length, start);
            return chunk;
          },
          request,
          parallelUploads,
          signal: controller.signal,
          messages: {
            serverError,
            connectionLost: (reason) => t("Die Verbindung zum Server ist abgebrochen: {0}", reason),
            uploadLimit: () => t("Der Reverse-Proxy vor dem Server lehnt selbst kleine Uploads ab. Erhöhe dort das Upload-Limit (nginx: client_max_body_size)."),
            notResponding: () => t("Der Server meldet sich nach dem Neustart nicht. Prüfe ihn und seine Logs."),
          },
          onProgress: (progress) => update(progress),
        });
        update({ phase: "done", warning });
      } finally {
        await archive.close();
      }
    } finally {
      fs.rmSync(archivePath, { force: true });
    }
  });
  return status;
}

// --- Export to a file ---

/** Desktop: the Downloads folder. Server: a folder in the data volume, from where the browser downloads it. */
function exportDirectory(): string {
  if (restartsItself()) return path.join(config.dataDirectory, exportFolderName);
  const downloads = path.join(os.homedir(), "Downloads");
  return fs.existsSync(downloads) ? downloads : os.homedir();
}

export function startExport(selection: TransferSelection): JobStatus {
  const { controller } = claimJob("export");
  void runJob(controller.signal, async () => {
    const directory = exportDirectory();
    // The server keeps only the latest export; they are large and hold keys.
    if (restartsItself()) fs.rmSync(directory, { recursive: true, force: true });
    fs.mkdirSync(directory, { recursive: true });
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const filePath = path.join(directory, `harnold-${selection.scope === "agents" ? "agenten" : "workspace"}-${timestamp}.tgz`);
    const partialPath = `${filePath}.partial`;
    await createExportArchive(selection, partialPath, controller.signal);
    fs.renameSync(partialPath, filePath);
    update({ phase: "done", filePath, totalBytes: fs.statSync(filePath).size });
  });
  return status;
}

export const exportedFile = (): string | null => (status.kind === "export" && status.filePath && fs.existsSync(status.filePath) ? status.filePath : null);

/** Shows the exported file in the system's file manager. */
export function revealExportedFile(): void {
  const filePath = exportedFile();
  if (!filePath) throw new Error(t("Die Exportdatei gibt es nicht mehr."));
  const [command, args] = process.platform === "darwin" ? ["open", ["-R", filePath]] : process.platform === "win32" ? ["explorer", [`/select,${filePath}`]] : ["xdg-open", [path.dirname(filePath)]];
  spawn(command, args, { detached: true, stdio: "ignore" }).on("error", () => undefined).unref();
}

/** Possible while packing and uploading; afterwards the receiver applies the workspace on its own. */
export function cancelJob(): JobStatus {
  if (status.phase === "packing" || status.phase === "uploading") abortController?.abort();
  return status;
}
