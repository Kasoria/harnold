import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Folder inside the data directory where an uploaded workspace waits for the next start. */
export const importFolderName = ".import";
export type ImportManifest = {
  sourceDataDirectory: string;
  /** Project folders that lived outside the data directory; copied to `external/<folder>` in the archive. */
  external: { originalPath: string; folder: string }[];
};

/**
 * Runs at start-up before anything opens the database: swaps in a workspace uploaded earlier.
 * The replaced data is moved to `.import/backup-<time>` so nothing is lost.
 */
export function applyPendingImport(dataDirectory: string, projectsDirectory: string): void {
  const importDirectory = path.join(dataDirectory, importFolderName);
  const stagedDirectory = path.join(importDirectory, "staged");
  if (!fs.existsSync(path.join(importDirectory, "ready")) || !fs.existsSync(stagedDirectory)) return;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(stagedDirectory, "manifest.json"), "utf8")) as ImportManifest;
    const backupDirectory = path.join(importDirectory, `backup-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    fs.mkdirSync(backupDirectory, { recursive: true });
    const moveAside = (name: string) => {
      const existing = path.join(dataDirectory, name);
      if (fs.existsSync(existing)) fs.renameSync(existing, path.join(backupDirectory, name));
    };
    for (const databaseFile of ["harnold.db", "harnold.db-wal", "harnold.db-shm"]) moveAside(databaseFile);
    for (const entry of fs.readdirSync(stagedDirectory)) {
      if (entry === "manifest.json" || entry === "external") continue;
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
  } catch (importError) {
    console.error("Import des Workspaces fehlgeschlagen:", importError);
  } finally {
    fs.rmSync(path.join(importDirectory, "ready"), { force: true });
    fs.rmSync(stagedDirectory, { recursive: true, force: true });
    fs.rmSync(path.join(importDirectory, "incoming.tgz"), { force: true });
  }
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
