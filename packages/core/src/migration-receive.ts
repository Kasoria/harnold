/** Receiving side: takes a workspace archive in pieces, unpacks it and has it applied by the next start. */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { config } from "./config.ts";
import { importFolderName, importResultFileName, importUploadFileName, supportedArchiveFormat, type ImportManifest, type ImportResult } from "./import-apply.ts";
import { addRange, missingRanges, type ByteRange, type UploadStatus } from "./archive-transfer.ts";
import { t } from "./i18n.ts";

const run = promisify(execFile);
/** Kept compatible with 0.19 desktop apps (they upload one piece after the other); newer abilities are listed. */
export const migrationProtocol = { protocol: 2, features: ["parallel-upload", "agents-only"] };
export const maximumReceivedChunkBytes = 32 * 1024 * 1024;
/** Left free on top of archive and unpacked content, so the server keeps running. */
const reservedBytes = 500 * 1024 * 1024;
const restartDelayMilliseconds = 1500;

type Upload = { id: string; sizeBytes: number; ranges: ByteRange[] };

/** The upload being unpacked (or just done with that). */
let unpacking: { id: string; state: "unpacking" | "restarting" | "restartRequired" | "failed"; error?: string } | null = null;

/** Only a Docker server restarts the core by itself (restart: unless-stopped). */
export const restartsItself = () => process.env.HARNOLD_DEPLOYMENT === "docker";

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

/** Written in one step, so a restart never finds half a description. */
function writeUpload(upload: Upload): void {
  const filePath = path.join(importDirectory(), importUploadFileName);
  fs.writeFileSync(`${filePath}.tmp`, JSON.stringify(upload));
  fs.renameSync(`${filePath}.tmp`, filePath);
}

const currentUpload = (uploadId: string): Upload | null => {
  const upload = readJson<Upload>(importUploadFileName);
  return upload?.id === uploadId ? upload : null;
};

const receivedBytes = (upload: Upload) => upload.ranges.reduce((sum, [start, end]) => sum + end - start, 0);

/** Removes the leftovers of an upload; backups of replaced workspaces stay. */
function discardUpload(): void {
  for (const name of ["ready", "incoming.tgz", "staged", importUploadFileName]) fs.rmSync(path.join(importDirectory(), name), { recursive: true, force: true });
}

const formatGigabytes = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

export function createUpload(sizeBytes: number, unpackedBytes?: number): { uploadId: string } {
  if (unpacking?.state === "unpacking" || unpacking?.state === "restarting") throw new Error(t("Der Server verarbeitet gerade eine Übertragung. Versuche es in ein paar Minuten erneut."));
  unpacking = null;
  fs.mkdirSync(importDirectory(), { recursive: true });
  discardUpload();
  fs.rmSync(path.join(importDirectory(), importResultFileName), { force: true });
  const fileSystem = fs.statfsSync(importDirectory());
  const freeBytes = fileSystem.bavail * fileSystem.bsize;
  // An imported file does not tell its unpacked size; photos barely compress, text a lot.
  const neededBytes = sizeBytes + (unpackedBytes ?? sizeBytes * 2) + reservedBytes;
  if (freeBytes < neededBytes) throw new Error(t("Auf dem Server ist zu wenig Speicherplatz frei: {0} benötigt, {1} frei.", formatGigabytes(neededBytes), formatGigabytes(freeBytes)));
  const upload: Upload = { id: randomUUID(), sizeBytes, ranges: [] };
  fs.writeFileSync(archivePath(), "");
  writeUpload(upload);
  return { uploadId: upload.id };
}

/**
 * Writes one piece at its place; pieces may arrive in any order and more than once. Everything happens without a pause,
 * so parallel requests cannot get in each other's way.
 */
export function writeChunk(uploadId: string, offset: number, chunk: Buffer): { receivedBytes: number } | null {
  const upload = currentUpload(uploadId);
  if (!upload) return null;
  if (unpacking?.id === uploadId && unpacking.state !== "failed") return { receivedBytes: upload.sizeBytes };
  if (offset + chunk.length > upload.sizeBytes) throw new Error(t("Ungültiges Archiv"));
  const fileHandle = fs.openSync(archivePath(), "r+");
  try {
    for (let written = 0; written < chunk.length; ) written += fs.writeSync(fileHandle, chunk, written, chunk.length - written, offset + written);
  } finally {
    fs.closeSync(fileHandle);
  }
  upload.ranges = addRange(upload.ranges, [offset, offset + chunk.length]);
  writeUpload(upload);
  return { receivedBytes: receivedBytes(upload) };
}

export function readUploadStatus(uploadId: string): UploadStatus | null {
  const upload = currentUpload(uploadId);
  if (unpacking?.id === uploadId) return { state: unpacking.state, receivedBytes: upload?.sizeBytes ?? 0, error: unpacking.error };
  if (upload) return { state: "receiving", receivedBytes: receivedBytes(upload), ranges: upload.ranges };
  const result = readJson<ImportResult>(importResultFileName);
  if (result?.uploadId !== uploadId) return null;
  return {
    state: result.error ? "failed" : "applied",
    receivedBytes: 0,
    error: result.error && t("Import auf dem Server fehlgeschlagen: {0}", result.error),
    warning: result.warning && t("Claude- und Codex-Konfiguration nur teilweise übernommen: {0}", result.warning),
  };
}

/** Returns a message for the user if the content is not a usable workspace archive. */
async function unpackArchive(): Promise<string | null> {
  fs.rmSync(stagedDirectory(), { recursive: true, force: true });
  fs.mkdirSync(stagedDirectory(), { recursive: true });
  const outputLimit = { maxBuffer: 256 * 1024 * 1024 };
  // Refuse anything that would be written outside the staging folder.
  const { stdout } = await run("tar", ["-tzf", archivePath()], outputLimit);
  if (stdout.split("\n").some((entry) => path.isAbsolute(entry) || entry.split("/").includes(".."))) return t("Ungültiges Archiv");
  await run("tar", ["-xzf", archivePath(), "-C", stagedDirectory(), "--no-same-owner"], outputLimit);
  let manifest: ImportManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(stagedDirectory(), "manifest.json"), "utf8")) as ImportManifest;
  } catch {
    return t("Ungültiges Archiv");
  }
  if ((manifest.formatVersion ?? 1) > supportedArchiveFormat) return t("Die Datei stammt aus einer neueren Harnold-Version. Aktualisiere zuerst dieses Harnold.");
  if (manifest.kind !== "agents" && !fs.existsSync(path.join(stagedDirectory(), "harnold.db"))) return t("Ungültiges Archiv");
  fs.rmSync(archivePath(), { force: true });
  fs.writeFileSync(path.join(importDirectory(), "ready"), String(Date.now()));
  return null;
}

/**
 * Unpacks in the background (large workspaces take minutes, longer than a request may last). A Docker server then ends
 * the process so that it starts again and applies the import; elsewhere the user restarts Harnold.
 */
export function completeUpload(uploadId: string): UploadStatus | null {
  const upload = currentUpload(uploadId);
  if (!upload || (unpacking?.id === uploadId && unpacking.state !== "failed")) return readUploadStatus(uploadId);
  if (missingRanges(upload.ranges, upload.sizeBytes).length) return readUploadStatus(uploadId);
  unpacking = { id: uploadId, state: "unpacking" };
  const fail = (message: string) => {
    unpacking = { id: uploadId, state: "failed", error: message };
    discardUpload();
  };
  void unpackArchive().then(
    (problem) => {
      if (problem) return fail(problem);
      unpacking = { id: uploadId, state: restartsItself() ? "restarting" : "restartRequired" };
      if (restartsItself()) setTimeout(() => process.exit(0), restartDelayMilliseconds);
    },
    (unpackError: unknown) => {
      console.error("[migration]", unpackError);
      fail(t("Der Server konnte das Archiv nicht entpacken. Details stehen in seinen Logs."));
    },
  );
  return { state: "unpacking", receivedBytes: upload.sizeBytes };
}
