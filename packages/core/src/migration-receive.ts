/** Server core: receives a workspace archive in pieces, unpacks it and restarts to swap it in. */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { config } from "./config.ts";
import { importFolderName, importResultFileName, importUploadFileName, type ImportResult } from "./import-apply.ts";
import { t } from "./i18n.ts";

const run = promisify(execFile);
export const migrationProtocolVersion = 2;
export const maximumReceivedChunkBytes = 32 * 1024 * 1024;
/** Left free on top of archive and unpacked content, so the server keeps running. */
const reservedBytes = 500 * 1024 * 1024;
const restartDelayMilliseconds = 1500;

export type UploadState = "receiving" | "unpacking" | "restarting" | "applied" | "failed";
export type UploadStatus = { state: UploadState; receivedBytes: number; error?: string; warning?: string };
type Upload = { id: string; sizeBytes: number };

/** The upload being unpacked (or that just failed to). */
let unpacking: { id: string; state: "unpacking" | "restarting" | "failed"; error?: string } | null = null;

const importDirectory = () => path.join(config.dataDirectory, importFolderName);
const archivePath = () => path.join(importDirectory(), "incoming.tgz");
const stagedDirectory = () => path.join(importDirectory(), "staged");

const readJson = <Value>(fileName: string): Value | null => {
  try {
    return JSON.parse(fs.readFileSync(path.join(importDirectory(), fileName), "utf8")) as Value;
  } catch {
    return null;
  }
};

const currentUpload = (uploadId: string): Upload | null => {
  const upload = readJson<Upload>(importUploadFileName);
  return upload?.id === uploadId ? upload : null;
};

const receivedBytes = (): number => (fs.existsSync(archivePath()) ? fs.statSync(archivePath()).size : 0);

/** Removes the leftovers of an upload; backups of replaced workspaces stay. */
function discardUpload(): void {
  for (const name of ["ready", "incoming.tgz", "staged", importUploadFileName]) fs.rmSync(path.join(importDirectory(), name), { recursive: true, force: true });
}

const formatGigabytes = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

export function createUpload(sizeBytes: number, unpackedBytes: number): { uploadId: string; receivedBytes: number } {
  if (unpacking && unpacking.state !== "failed") throw new Error(t("Der Server verarbeitet gerade eine Übertragung. Versuche es in ein paar Minuten erneut."));
  unpacking = null;
  fs.mkdirSync(importDirectory(), { recursive: true });
  discardUpload();
  fs.rmSync(path.join(importDirectory(), importResultFileName), { force: true });
  const fileSystem = fs.statfsSync(importDirectory());
  const freeBytes = fileSystem.bavail * fileSystem.bsize;
  const neededBytes = sizeBytes + unpackedBytes + reservedBytes;
  if (freeBytes < neededBytes) throw new Error(t("Auf dem Server ist zu wenig Speicherplatz frei: {0} benötigt, {1} frei.", formatGigabytes(neededBytes), formatGigabytes(freeBytes)));
  const upload: Upload = { id: randomUUID(), sizeBytes };
  fs.writeFileSync(archivePath(), "");
  fs.writeFileSync(path.join(importDirectory(), importUploadFileName), JSON.stringify(upload));
  return { uploadId: upload.id, receivedBytes: 0 };
}

/**
 * Appends one piece. `accepted: false` means the offset does not match what is already here; the sender continues at
 * `receivedBytes`. Check and write happen without a pause in between, so a repeated request cannot write twice.
 */
export function appendChunk(uploadId: string, offset: number, chunk: Buffer): { accepted: boolean; receivedBytes: number } | null {
  const upload = currentUpload(uploadId);
  if (!upload) return null;
  const currentBytes = receivedBytes();
  if (unpacking?.id === uploadId || offset !== currentBytes) return { accepted: false, receivedBytes: currentBytes };
  if (currentBytes + chunk.length > upload.sizeBytes) throw new Error(t("Ungültiges Archiv"));
  const fileHandle = fs.openSync(archivePath(), "r+");
  try {
    for (let written = 0; written < chunk.length; ) written += fs.writeSync(fileHandle, chunk, written, chunk.length - written, offset + written);
  } catch (writeError) {
    fs.ftruncateSync(fileHandle, currentBytes);
    throw writeError;
  } finally {
    fs.closeSync(fileHandle);
  }
  return { accepted: true, receivedBytes: currentBytes + chunk.length };
}

export function readUploadStatus(uploadId: string): UploadStatus | null {
  const upload = currentUpload(uploadId);
  if (unpacking?.id === uploadId) return { state: unpacking.state, receivedBytes: upload?.sizeBytes ?? 0, error: unpacking.error };
  if (upload) return { state: "receiving", receivedBytes: receivedBytes() };
  const result = readJson<ImportResult>(importResultFileName);
  if (result?.uploadId !== uploadId) return null;
  return {
    state: result.error ? "failed" : "applied",
    receivedBytes: 0,
    error: result.error && t("Import auf dem Server fehlgeschlagen: {0}", result.error),
    warning: result.warning && t("Claude- und Codex-Konfiguration nicht übernommen: {0}", result.warning),
  };
}

async function unpackArchive(): Promise<void> {
  fs.rmSync(stagedDirectory(), { recursive: true, force: true });
  fs.mkdirSync(stagedDirectory(), { recursive: true });
  const outputLimit = { maxBuffer: 256 * 1024 * 1024 };
  // Refuse anything that would be written outside the staging folder.
  const { stdout } = await run("tar", ["-tzf", archivePath()], outputLimit);
  if (stdout.split("\n").some((entry) => path.isAbsolute(entry) || entry.split("/").includes(".."))) throw new Error(t("Ungültiges Archiv"));
  await run("tar", ["-xzf", archivePath(), "-C", stagedDirectory(), "--no-same-owner"], outputLimit);
  if (!fs.existsSync(path.join(stagedDirectory(), "harnold.db")) || !fs.existsSync(path.join(stagedDirectory(), "manifest.json"))) throw new Error(t("Ungültiges Archiv"));
  fs.rmSync(archivePath(), { force: true });
  fs.writeFileSync(path.join(importDirectory(), "ready"), String(Date.now()));
}

/**
 * Unpacks in the background (large workspaces take minutes, longer than a request may last) and then ends the process;
 * Docker (restart: unless-stopped) starts the core again, which applies the import first.
 */
export function completeUpload(uploadId: string): UploadStatus | null {
  const upload = currentUpload(uploadId);
  if (!upload || (unpacking?.id === uploadId && unpacking.state !== "failed")) return readUploadStatus(uploadId);
  const currentBytes = receivedBytes();
  if (currentBytes !== upload.sizeBytes) return { state: "receiving", receivedBytes: currentBytes };
  unpacking = { id: uploadId, state: "unpacking" };
  void unpackArchive().then(
    () => {
      unpacking = { id: uploadId, state: "restarting" };
      setTimeout(() => process.exit(0), restartDelayMilliseconds);
    },
    (unpackError: unknown) => {
      console.error("[migration]", unpackError);
      unpacking = { id: uploadId, state: "failed", error: t("Der Server konnte das Archiv nicht entpacken. Details stehen in seinen Logs.") };
      discardUpload();
    },
  );
  return { state: "unpacking", receivedBytes: currentBytes };
}
