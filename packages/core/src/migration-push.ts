/** Local core: moves this workspace to a server core, as a background job the UI can watch. */
import fs from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import type { AgentTransferOptions } from "./agent-homes.ts";
import { createExportArchive, removeStaleExports } from "./migration-export.ts";
import { migrationProtocolVersion, type UploadStatus } from "./migration-receive.ts";
import { currentLanguage, t } from "./i18n.ts";

export type PushPhase = "idle" | "packing" | "uploading" | "unpacking" | "restarting" | "done" | "failed" | "cancelled";
export type PushStatus = {
  phase: PushPhase;
  sentBytes: number;
  totalBytes: number;
  remainingSeconds: number | null;
  /** The connection dropped; the upload continues where it stopped. */
  reconnecting: boolean;
  error: string | null;
  warning: string | null;
};

// Small pieces keep every request short, so no time limit or upload limit on the way (Node, reverse proxy, tunnel)
// can cut off a large workspace on a slow line.
const minimumChunkBytes = 256 * 1024;
const initialChunkBytes = 1024 * 1024;
const maximumChunkBytes = 16 * 1024 * 1024;
const targetChunkSeconds = 15;
const chunkTimeoutMilliseconds = 4 * 60 * 1000;
const shortTimeoutMilliseconds = 60 * 1000;
/** With the pauses below: about half an hour without a connection before giving up. */
const maximumUploadFailures = 60;
const maximumCreateAttempts = 6;
const statusPollMilliseconds = 3000;
/** About fifteen minutes in which the server may be unreachable while it restarts. */
const maximumStatusFailures = 300;
const speedWindowMilliseconds = 60 * 1000;

const idleStatus: PushStatus = { phase: "idle", sentBytes: 0, totalBytes: 0, remainingSeconds: null, reconnecting: false, error: null, warning: null };
let status: PushStatus = idleStatus;
let abortController: AbortController | null = null;

export const readWorkspacePush = (): PushStatus => status;

const update = (changes: Partial<PushStatus>) => {
  status = { ...status, ...changes };
};

type Connection = { address: string; headers: Record<string, string>; signal: AbortSignal };

const send = (connection: Connection, method: string, route: string, options: { body?: BodyInit; contentType?: string; timeoutMilliseconds?: number } = {}) =>
  fetch(`${connection.address}${route}`, {
    method,
    headers: { ...connection.headers, ...(options.contentType ? { "content-type": options.contentType } : {}) },
    body: options.body,
    signal: AbortSignal.any([connection.signal, AbortSignal.timeout(options.timeoutMilliseconds ?? shortTimeoutMilliseconds)]),
  });

type ServerAnswer = Partial<UploadStatus> & { error?: string; uploadId?: string; protocol?: number; canImport?: boolean };
const readAnswer = async (response: Response) => (await response.json().catch(() => ({}))) as ServerAnswer;

const isTemporaryFailure = (statusCode: number) => statusCode === 408 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
const serverError = (statusCode: number, answer: ServerAnswer) => new Error(answer.error ?? t("Der Server antwortet mit Fehler {0}. Läuft dort Harnold in der aktuellen Version?", statusCode));

const normalizeServerUrl = (rawUrl: string): string => {
  const address = rawUrl.trim().replace(/\/+$/, "");
  return address && !/^https?:\/\//i.test(address) ? `https://${address}` : address;
};

/** Fails early, before minutes are spent packing. */
async function checkServer(connection: Connection): Promise<void> {
  let check: Response;
  try {
    check = await send(connection, "GET", "/api/auth/check");
  } catch {
    throw new Error(t("Keine Verbindung zu {0}", connection.address));
  }
  if (check.status === 401) throw new Error(t("Das Zugriffstoken stimmt nicht."));
  if (!check.ok) throw serverError(check.status, {});
  const response = await send(connection, "GET", "/api/migration/status");
  const answer = await readAnswer(response);
  if (!response.ok || answer.protocol !== migrationProtocolVersion) throw new Error(t("Der Server ist zu alt für diese Übertragung. Aktualisiere zuerst Harnold auf dem Server."));
  if (!answer.canImport) throw new Error(t("Nur auf einem Docker-Server möglich"));
}

async function uploadArchive(connection: Connection, archivePath: string, uploadId: string, totalBytes: number): Promise<void> {
  const archive = await fs.promises.open(archivePath, "r");
  try {
    let offset = 0;
    let chunkBytes = initialChunkBytes;
    let chunkCeiling = maximumChunkBytes;
    let failures = 0;
    const samples: { time: number; bytes: number }[] = [{ time: Date.now(), bytes: 0 }];
    const pauseAfterFailure = async (reason: string) => {
      failures += 1;
      if (failures > maximumUploadFailures) throw new Error(t("Die Verbindung zum Server ist abgebrochen: {0}", reason));
      update({ reconnecting: true, remainingSeconds: null });
      await wait(Math.min(30_000, 1000 * 2 ** Math.min(failures - 1, 5)), undefined, { signal: connection.signal });
      // The measured speed no longer holds after a pause.
      samples.splice(0, samples.length, { time: Date.now(), bytes: offset });
    };
    while (offset < totalBytes) {
      connection.signal.throwIfAborted();
      const chunk = Buffer.alloc(Math.min(chunkBytes, totalBytes - offset));
      await archive.read(chunk, 0, chunk.length, offset);
      const startedAt = Date.now();
      let response: Response;
      let answer: ServerAnswer;
      try {
        response = await send(connection, "PUT", `/api/migration/uploads/${uploadId}/chunk?offset=${offset}`, { body: chunk, contentType: "application/octet-stream", timeoutMilliseconds: chunkTimeoutMilliseconds });
        answer = await readAnswer(response);
      } catch (networkError) {
        connection.signal.throwIfAborted();
        chunkBytes = Math.max(minimumChunkBytes, Math.floor(chunkBytes / 2));
        await pauseAfterFailure(networkError instanceof Error ? networkError.message : String(networkError));
        continue;
      }
      if (response.status === 413) {
        // A reverse proxy in front of the server allows only small requests.
        if (chunk.length <= minimumChunkBytes) throw new Error(t("Der Reverse-Proxy vor dem Server lehnt selbst kleine Uploads ab. Erhöhe dort das Upload-Limit (nginx: client_max_body_size)."));
        chunkCeiling = Math.max(minimumChunkBytes, Math.floor(chunk.length / 2));
        chunkBytes = chunkCeiling;
        continue;
      }
      // 409: the server already has more (or less) than we thought, e.g. when only its answer got lost.
      if (response.status === 409 && typeof answer.receivedBytes === "number") {
        if (answer.receivedBytes === offset) await pauseAfterFailure(answer.error ?? String(response.status));
        offset = answer.receivedBytes;
        continue;
      }
      if (isTemporaryFailure(response.status)) {
        await pauseAfterFailure(answer.error ?? String(response.status));
        continue;
      }
      if (!response.ok || typeof answer.receivedBytes !== "number") throw serverError(response.status, answer);
      failures = 0;
      offset = answer.receivedBytes;
      const now = Date.now();
      const bytesPerSecond = chunk.length / Math.max(0.05, (now - startedAt) / 1000);
      chunkBytes = Math.round(Math.max(minimumChunkBytes, Math.min(chunkCeiling, chunkBytes * 2, bytesPerSecond * targetChunkSeconds)));
      samples.push({ time: now, bytes: offset });
      while (samples.length > 2 && now - samples[0].time > speedWindowMilliseconds) samples.shift();
      const averageBytesPerSecond = ((offset - samples[0].bytes) / Math.max(1, now - samples[0].time)) * 1000;
      update({ sentBytes: offset, reconnecting: false, remainingSeconds: averageBytesPerSecond > 0 ? Math.ceil((totalBytes - offset) / averageBytesPerSecond) : null });
    }
  } finally {
    await archive.close();
  }
}

/** Announces the archive; a short interruption here must not throw away the packed workspace. */
async function createRemoteUpload(connection: Connection, sizeBytes: number, unpackedBytes: number): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    let failure: Error;
    try {
      const response = await send(connection, "POST", "/api/migration/uploads", { body: JSON.stringify({ sizeBytes, unpackedBytes }), contentType: "application/json" });
      const answer = await readAnswer(response);
      if (response.ok && answer.uploadId) return answer.uploadId;
      failure = serverError(response.status, answer);
      if (!isTemporaryFailure(response.status)) attempt = maximumCreateAttempts;
    } catch (networkError) {
      connection.signal.throwIfAborted();
      failure = new Error(t("Keine Verbindung zu {0}", connection.address), { cause: networkError });
    }
    if (attempt >= maximumCreateAttempts) throw failure;
    await wait(statusPollMilliseconds * attempt, undefined, { signal: connection.signal });
  }
}

/** Starts unpacking and follows the server until the workspace is in place. */
async function applyOnServer(connection: Connection, uploadId: string): Promise<string | null> {
  const route = `/api/migration/uploads/${uploadId}`;
  update({ phase: "unpacking", remainingSeconds: null, reconnecting: false });
  let failures = 0;
  for (;;) {
    connection.signal.throwIfAborted();
    let response: Response | null = null;
    let answer: ServerAnswer = {};
    try {
      response = await send(connection, "GET", route);
      answer = await readAnswer(response);
      // "receiving" with a complete upload: not started yet (or the server restarted while unpacking).
      if (response.ok && answer.state === "receiving") {
        response = await send(connection, "POST", `${route}/complete`);
        answer = await readAnswer(response);
      }
    } catch {
      connection.signal.throwIfAborted();
      response = null;
    }
    if (!response || isTemporaryFailure(response.status) || (response.ok && !answer.state)) {
      failures += 1;
      if (failures > maximumStatusFailures) throw new Error(t("Der Server meldet sich nach dem Neustart nicht. Prüfe ihn und seine Logs."));
      update({ phase: "restarting" });
    } else if (!response.ok) {
      throw serverError(response.status, answer);
    } else {
      failures = 0;
      if (answer.state === "applied") return answer.warning ?? null;
      if (answer.state === "failed") throw new Error(answer.error ?? t("Unbekannter Fehler"));
      update({ phase: answer.state === "restarting" ? "restarting" : "unpacking" });
    }
    await wait(statusPollMilliseconds, undefined, { signal: connection.signal });
  }
}

/** A sleeping Mac would stall the upload for hours. */
function keepAwake(): () => void {
  if (process.platform !== "darwin") return () => {};
  const caffeinate = spawn("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" });
  caffeinate.on("error", () => {});
  return () => void caffeinate.kill();
}

async function transfer(connection: Connection, agentOptions: AgentTransferOptions): Promise<void> {
  const allowSleep = keepAwake();
  let archivePath: string | null = null;
  try {
    removeStaleExports();
    const exported = await createExportArchive(agentOptions, connection.signal);
    archivePath = exported.archivePath;
    const totalBytes = fs.statSync(archivePath).size;
    update({ phase: "uploading", totalBytes });
    const uploadId = await createRemoteUpload(connection, totalBytes, exported.unpackedBytes);
    await uploadArchive(connection, archivePath, uploadId, totalBytes);
    const warning = await applyOnServer(connection, uploadId);
    update({ phase: "done", warning });
  } catch (transferError) {
    if (connection.signal.aborted) update({ phase: "cancelled", reconnecting: false, remainingSeconds: null });
    else {
      console.error("[migration]", transferError);
      update({ phase: "failed", reconnecting: false, remainingSeconds: null, error: transferError instanceof Error ? transferError.message : String(transferError) });
    }
  } finally {
    if (archivePath) fs.rmSync(archivePath, { force: true });
    allowSleep();
  }
}

/** Checks the server, then transfers in the background. Errors of the check are thrown right away. */
export async function startWorkspacePush(serverUrl: string, token: string, agentOptions: AgentTransferOptions): Promise<PushStatus> {
  if (abortController && !["done", "failed", "cancelled"].includes(status.phase)) throw new Error(t("Es läuft bereits eine Übertragung."));
  const address = normalizeServerUrl(serverUrl);
  if (!address) throw new Error(t("Server-Adresse fehlt"));
  const previousStatus = status;
  const controller = new AbortController();
  abortController = controller;
  status = { ...idleStatus, phase: "packing" };
  const headers = { "x-harnold-language": currentLanguage(), ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const connection: Connection = { address, headers, signal: controller.signal };
  try {
    await checkServer(connection);
  } catch (checkError) {
    status = previousStatus;
    abortController = null;
    throw checkError;
  }
  void transfer(connection, agentOptions);
  return status;
}

/** Possible until the upload is complete; after that the server applies the workspace on its own. */
export function cancelWorkspacePush(): PushStatus {
  if (status.phase === "packing" || status.phase === "uploading") abortController?.abort();
  return status;
}
