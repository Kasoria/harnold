import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { config } from "./config.ts";
import { database } from "./db.ts";
import { memoryConfig } from "./memory.ts";
import { importFolderName, type ImportManifest } from "./import-apply.ts";
import { settingsStore } from "./settings.ts";
import { stageAgentHomes, type AgentTransferOptions } from "./agent-homes.ts";

const run = promisify(execFile);
/** Rebuildable or huge; the agent reinstalls them on the server. */
const skippedFolderNames = new Set(["node_modules", ".next", ".venv", "__pycache__", ".cache", ".turbo"]);
/** Data directory entries that stay on this machine (downloaded agent programs, a pending import). */
const skippedDataEntries = new Set(["harnold.db", "harnold.db-wal", "harnold.db-shm", "runtimes", importFolderName, "secret.key.lock"]);
const temporaryNamePrefix = "harnold-export-";
const staleExportAgeMilliseconds = 6 * 60 * 60 * 1000;

const isInside = (parent: string, candidate: string) => candidate === parent || candidate.startsWith(parent + path.sep);

/**
 * Left out of the transfer: dependency folders, caches marked with CACHEDIR.TAG (e.g. Rust's `target`, often many
 * gigabytes) and special files such as sockets, which cannot be copied.
 */
function isSkipped(candidate: string): boolean {
  if (skippedFolderNames.has(path.basename(candidate))) return true;
  const information = fs.lstatSync(candidate);
  if (information.isDirectory()) return fs.existsSync(path.join(candidate, "CACHEDIR.TAG"));
  return !information.isFile() && !information.isSymbolicLink();
}

async function copyFiltered(sourcePath: string, targetPath: string, signal: AbortSignal): Promise<void> {
  await fs.promises.cp(sourcePath, targetPath, {
    recursive: true,
    // Relative links stay relative instead of pointing back to this machine.
    verbatimSymlinks: true,
    filter: (candidate) => {
      signal.throwIfAborted();
      return candidate === sourcePath || !isSkipped(candidate);
    },
  });
}

async function directorySize(directory: string): Promise<number> {
  let totalBytes = 0;
  for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    totalBytes += entry.isDirectory() ? await directorySize(entryPath) : (await fs.promises.lstat(entryPath)).size;
  }
  return totalBytes;
}

/** Archives left behind when the app was quit during a transfer. */
export function removeStaleExports(): void {
  for (const entry of fs.readdirSync(os.tmpdir())) {
    if (!entry.startsWith(temporaryNamePrefix)) continue;
    const entryPath = path.join(os.tmpdir(), entry);
    try {
      if (Date.now() - fs.statSync(entryPath).mtimeMs > staleExportAgeMilliseconds) fs.rmSync(entryPath, { recursive: true, force: true });
    } catch {
      /* already gone or not ours to delete */
    }
  }
}

/**
 * Packs databases, secrets key, memory, design systems, all project folders and (optionally) the Claude Code / Codex
 * configuration and transcripts into one archive. Returns its path and the size of the unpacked content.
 */
export async function createExportArchive(agentOptions: AgentTransferOptions, signal: AbortSignal): Promise<{ archivePath: string; unpackedBytes: number }> {
  const stagingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), temporaryNamePrefix));
  const archivePath = path.join(os.tmpdir(), `${temporaryNamePrefix}${randomUUID()}.tgz`);
  try {
    // A consistent snapshot of the running database.
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    database.exec(`VACUUM INTO '${path.join(stagingDirectory, "harnold.db").replace(/'/g, "''")}'`);
    for (const entry of fs.readdirSync(config.dataDirectory)) {
      const entryPath = path.join(config.dataDirectory, entry);
      if (skippedDataEntries.has(entry) || isSkipped(entryPath)) continue;
      await copyFiltered(entryPath, path.join(stagingDirectory, entry), signal);
    }
    // Folders outside the data directory (projects anywhere on the disk, an external memory folder).
    const candidates = new Set<string>();
    for (const row of database.prepare("SELECT path FROM projects").all()) candidates.add(String(row.path));
    // Extra folders: added to a project/environment/workspace, to a chat or to a task.
    for (const row of database.prepare("SELECT path FROM context_folders").all()) candidates.add(String(row.path));
    for (const table of ["sessions", "tasks"]) {
      for (const row of database.prepare(`SELECT directories FROM ${table} WHERE directories IS NOT NULL`).all()) {
        for (const directory of JSON.parse(String(row.directories)) as string[]) candidates.add(directory);
      }
    }
    candidates.add(memoryConfig.workspaceDirectory());
    for (const pluginFolder of settingsStore.read<string[]>("plugins.folders", [])) candidates.add(pluginFolder);
    // The system's temporary folders are not part of a workspace.
    const temporaryDirectories = new Set(["/tmp", os.tmpdir()].filter((directory) => fs.existsSync(directory)).map((directory) => fs.realpathSync(directory)));
    const realStagingDirectory = fs.realpathSync(stagingDirectory);
    const transferable = [...candidates].filter((candidate) => {
      if (!fs.existsSync(candidate)) return false;
      const realPath = fs.realpathSync(candidate);
      return !temporaryDirectories.has(realPath) && !isInside(realPath, realStagingDirectory);
    });
    // Only top-level folders are copied; a folder inside another one travels with it (and is mapped by prefix).
    // A folder that contains the data directory would pull in the whole workspace, so it is left out.
    const externalSources = transferable.filter(
      (candidate) => !isInside(config.dataDirectory, candidate) && !isInside(candidate, config.dataDirectory) && !transferable.some((other) => other !== candidate && isInside(other, candidate) && !isInside(config.dataDirectory, other) && !isInside(other, config.dataDirectory)),
    );
    const manifest: ImportManifest = { sourceDataDirectory: config.dataDirectory, external: [] };
    const usedFolders = new Set<string>();
    for (const sourcePath of externalSources) {
      let folder = path.basename(sourcePath) || "projekt";
      for (let suffix = 2; usedFolders.has(folder); suffix += 1) folder = `${path.basename(sourcePath)}-${suffix}`;
      usedFolders.add(folder);
      // A project folder may itself be a link: copy what it points to.
      await copyFiltered(fs.realpathSync(sourcePath), path.join(stagingDirectory, "external", folder), signal);
      manifest.external.push({ originalPath: sourcePath, folder });
    }
    manifest.agentHomes = await stageAgentHomes(stagingDirectory, [config.dataDirectory, ...manifest.external.map((external) => external.originalPath)], agentOptions);
    signal.throwIfAborted();
    fs.writeFileSync(path.join(stagingDirectory, "manifest.json"), JSON.stringify(manifest));
    const unpackedBytes = await directorySize(stagingDirectory);
    // No macOS metadata: Linux cannot use it and would warn about every single file.
    const macOptions = process.platform === "darwin" ? ["--no-xattrs"] : [];
    await run("tar", [...macOptions, "-czf", archivePath, "-C", stagingDirectory, "."], { maxBuffer: 64 * 1024 * 1024, env: { ...process.env, COPYFILE_DISABLE: "1" }, signal });
    return { archivePath, unpackedBytes };
  } catch (exportError) {
    fs.rmSync(archivePath, { force: true });
    throw exportError;
  } finally {
    await fs.promises.rm(stagingDirectory, { recursive: true, force: true });
  }
}
