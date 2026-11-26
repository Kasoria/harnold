/** Packs this workspace (or only the agents' configuration) into one archive. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { config } from "./config.ts";
import { database } from "./db.ts";
import { memoryConfig } from "./memory.ts";
import { importFolderName, supportedArchiveFormat, type ImportManifest } from "./import-apply.ts";
import { settingsStore } from "./settings.ts";
import { measureAgentHomes, stageAgentHomes } from "./agent-homes.ts";

const run = promisify(execFile);
/** Rebuildable or huge; the agent reinstalls them on the other side. */
const skippedFolderNames = new Set(["node_modules", ".next", ".venv", "__pycache__", ".cache", ".turbo"]);
/** Server mode: exported files wait here for their download. */
export const exportFolderName = ".exports";
/** Data directory entries that stay on this machine (downloaded agent programs, pending imports, exports). */
const skippedDataEntries = new Set(["harnold.db", "harnold.db-wal", "harnold.db-shm", "runtimes", importFolderName, exportFolderName, "secret.key.lock"]);
const temporaryNamePrefix = "harnold-export-";
const staleExportAgeMilliseconds = 6 * 60 * 60 * 1000;

export type TransferSelection = {
  /** "agents": only Claude Code / Codex configuration and transcripts; the receiving workspace stays as it is. */
  scope: "workspace" | "agents";
  /** Folders (from `listTransferFolders`) that arrive empty. */
  excludedFolders: string[];
  includeAgentConfiguration: boolean;
  includeAgentTranscripts: boolean;
};
export type TransferFolder = { path: string; name: string; sizeBytes: number };

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

/** Every folder the workspace refers to, and which of them are copied from outside the data directory. */
function collectFolders(temporaryStagingDirectory?: string): { projects: { id: string; name: string; path: string }[]; external: string[] } {
  const projects = database
    .prepare("SELECT id, name, path FROM projects")
    .all()
    .map((row) => ({ id: String(row.id), name: String(row.name), path: String(row.path) }));
  // Folders outside the data directory (projects anywhere on the disk, an external memory folder).
  const candidates = new Set<string>(projects.map((project) => project.path));
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
  const realStagingDirectory = temporaryStagingDirectory && fs.realpathSync(temporaryStagingDirectory);
  const transferable = [...candidates].filter((candidate) => {
    if (!fs.existsSync(candidate)) return false;
    const realPath = fs.realpathSync(candidate);
    return !temporaryDirectories.has(realPath) && !(realStagingDirectory && isInside(realPath, realStagingDirectory));
  });
  // Only top-level folders are copied; a folder inside another one travels with it (and is mapped by prefix).
  // A folder that contains the data directory would pull in the whole workspace, so it is left out.
  const external = transferable.filter(
    (candidate) => !isInside(config.dataDirectory, candidate) && !isInside(candidate, config.dataDirectory) && !transferable.some((other) => other !== candidate && isInside(other, candidate) && !isInside(config.dataDirectory, other) && !isInside(other, config.dataDirectory)),
  );
  return { projects, external };
}

/** Folders whose transcripts are of use on the other side. */
const movedPaths = (folders: ReturnType<typeof collectFolders>) => [config.dataDirectory, ...folders.projects.map((project) => project.path), ...folders.external];

async function measureFolder(directory: string): Promise<number> {
  let totalBytes = 0;
  const entries = await fs.promises.readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (skippedFolderNames.has(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!fs.existsSync(path.join(entryPath, "CACHEDIR.TAG"))) totalBytes += await measureFolder(entryPath);
    } else if (entry.isFile()) totalBytes += (await fs.promises.lstat(entryPath).catch(() => ({ size: 0 }))).size;
  }
  return totalBytes;
}

/** What can be deselected, with the size that would be transferred: projects and folders added from elsewhere. */
export async function listTransferFolders(): Promise<{ folders: TransferFolder[]; agentConfigurationBytes: number; agentTranscriptBytes: number }> {
  const folders = collectFolders();
  const ownProjects = folders.projects.filter((project) => project.path !== config.dataDirectory && isInside(config.dataDirectory, project.path) && fs.existsSync(project.path)).map((project) => project.path);
  const measured: TransferFolder[] = [];
  for (const folderPath of [...folders.external, ...ownProjects]) {
    const name = folders.projects.find((project) => project.path === folderPath)?.name ?? path.basename(folderPath);
    measured.push({ path: folderPath, name, sizeBytes: await measureFolder(fs.realpathSync(folderPath)) });
  }
  measured.sort((first, second) => second.sizeBytes - first.sizeBytes);
  return { folders: measured, ...(await measureAgentHomes(movedPaths(folders))) };
}

/** Copies a folder; excluded folders inside it (or itself) are created empty, along with the folders referred to in them. */
async function copyFiltered(sourcePath: string, targetPath: string, excluded: Map<string, string[]>, signal: AbortSignal): Promise<void> {
  await fs.promises.cp(sourcePath, targetPath, {
    recursive: true,
    // Relative links stay relative instead of pointing back to this machine.
    verbatimSymlinks: true,
    filter: (candidate, destination) => {
      signal.throwIfAborted();
      const referredInside = excluded.get(candidate);
      if (referredInside) {
        for (const folder of ["", ...referredInside]) fs.mkdirSync(path.join(destination, folder), { recursive: true });
        return false;
      }
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

export const temporaryArchivePath = () => path.join(os.tmpdir(), `${temporaryNamePrefix}${randomUUID()}.tgz`);

/** Databases, secrets key, memory, design systems and all project folders. */
async function stageWorkspace(stagingDirectory: string, folders: ReturnType<typeof collectFolders>, excludedFolders: string[], signal: AbortSignal): Promise<ImportManifest["external"]> {
  // A consistent snapshot of the running database.
  database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  database.exec(`VACUUM INTO '${path.join(stagingDirectory, "harnold.db").replace(/'/g, "''")}'`);
  const referred = [...folders.projects.map((project) => project.path), ...folders.external];
  // Looked up by the path as stored and as it really is on disk.
  const excluded = new Map<string, string[]>();
  for (const folder of excludedFolders.filter((candidate) => referred.includes(candidate))) {
    const inside = referred.filter((other) => other !== folder && isInside(folder, other)).map((other) => path.relative(folder, other));
    excluded.set(folder, inside);
    excluded.set(fs.realpathSync(folder), inside);
  }
  for (const entry of fs.readdirSync(config.dataDirectory)) {
    const entryPath = path.join(config.dataDirectory, entry);
    if (skippedDataEntries.has(entry) || isSkipped(entryPath)) continue;
    await copyFiltered(entryPath, path.join(stagingDirectory, entry), excluded, signal);
  }
  const external: ImportManifest["external"] = [];
  const usedFolders = new Set<string>();
  for (const sourcePath of folders.external) {
    let folder = path.basename(sourcePath) || "projekt";
    for (let suffix = 2; usedFolders.has(folder); suffix += 1) folder = `${path.basename(sourcePath)}-${suffix}`;
    usedFolders.add(folder);
    // A project folder may itself be a link: copy what it points to.
    await copyFiltered(fs.realpathSync(sourcePath), path.join(stagingDirectory, "external", folder), excluded, signal);
    external.push({ originalPath: sourcePath, folder });
  }
  return external;
}

/** Writes the archive to `archivePath` (readable by this user only) and returns the size of the unpacked content. */
export async function createExportArchive(selection: TransferSelection, archivePath: string, signal: AbortSignal): Promise<{ unpackedBytes: number }> {
  const stagingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), temporaryNamePrefix));
  try {
    const folders = collectFolders(stagingDirectory);
    const agentOptions = { includeConfiguration: selection.includeAgentConfiguration, includeTranscripts: selection.includeAgentTranscripts };
    const manifest: ImportManifest = { formatVersion: supportedArchiveFormat, kind: selection.scope, sourceDataDirectory: config.dataDirectory, external: [] };
    if (selection.scope === "workspace") manifest.external = await stageWorkspace(stagingDirectory, folders, selection.excludedFolders, signal);
    // The receiving side finds its own folders for these projects.
    else manifest.projects = folders.projects.map(({ id, path: projectPath }) => ({ id, path: projectPath }));
    manifest.agentHomes = await stageAgentHomes(stagingDirectory, movedPaths(folders), agentOptions);
    signal.throwIfAborted();
    fs.writeFileSync(path.join(stagingDirectory, "manifest.json"), JSON.stringify(manifest));
    const unpackedBytes = await directorySize(stagingDirectory);
    // The archive holds keys and logins.
    fs.writeFileSync(archivePath, "", { mode: 0o600 });
    // No macOS metadata: Linux cannot use it and would warn about every single file.
    const macOptions = process.platform === "darwin" ? ["--no-xattrs"] : [];
    await run("tar", [...macOptions, "-czf", archivePath, "-C", stagingDirectory, "."], { maxBuffer: 64 * 1024 * 1024, env: { ...process.env, COPYFILE_DISABLE: "1" }, signal });
    return { unpackedBytes };
  } catch (exportError) {
    fs.rmSync(archivePath, { force: true });
    throw exportError;
  } finally {
    await fs.promises.rm(stagingDirectory, { recursive: true, force: true });
  }
}
