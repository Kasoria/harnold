import fs from "node:fs";
import path from "node:path";
import type { Project } from "./db.ts";
import { memoryRootDirectory, type MemoryScope } from "./memory.ts";
import { environmentStore } from "./environments.ts";
import { mimeTypeOf } from "./attachments.ts";
import { t } from "./i18n.ts";

/**
 * Files in memory (PDFs, images, documents …) next to the Markdown notes. They are not indexed;
 * the agent gets a list with absolute paths and reads them with its Read tool when relevant
 * (Read handles PDFs and images natively).
 */
export type MemoryFile = { scope: MemoryScope; projectId: string | null; path: string; name: string; size: number; mimeType: string; modifiedAt: number };

const uploadDirectoryName = "dateien";
const skippedDirectoryNames = new Set([".obsidian", ".trash", ".git", "node_modules", ".harnold"]);
const isNoteFile = (fileName: string) => fileName.toLowerCase().endsWith(".md");

const rootOf = memoryRootDirectory;

function resolveInside(rootDirectory: string, relativePath: string): string {
  const resolvedRoot = path.resolve(rootDirectory);
  const absolutePath = path.resolve(resolvedRoot, relativePath.replace(/^\/+/, ""));
  if (!absolutePath.startsWith(resolvedRoot + path.sep)) throw new Error(t("Pfad liegt außerhalb des Memory-Ordners"));
  return absolutePath;
}

function walkFiles(rootDirectory: string, relativeDirectory = ""): string[] {
  let directoryEntries: fs.Dirent[];
  try {
    directoryEntries = fs.readdirSync(path.join(rootDirectory, relativeDirectory), { withFileTypes: true });
  } catch {
    return [];
  }
  return directoryEntries.flatMap((entry) => {
    if (entry.name.startsWith(".")) return [];
    const entryPath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return skippedDirectoryNames.has(entry.name) ? [] : walkFiles(rootDirectory, entryPath);
    return entry.isFile() && !isNoteFile(entry.name) ? [entryPath] : [];
  });
}

function listScope(scope: MemoryScope, project: Project | null): MemoryFile[] {
  const rootDirectory = rootOf(scope, project);
  return walkFiles(rootDirectory).map((relativePath) => {
    const fileStats = fs.statSync(path.join(rootDirectory, relativePath));
    const name = path.basename(relativePath);
    return { scope, projectId: scope === "workspace" ? null : project!.id, path: relativePath, name, size: fileStats.size, mimeType: mimeTypeOf(name, ""), modifiedAt: fileStats.mtimeMs };
  });
}

export const memoryFiles = {
  list(project: Project | null): MemoryFile[] {
    const hasEnvironment = Boolean(project && environmentStore.forProject(project.id));
    return [...(project ? listScope("project", project) : []), ...(hasEnvironment ? listScope("environment", project) : []), ...listScope("workspace", null)].sort((first, second) => second.modifiedAt - first.modifiedAt);
  },

  /** Saves into `dateien/` of the memory folder; an existing name gets a numbered suffix. */
  save(scope: MemoryScope, project: Project | null, fileName: string, bytes: Buffer): MemoryFile {
    const safeName = path.basename(fileName).replace(/[^\w.\- ()äöüÄÖÜß]+/g, "_").trim() || "datei";
    if (isNoteFile(safeName)) throw new Error(t("Markdown bitte als Notiz anlegen"));
    const rootDirectory = rootOf(scope, project);
    const extension = path.extname(safeName);
    const baseName = path.basename(safeName, extension);
    let relativePath = `${uploadDirectoryName}/${safeName}`;
    for (let suffix = 2; fs.existsSync(path.join(rootDirectory, relativePath)); suffix++) relativePath = `${uploadDirectoryName}/${baseName} (${suffix})${extension}`;
    const absolutePath = resolveInside(rootDirectory, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, bytes);
    return listScope(scope, project).find((memoryFile) => memoryFile.path === relativePath)!;
  },

  absolutePath(scope: MemoryScope, project: Project | null, relativePath: string): string {
    const absolutePath = resolveInside(rootOf(scope, project), relativePath);
    if (isNoteFile(absolutePath) || !fs.existsSync(absolutePath)) throw new Error(t("Datei nicht gefunden"));
    return absolutePath;
  },

  remove(scope: MemoryScope, project: Project | null, relativePath: string): void {
    fs.rmSync(memoryFiles.absolutePath(scope, project, relativePath));
  },

  /** For the system prompt: which files exist and where (absolute paths for the Read tool). */
  contextFor(project: Project): string {
    const files = memoryFiles.list(project).slice(0, 60);
    if (!files.length) return "";
    const lines = files.map((memoryFile) => `- [${memoryFile.scope}] ${path.join(rootOf(memoryFile.scope, memoryFile.scope === "workspace" ? null : project), memoryFile.path)}`);
    return `## Dateien im Gedächtnis (bei Bedarf mit Read öffnen – PDFs und Bilder liest Read direkt)\n${lines.join("\n")}`;
  },
};
