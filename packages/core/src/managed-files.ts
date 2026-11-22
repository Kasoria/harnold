import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { chatItemStore, projectStore, sessionStore, type Project } from "./db.ts";
import { environmentStore } from "./environments.ts";
import { environmentMemoryDirectory, memoryConfig, type MemoryScope } from "./memory.ts";
import { memoryFiles } from "./memory-files.ts";
import { mimeTypeOf } from "./attachments.ts";
import { resolveInsideRoot } from "./paths.ts";
import { t } from "./i18n.ts";

/**
 * All files Harnold itself creates – chat attachments, generated images, memory files – across projects,
 * with where they come from (sessions) and where they are still used (canvas, design files).
 * Project code is not included; that is the project's file tree.
 */

export type ManagedFileKind = "attachment" | "generated" | "memory";

export type ManagedFile = {
  /** `<scope>|<owner id>|<path>` – owner is the project, environment or "" (workspace). */
  id: string;
  kind: ManagedFileKind;
  scope: MemoryScope;
  ownerId: string;
  ownerName: string;
  /** Project the file belongs to (null for environment/workspace memory). */
  projectId: string | null;
  /** Relative to the project root, or to the environment/workspace memory folder. */
  path: string;
  name: string;
  size: number;
  mimeType: string;
  modifiedAt: number;
  /** Existing sessions whose conversation mentions the file. */
  sessions: { id: string; title: string }[];
  /** Other places that use it: "Canvas", design files. */
  usedIn: string[];
  /** Attachment/generated image no session and no design file refers to anymore (the canvas alone does not count – images land there automatically). */
  orphaned: boolean;
  /** Same content as other files (group key = content hash); null when unique. */
  duplicateGroup: string | null;
};

const generatedDirectory = "assets/generated";
const attachmentDirectory = "attachments";
const skippedDirectoryNames = new Set([".obsidian", ".trash", ".git", "node_modules", ".harnold"]);
const designTextExtensions = new Set([".html", ".htm", ".css", ".md", ".json", ".svg", ".js", ".jsx", ".ts", ".tsx"]);
const maxHashedBytes = 100 * 1024 * 1024;

function walkFiles(rootDirectory: string, relativeDirectory: string, include: (fileName: string) => boolean): string[] {
  let directoryEntries: fs.Dirent[];
  try {
    directoryEntries = fs.readdirSync(path.join(rootDirectory, relativeDirectory), { withFileTypes: true });
  } catch {
    return [];
  }
  return directoryEntries.flatMap((entry) => {
    if (entry.name.startsWith(".")) return [];
    const entryPath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return skippedDirectoryNames.has(entry.name) ? [] : walkFiles(rootDirectory, entryPath, include);
    return entry.isFile() && include(entry.name) ? [entryPath] : [];
  });
}

const isNotNote = (fileName: string) => !fileName.toLowerCase().endsWith(".md");

function rootDirectoryOf(scope: MemoryScope, ownerId: string): string {
  if (scope === "workspace") return memoryConfig.workspaceDirectory();
  if (scope === "environment") return environmentMemoryDirectory(ownerId);
  const project = projectStore.get(ownerId);
  if (!project) throw new Error(t("Projekt nicht gefunden"));
  return project.path;
}

/** Absolute path of a managed file id; refuses anything outside its root. */
export function resolveManagedFile(fileId: string): string {
  const [scope, ownerId, relativePath] = fileId.split("|");
  if (!["project", "environment", "workspace"].includes(scope) || !relativePath) throw new Error(t("Ungültige Datei"));
  const absolutePath = resolveInsideRoot(rootDirectoryOf(scope as MemoryScope, ownerId), relativePath, new Error(t("Pfad liegt außerhalb")));
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) throw new Error(t("Datei nicht gefunden"));
  return absolutePath;
}

type RawFile = Omit<ManagedFile, "sessions" | "usedIn" | "orphaned" | "duplicateGroup">;

function describeFile(scope: MemoryScope, ownerId: string, ownerName: string, projectId: string | null, rootDirectory: string, relativePath: string, kind: ManagedFileKind): RawFile | null {
  try {
    const fileStats = fs.statSync(path.join(rootDirectory, relativePath));
    const name = path.basename(relativePath);
    return { id: `${scope}|${ownerId}|${relativePath}`, kind, scope, ownerId, ownerName, projectId, path: relativePath, name, size: fileStats.size, mimeType: mimeTypeOf(name, ""), modifiedAt: fileStats.mtimeMs };
  } catch {
    return null;
  }
}

function projectFiles(project: Project): RawFile[] {
  if (!fs.existsSync(project.path)) return [];
  const describe = (relativePath: string, kind: ManagedFileKind) => describeFile("project", project.id, project.name, project.id, project.path, relativePath, kind);
  return [
    ...walkFiles(project.path, attachmentDirectory, () => true).map((relativePath) => describe(relativePath, "attachment")),
    ...walkFiles(project.path, generatedDirectory, () => true).map((relativePath) => describe(relativePath, "generated")),
    ...walkFiles(project.path, "memory", isNotNote).map((relativePath) => describe(relativePath, "memory")),
  ].filter((file): file is RawFile => file !== null);
}

/** Per session the full conversation as one searchable text. */
function conversationTexts(projectId: string): { id: string; title: string; text: string }[] {
  return sessionStore.listByProject(projectId).map((session) => ({ id: session.id, title: session.title, text: JSON.stringify(chatItemStore.list(session.id)) }));
}

/** Canvas + text files under design/ – an image used there is not orphaned. */
function projectUsageTexts(project: Project): { label: string; text: string }[] {
  const usageTexts: { label: string; text: string }[] = [];
  const canvasPath = path.join(project.path, "design", "canvas.json");
  if (fs.existsSync(canvasPath)) usageTexts.push({ label: canvasLabel, text: fs.readFileSync(canvasPath, "utf8") });
  for (const relativePath of walkFiles(project.path, "design", (fileName) => designTextExtensions.has(path.extname(fileName).toLowerCase()))) {
    if (relativePath === "design/canvas.json") continue;
    try {
      usageTexts.push({ label: relativePath, text: fs.readFileSync(path.join(project.path, relativePath), "utf8").slice(0, 2_000_000) });
    } catch {
      /* unreadable – skip */
    }
  }
  return usageTexts;
}

function contentHash(absolutePath: string): string {
  return createHash("sha1").update(fs.readFileSync(absolutePath)).digest("hex").slice(0, 16);
}

/** Marks files with identical content; only files of equal size are hashed. */
function duplicateGroups(files: RawFile[]): Map<string, string> {
  const filesBySize = new Map<number, RawFile[]>();
  for (const file of files) if (file.size > 0 && file.size <= maxHashedBytes) filesBySize.set(file.size, [...(filesBySize.get(file.size) ?? []), file]);
  const groupByFileId = new Map<string, string>();
  for (const sameSizeFiles of filesBySize.values()) {
    if (sameSizeFiles.length < 2) continue;
    const filesByHash = new Map<string, RawFile[]>();
    for (const file of sameSizeFiles) {
      try {
        const hash = contentHash(resolveManagedFile(file.id));
        filesByHash.set(hash, [...(filesByHash.get(hash) ?? []), file]);
      } catch {
        /* vanished – skip */
      }
    }
    for (const [hash, sameContentFiles] of filesByHash) if (sameContentFiles.length > 1) for (const file of sameContentFiles) groupByFileId.set(file.id, hash);
  }
  return groupByFileId;
}

export const managedFiles = {
  list(): ManagedFile[] {
    const files: ManagedFile[] = [];
    for (const project of projectStore.list()) {
      const rawFiles = projectFiles(project);
      if (!rawFiles.length) continue;
      const conversations = conversationTexts(project.id);
      const usageTexts = projectUsageTexts(project);
      for (const rawFile of rawFiles) {
        const sessions = conversations.filter((conversation) => conversation.text.includes(rawFile.path)).map(({ id, title }) => ({ id, title }));
        const usedIn = usageTexts.filter((usageText) => usageText.text.includes(rawFile.path) || usageText.text.includes(rawFile.name)).map((usageText) => usageText.label);
        files.push({ ...rawFile, sessions, usedIn, orphaned: rawFile.kind !== "memory" && !sessions.length && !usedOutsideCanvas(usedIn), duplicateGroup: null });
      }
    }
    for (const environment of environmentStore.list()) {
      const rootDirectory = environmentMemoryDirectory(environment.id);
      for (const relativePath of walkFiles(rootDirectory, "", isNotNote)) {
        const rawFile = describeFile("environment", environment.id, environment.name, null, rootDirectory, relativePath, "memory");
        if (rawFile) files.push({ ...rawFile, sessions: [], usedIn: [], orphaned: false, duplicateGroup: null });
      }
    }
    const workspaceDirectory = memoryConfig.workspaceDirectory();
    for (const relativePath of walkFiles(workspaceDirectory, "", isNotNote)) {
      const rawFile = describeFile("workspace", "", "Workspace", null, workspaceDirectory, relativePath, "memory");
      if (rawFile) files.push({ ...rawFile, sessions: [], usedIn: [], orphaned: false, duplicateGroup: null });
    }
    const groupByFileId = duplicateGroups(files);
    return files.map((file) => ({ ...file, duplicateGroup: groupByFileId.get(file.id) ?? null })).sort((first, second) => second.modifiedAt - first.modifiedAt);
  },

  remove(fileIds: string[]): number {
    let removedCount = 0;
    for (const fileId of fileIds) {
      try {
        fs.rmSync(resolveManagedFile(fileId));
        removedCount++;
      } catch {
        /* already gone */
      }
    }
    return removedCount;
  },

  /** Copies a file into memory (project, environment or workspace) as context. */
  copyToMemory(fileId: string, scope: MemoryScope, project: Project | null) {
    const absolutePath = resolveManagedFile(fileId);
    const fileName = path.basename(absolutePath).replace(/^\d{8}-\d{6}-/, ""); // drop the attachment timestamp
    return memoryFiles.save(scope, scope === "workspace" ? null : project, fileName, fs.readFileSync(absolutePath));
  },

  /**
   * Files that only this conversation (session + its edited versions) refers to: attachments and generated images,
   * not used on the canvas, in design files or by another session. Candidates for "delete with the session".
   */
  exclusiveToConversation(sessionId: string): ManagedFile[] {
    const session = sessionStore.get(sessionId);
    if (!session) return [];
    const conversationIds = new Set([sessionId, ...collectForkIds(sessionId)]);
    return managedFiles
      .list()
      .filter(
        (file) =>
          file.projectId === session.projectId &&
          file.kind !== "memory" &&
          !usedOutsideCanvas(file.usedIn) &&
          file.sessions.length > 0 &&
          file.sessions.every((fileSession) => conversationIds.has(fileSession.id)),
      );
  },
};

const canvasLabel = "Canvas";
const usedOutsideCanvas = (usedIn: string[]) => usedIn.some((label) => label !== canvasLabel);

function collectForkIds(sessionId: string): string[] {
  return sessionStore.listForks(sessionId).flatMap((fork) => [fork.id, ...collectForkIds(fork.id)]);
}
