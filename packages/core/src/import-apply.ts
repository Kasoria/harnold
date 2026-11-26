import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { agentHomesFolderName, applyAgentHomes, createPathRewriter, repairEnvironmentClaudeDirectories, type AgentHomesManifest } from "./agent-homes.ts";

/** Folder inside the data directory where an uploaded workspace waits for the next start. */
export const importFolderName = ".import";
/** Describes the running upload; and, after the restart, how applying it went. */
export const importUploadFileName = "upload.json";
export const importResultFileName = "result.json";
/** `error` and `warning` hold technical details; the Core translates them (this file runs before settings exist). */
export type ImportResult = { uploadId: string; error?: string; warning?: string };
/** Raised when older versions could not apply a newer archive correctly. */
export const supportedArchiveFormat = 1;
/** Where the folders of the last imported workspace ended up (old path → new path). */
const pathMapFileName = "path-map.json";
export type ImportManifest = {
  formatVersion?: number;
  /** "agents": only the agents' configuration; the workspace here stays. Missing in older archives. */
  kind?: "workspace" | "agents";
  /** Only for "agents": the projects on the sending side, to find their folders here. */
  projects?: { id: string; path: string }[];
  sourceDataDirectory: string;
  /** Project folders that lived outside the data directory; copied to `external/<folder>` in the archive. */
  external: { originalPath: string; folder: string }[];
  /** Claude Code and Codex configuration and transcripts (archive folder `agent-homes`); missing in older archives. */
  agentHomes?: AgentHomesManifest | null;
};

/**
 * Runs at start-up before anything opens the database: swaps in a workspace uploaded earlier.
 * The replaced data is moved to `.import/backup-<time>` so nothing is lost.
 */
export function applyPendingImport(dataDirectory: string, projectsDirectory: string): void {
  const importDirectory = path.join(dataDirectory, importFolderName);
  const stagedDirectory = path.join(importDirectory, "staged");
  if (!fs.existsSync(path.join(importDirectory, "ready")) || !fs.existsSync(stagedDirectory)) return;
  let uploadId = "";
  let failure: string | undefined;
  let warning: string | undefined;
  try {
    uploadId = (JSON.parse(fs.readFileSync(path.join(importDirectory, importUploadFileName), "utf8")) as { id: string }).id;
  } catch {
    // staged without an upload description: nobody waits for the result
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(stagedDirectory, "manifest.json"), "utf8")) as ImportManifest;
    const backupDirectory = path.join(importDirectory, `backup-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    fs.mkdirSync(backupDirectory, { recursive: true });
    const movedPathPairs = manifest.kind === "agents" ? knownPathPairs(manifest, dataDirectory) : replaceWorkspace(manifest, stagedDirectory, backupDirectory, dataDirectory, projectsDirectory);
    warning = applyAgentConfiguration(manifest, stagedDirectory, backupDirectory, dataDirectory, movedPathPairs);
  } catch (importError) {
    console.error("Import des Workspaces fehlgeschlagen:", importError);
    failure = importError instanceof Error ? importError.message : String(importError);
  } finally {
    fs.rmSync(path.join(importDirectory, "ready"), { force: true });
    fs.rmSync(stagedDirectory, { recursive: true, force: true });
    fs.rmSync(path.join(importDirectory, "incoming.tgz"), { force: true });
    fs.rmSync(path.join(importDirectory, importUploadFileName), { force: true });
    const result: ImportResult = { uploadId, error: failure, warning };
    fs.writeFileSync(path.join(importDirectory, importResultFileName), JSON.stringify(result));
  }
}

/** Swaps in database, data and project folders. Returns where the folders went (old → new). */
function replaceWorkspace(manifest: ImportManifest, stagedDirectory: string, backupDirectory: string, dataDirectory: string, projectsDirectory: string): [string, string][] {
  const moveAside = (name: string) => {
    const existing = path.join(dataDirectory, name);
    if (fs.existsSync(existing)) fs.renameSync(existing, path.join(backupDirectory, name));
  };
  for (const databaseFile of ["harnold.db", "harnold.db-wal", "harnold.db-shm"]) moveAside(databaseFile);
  for (const entry of fs.readdirSync(stagedDirectory)) {
    if (entry === "manifest.json" || entry === "external" || entry === agentHomesFolderName) continue;
    moveAside(entry);
    fs.renameSync(path.join(stagedDirectory, entry), path.join(dataDirectory, entry));
  }
  // Project folders from outside the data directory land in the projects folder.
  const newPaths = new Map<string, string>();
  for (const external of manifest.external) {
    let target = path.join(projectsDirectory, external.folder);
    for (let suffix = 2; fs.existsSync(target); suffix += 1) target = path.join(projectsDirectory, `${external.folder}-${suffix}`);
    fs.mkdirSync(projectsDirectory, { recursive: true });
    fs.renameSync(path.join(stagedDirectory, "external", external.folder), target);
    newPaths.set(external.originalPath, target);
  }
  rewritePaths(path.join(dataDirectory, "harnold.db"), manifest.sourceDataDirectory, dataDirectory, newPaths);
  const movedPathPairs: [string, string][] = [...newPaths, [manifest.sourceDataDirectory, dataDirectory]];
  fs.writeFileSync(path.join(dataDirectory, importFolderName, pathMapFileName), JSON.stringify(movedPathPairs));
  return movedPathPairs;
}

/**
 * For a configuration-only import: where the sender's folders are here – from the last workspace import and, more
 * precisely, from the projects both sides know.
 */
function knownPathPairs(manifest: ImportManifest, dataDirectory: string): [string, string][] {
  const pairs = new Map<string, string>([[manifest.sourceDataDirectory, dataDirectory]]);
  try {
    const earlier = JSON.parse(fs.readFileSync(path.join(dataDirectory, importFolderName, pathMapFileName), "utf8")) as [string, string][];
    for (const [originalPath, newPath] of earlier) if (fs.existsSync(newPath)) pairs.set(originalPath, newPath);
  } catch {
    // no workspace imported yet
  }
  const databasePath = path.join(dataDirectory, "harnold.db");
  if (fs.existsSync(databasePath)) {
    const database = new DatabaseSync(databasePath);
    try {
      for (const project of manifest.projects ?? []) {
        const row = database.prepare("SELECT path FROM projects WHERE id = ?").get(project.id);
        if (row) pairs.set(project.path, String(row.path));
      }
    } finally {
      database.close();
    }
  }
  return [...pairs];
}

/** The agents' own configuration and transcripts; a failure here must not undo a moved workspace. Returns problems. */
function applyAgentConfiguration(manifest: ImportManifest, stagedDirectory: string, backupDirectory: string, dataDirectory: string, movedPathPairs: [string, string][]): string | undefined {
  const problems: string[] = [];
  const attempt = (work: () => void) => {
    try {
      work();
    } catch (agentHomesError) {
      problems.push(agentHomesError instanceof Error ? agentHomesError.message : String(agentHomesError));
    }
  };
  attempt(() => {
    // Chats continued here have longer transcripts than the sender's copies; those stay.
    if (manifest.agentHomes) problems.push(...applyAgentHomes(stagedDirectory, manifest.agentHomes, movedPathPairs, path.join(backupDirectory, "agent-homes"), { keepLongerTranscripts: manifest.kind === "agents" }));
  });
  attempt(() => repairEnvironmentClaudeDirectories(dataDirectory, createPathRewriter(movedPathPairs, manifest.agentHomes?.caseInsensitivePaths ?? false)));
  if (!problems.length) return undefined;
  console.error("Übernahme der Agent-Konfiguration unvollständig:", problems);
  return problems.length > 3 ? `${problems.slice(0, 3).join("; ")}; … (+${problems.length - 3})` : problems.join("; ");
}

/** Absolute paths in the database point to the old machine; map them to the new one. */
function rewritePaths(databasePath: string, sourceDataDirectory: string, dataDirectory: string, externalPaths: Map<string, string>): void {
  if (!fs.existsSync(databasePath)) return;
  const database = new DatabaseSync(databasePath);
  try {
    const mapPath = (value: string): string => {
      for (const [originalPath, newPath] of externalPaths) {
        if (value === originalPath || value.startsWith(originalPath + path.sep)) return newPath + value.slice(originalPath.length);
      }
      if (value === sourceDataDirectory || value.startsWith(sourceDataDirectory + path.sep)) return dataDirectory + value.slice(sourceDataDirectory.length);
      return value;
    };
    database.exec("BEGIN");
    for (const row of database.prepare("SELECT id, path FROM projects").all()) {
      database.prepare("UPDATE projects SET path = ? WHERE id = ?").run(mapPath(String(row.path)), String(row.id));
    }
    // Project folders, and folders added to a chat.
    for (const row of database.prepare("SELECT scope, owner_id, path FROM context_folders").all()) {
      database.prepare("UPDATE OR IGNORE context_folders SET path = ? WHERE scope = ? AND owner_id = ? AND path = ?").run(mapPath(String(row.path)), String(row.scope), String(row.owner_id), String(row.path));
    }
    for (const row of database.prepare("SELECT id, directories FROM sessions WHERE directories IS NOT NULL").all()) {
      const mapped = (JSON.parse(String(row.directories)) as string[]).map(mapPath);
      database.prepare("UPDATE sessions SET directories = ? WHERE id = ?").run(JSON.stringify(mapped), String(row.id));
    }
    for (const row of database.prepare("SELECT id, directories FROM tasks WHERE directories IS NOT NULL").all()) {
      const mapped = (JSON.parse(String(row.directories)) as string[]).map(mapPath);
      database.prepare("UPDATE tasks SET directories = ? WHERE id = ?").run(JSON.stringify(mapped), String(row.id));
    }
    // Plugin folders added in Harnold.
    const pluginFoldersRow = database.prepare("SELECT value FROM workspace_settings WHERE key = 'plugins.folders'").get();
    if (pluginFoldersRow) {
      const pluginFolders = (JSON.parse(String(pluginFoldersRow.value)) as string[]).map(mapPath);
      database.prepare("UPDATE workspace_settings SET value = ? WHERE key = 'plugins.folders'").run(JSON.stringify(pluginFolders));
    }
    // A memory folder outside the data directory (e.g. an Obsidian vault) travelled along as an external folder.
    const memoryRow = database.prepare("SELECT value FROM workspace_settings WHERE key = 'memory'").get();
    if (memoryRow) {
      const memorySettings = JSON.parse(String(memoryRow.value)) as { workspaceDirectory?: string };
      if (memorySettings.workspaceDirectory) {
        memorySettings.workspaceDirectory = mapPath(memorySettings.workspaceDirectory);
        database.prepare("UPDATE workspace_settings SET value = ? WHERE key = 'memory'").run(JSON.stringify(memorySettings));
      }
    }
    database.exec("COMMIT");
  } catch (rewriteError) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // nothing to roll back
    }
    throw rewriteError;
  } finally {
    database.close();
  }
}
