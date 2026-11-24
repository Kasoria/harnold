import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { config } from "./config.ts";
import { database } from "./db.ts";
import { memoryConfig } from "./memory.ts";
import { importFolderName, type ImportManifest } from "./import-apply.ts";
import { t } from "./i18n.ts";

const run = promisify(execFile);
/** Rebuildable or huge; the agent reinstalls them on the server. */
const skippedFolderNames = new Set(["node_modules", ".next", ".venv", "__pycache__", ".cache", ".turbo"]);
/** Data directory entries that stay on this machine (downloaded agent programs, a pending import). */
const skippedDataEntries = new Set(["harnold.db", "harnold.db-wal", "harnold.db-shm", "runtimes", importFolderName, "secret.key.lock"]);

function copyFiltered(sourcePath: string, targetPath: string): void {
  fs.cpSync(sourcePath, targetPath, {
    recursive: true,
    filter: (candidate) => !skippedFolderNames.has(path.basename(candidate)),
  });
}

const isInside = (parent: string, candidate: string) => candidate === parent || candidate.startsWith(parent + path.sep);

/** Packs databases, secrets key, memory, design systems and all project folders into one archive. Returns its path. */
async function createExportArchive(): Promise<string> {
  const stagingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "harnold-export-"));
  try {
    // A consistent snapshot of the running database.
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    database.exec(`VACUUM INTO '${path.join(stagingDirectory, "harnold.db").replace(/'/g, "''")}'`);
    for (const entry of fs.readdirSync(config.dataDirectory)) {
      if (skippedDataEntries.has(entry)) continue;
      copyFiltered(path.join(config.dataDirectory, entry), path.join(stagingDirectory, entry));
    }
    // Folders outside the data directory (projects anywhere on the disk, an external memory folder).
    const externalSources = new Set<string>();
    for (const row of database.prepare("SELECT path FROM projects").all()) externalSources.add(String(row.path));
    const memoryDirectory = memoryConfig.workspaceDirectory();
    externalSources.add(memoryDirectory);
    const manifest: ImportManifest = { sourceDataDirectory: config.dataDirectory, external: [] };
    const usedFolders = new Set<string>();
    for (const sourcePath of externalSources) {
      if (isInside(config.dataDirectory, sourcePath) || !fs.existsSync(sourcePath)) continue;
      let folder = path.basename(sourcePath) || "projekt";
      for (let suffix = 2; usedFolders.has(folder); suffix += 1) folder = `${path.basename(sourcePath)}-${suffix}`;
      usedFolders.add(folder);
      copyFiltered(sourcePath, path.join(stagingDirectory, "external", folder));
      manifest.external.push({ originalPath: sourcePath, folder });
    }
    fs.writeFileSync(path.join(stagingDirectory, "manifest.json"), JSON.stringify(manifest));
    const archivePath = path.join(os.tmpdir(), `harnold-export-${randomUUID()}.tgz`);
    await run("tar", ["-czf", archivePath, "-C", stagingDirectory, "."], { maxBuffer: 1024 * 1024 });
    return archivePath;
  } finally {
    fs.rmSync(stagingDirectory, { recursive: true, force: true });
  }
}

const normalizeServerUrl = (rawUrl: string): string => {
  let address = rawUrl.trim().replace(/\/+$/, "");
  if (address && !/^https?:\/\//i.test(address)) address = `https://${address}`;
  return address;
};

/** Sends this workspace to another Harnold core (server). The server swaps it in on its next start. */
export async function pushWorkspaceToServer(serverUrl: string, token: string): Promise<{ sizeBytes: number }> {
  const address = normalizeServerUrl(serverUrl);
  if (!address) throw new Error(t("Server-Adresse fehlt"));
  const headers = { ...(token ? { authorization: `Bearer ${token}` } : {}) };
  let check: Response;
  try {
    check = await fetch(`${address}/api/auth/check`, { headers });
  } catch {
    throw new Error(t("Keine Verbindung zu {0}", address));
  }
  if (check.status === 401) throw new Error(t("Das Zugriffstoken stimmt nicht."));
  if (!check.ok) throw new Error(t("Der Server antwortet mit Fehler {0}. Läuft dort Harnold in der aktuellen Version?", check.status));
  const archivePath = await createExportArchive();
  try {
    const sizeBytes = fs.statSync(archivePath).size;
    const response = await fetch(`${address}/api/migration/import`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/gzip", "content-length": String(sizeBytes) },
      body: Readable.toWeb(fs.createReadStream(archivePath)) as unknown as BodyInit,
      // @ts-expect-error Node needs this for streamed request bodies.
      duplex: "half",
    });
    if (!response.ok) {
      const failure = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(failure.error ?? t("Der Server antwortet mit Fehler {0}. Läuft dort Harnold in der aktuellen Version?", response.status));
    }
    return { sizeBytes };
  } finally {
    fs.rmSync(archivePath, { force: true });
  }
}

/** Server side: stores the uploaded archive, unpacks it to the staging folder and restarts to apply it. */
export async function receiveWorkspaceArchive(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!body) throw new Error(t("Kein Archiv übertragen"));
  const importDirectory = path.join(config.dataDirectory, importFolderName);
  fs.rmSync(importDirectory, { recursive: true, force: true });
  const stagedDirectory = path.join(importDirectory, "staged");
  fs.mkdirSync(stagedDirectory, { recursive: true });
  const archivePath = path.join(importDirectory, "incoming.tgz");
  await pipeline(Readable.fromWeb(body as never), fs.createWriteStream(archivePath));
  // Refuse anything that would be written outside the staging folder.
  const { stdout } = await run("tar", ["-tzf", archivePath], { maxBuffer: 256 * 1024 * 1024 });
  if (stdout.split("\n").some((entry) => path.isAbsolute(entry) || entry.split("/").includes(".."))) throw new Error(t("Ungültiges Archiv"));
  await run("tar", ["-xzf", archivePath, "-C", stagedDirectory, "--no-same-owner"]);
  if (!fs.existsSync(path.join(stagedDirectory, "harnold.db")) || !fs.existsSync(path.join(stagedDirectory, "manifest.json"))) throw new Error(t("Ungültiges Archiv"));
  fs.writeFileSync(path.join(importDirectory, "ready"), String(Date.now()));
}
