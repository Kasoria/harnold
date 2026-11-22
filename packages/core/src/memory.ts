import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { config } from "./config.ts";
import { database, projectStore, type Project } from "./db.ts";
import { eventHub } from "./events.ts";
import { settingsStore } from "./settings.ts";
import { voiceConfig } from "./voice.ts";
import { environmentStore } from "./environments.ts";
import { t } from "./i18n.ts";

/**
 * Memory = Markdown files (the truth) + a rebuildable SQLite index (FTS5, optional vectors).
 * Workspace memory: one folder per workspace (can be an external Obsidian vault).
 * Environment memory: `<data dir>/environment-memory/<environment id>/`, shared by all projects of that environment.
 * Project memory: `<project>/memory/` plus `HARNOLD.md` in the project root.
 */

export type MemoryScope = "workspace" | "environment" | "project";
export type MemoryNoteRef = { scope: MemoryScope; projectId: string | null; path: string };
export type MemoryNoteSummary = MemoryNoteRef & { title: string; modifiedAt: number };
export type MemorySearchHit = MemoryNoteSummary & { snippet: string; score: number };

export const memorySettingsSchema = z.object({
  /** Empty = `<data dir>/memory`. */
  workspaceDirectory: z.string(),
  embeddingProvider: z.enum(["off", "openai", "ollama"]),
  embeddingModel: z.string(),
  ollamaUrl: z.string(),
});
export type MemorySettings = z.infer<typeof memorySettingsSchema>;

const defaultMemorySettings: MemorySettings = { workspaceDirectory: "", embeddingProvider: "off", embeddingModel: "", ollamaUrl: "http://127.0.0.1:11434" };
const defaultEmbeddingModels = { openai: "text-embedding-3-small", ollama: "nomic-embed-text" } as const;

const ignoredDirectoryNames = new Set([".obsidian", ".trash", ".git", "node_modules", ".harnold"]);
const maxIndexedCharacters = 200_000;
const maxEmbeddedCharacters = 8_000;

database.exec(`
  CREATE TABLE IF NOT EXISTS memory_notes (
    id INTEGER PRIMARY KEY,
    scope TEXT NOT NULL,
    project_id TEXT NOT NULL DEFAULT '',
    path TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    modified_at REAL NOT NULL,
    content_hash TEXT NOT NULL,
    embedding BLOB,
    embedding_model TEXT,
    UNIQUE (scope, project_id, path)
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(title, body, tokenize = "unicode61 remove_diacritics 2");
`);

// --- Settings ---

export const memoryConfig = {
  read(): MemorySettings {
    return { ...defaultMemorySettings, ...settingsStore.read<Partial<MemorySettings>>("memory", {}) };
  },
  save(memorySettings: MemorySettings, openaiApiKey?: string): void {
    const previousDirectory = memoryConfig.workspaceDirectory();
    settingsStore.write("memory", memorySettings);
    if (openaiApiKey) settingsStore.writeSecrets("memory.secrets", { openaiApiKey });
    if (memoryConfig.workspaceDirectory() !== previousDirectory) {
      database.prepare("DELETE FROM memory_fts WHERE rowid IN (SELECT id FROM memory_notes WHERE scope = 'workspace')").run();
      database.prepare("DELETE FROM memory_notes WHERE scope = 'workspace'").run();
      watchWorkspaceMemory();
    }
    void memoryIndex.reindexAll();
  },
  /** Own key, else the OpenAI key from the voice settings. */
  openaiApiKey(): string | undefined {
    return settingsStore.readSecrets("memory.secrets").openaiApiKey || voiceConfig.secrets().openaiApiKey || undefined;
  },
  present() {
    return { ...memoryConfig.read(), resolvedWorkspaceDirectory: memoryConfig.workspaceDirectory(), openaiKeySet: Boolean(memoryConfig.openaiApiKey()) };
  },
  workspaceDirectory(): string {
    const configuredDirectory = memoryConfig.read().workspaceDirectory.trim();
    return configuredDirectory ? path.resolve(configuredDirectory.replace(/^~(?=$|\/)/, process.env.HOME ?? "~")) : path.join(config.dataDirectory, "memory");
  },
};

// --- Paths ---

/** One memory folder; `ownerKey` is the index key (project id, environment id or "" for the workspace). */
type MemoryRoot = { scope: MemoryScope; ownerKey: string; directory: string; project: Project | null };

const environmentMemoryBaseDirectory = path.join(config.dataDirectory, "environment-memory");
export const environmentMemoryDirectory = (environmentId: string) => path.join(environmentMemoryBaseDirectory, environmentId);
const environmentRoot = (environmentId: string): MemoryRoot => ({ scope: "environment", ownerKey: environmentId, directory: environmentMemoryDirectory(environmentId), project: null });

/** Environment memory is addressed via a project; it resolves to that project's environment. */
function memoryRootFor(scope: MemoryScope, project: Project | null): MemoryRoot {
  if (scope === "workspace") return { scope, ownerKey: "", directory: memoryConfig.workspaceDirectory(), project: null };
  if (!project) throw new Error(t("Projekt fehlt"));
  if (scope === "environment") {
    const environment = environmentStore.forProject(project.id);
    if (!environment) throw new Error(t("Projekt gehört zu keiner Umgebung"));
    return { ...environmentRoot(environment.id), project };
  }
  return { scope, ownerKey: project.id, directory: path.join(project.path, "memory"), project };
}

export const memoryRootDirectory = (scope: MemoryScope, project: Project | null) => memoryRootFor(scope, project).directory;
const rootDirectoryOf = memoryRootDirectory;
const environmentKeyOf = (projectId: string | null) => (projectId ? (environmentStore.forProject(projectId)?.id ?? "") : "");

/** Normalizes a note path (adds .md) and refuses anything outside its memory root. */
export function resolveNotePath(scope: MemoryScope, project: Project | null, notePath: string): { absolutePath: string; relativePath: string } {
  let relativePath = notePath.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (scope === "project" && relativePath === "HARNOLD.md" && project) return { absolutePath: path.join(project.path, "HARNOLD.md"), relativePath };
  if (!relativePath) throw new Error(t("Pfad fehlt"));
  if (!relativePath.toLowerCase().endsWith(".md")) relativePath += ".md";
  const rootDirectory = path.resolve(rootDirectoryOf(scope, project));
  const absolutePath = path.resolve(rootDirectory, relativePath);
  if (!absolutePath.startsWith(rootDirectory + path.sep)) throw new Error(t("Pfad liegt außerhalb des Memory-Ordners"));
  return { absolutePath, relativePath: path.relative(rootDirectory, absolutePath).split(path.sep).join("/") };
}

function listMarkdownFiles(rootDirectory: string, relativeDirectory = ""): string[] {
  let directoryEntries: fs.Dirent[];
  try {
    directoryEntries = fs.readdirSync(path.join(rootDirectory, relativeDirectory), { withFileTypes: true });
  } catch {
    return [];
  }
  return directoryEntries.flatMap((entry) => {
    const entryPath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return ignoredDirectoryNames.has(entry.name) || entry.name.startsWith(".") ? [] : listMarkdownFiles(rootDirectory, entryPath);
    return entry.isFile() && entry.name.toLowerCase().endsWith(".md") ? [entryPath] : [];
  });
}

function titleOf(notePath: string, body: string): string {
  const withoutFrontmatter = body.replace(/^---\n[\s\S]*?\n---\n?/, "");
  const heading = withoutFrontmatter.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || path.basename(notePath, ".md");
}

// --- Embeddings ---

async function embed(text: string): Promise<{ vector: Float32Array; model: string } | null> {
  const memorySettings = memoryConfig.read();
  if (memorySettings.embeddingProvider === "off") return null;
  const model = memorySettings.embeddingModel || defaultEmbeddingModels[memorySettings.embeddingProvider];
  const input = text.slice(0, maxEmbeddedCharacters);
  if (memorySettings.embeddingProvider === "openai") {
    const apiKey = memoryConfig.openaiApiKey();
    if (!apiKey) return null;
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model, input }),
    });
    if (!response.ok) throw new Error(t("OpenAI Embeddings: {0} {1}", response.status, await response.text()));
    const responseBody = (await response.json()) as { data: { embedding: number[] }[] };
    return { vector: Float32Array.from(responseBody.data[0].embedding), model };
  }
  const response = await fetch(`${memorySettings.ollamaUrl.replace(/\/+$/, "")}/api/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, input }),
  });
  if (!response.ok) throw new Error(t("Ollama Embeddings: {0} {1}", response.status, await response.text()));
  const responseBody = (await response.json()) as { embeddings: number[][] };
  return { vector: Float32Array.from(responseBody.embeddings[0]), model };
}

function cosineSimilarity(first: Float32Array, second: Float32Array): number {
  if (first.length !== second.length) return 0;
  let dotProduct = 0;
  let firstNorm = 0;
  let secondNorm = 0;
  for (let index = 0; index < first.length; index++) {
    dotProduct += first[index] * second[index];
    firstNorm += first[index] * first[index];
    secondNorm += second[index] * second[index];
  }
  return firstNorm && secondNorm ? dotProduct / Math.sqrt(firstNorm * secondNorm) : 0;
}

const blobToVector = (blob: Uint8Array) => new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));

// --- Index ---

type IndexedRow = { id: number; path: string; modified_at: number; content_hash: string; embedding_model: string | null };

let embeddingWarningShown = false;

async function indexRoot(memoryRoot: MemoryRoot): Promise<boolean> {
  const { scope, project } = memoryRoot;
  const projectKey = memoryRoot.ownerKey;
  const rootDirectory = memoryRoot.directory;
  const notePaths = listMarkdownFiles(rootDirectory);
  if (scope === "project" && project && fs.existsSync(path.join(project.path, "HARNOLD.md"))) notePaths.push("HARNOLD.md");

  const indexedRows = database
    .prepare("SELECT id, path, modified_at, content_hash, embedding_model FROM memory_notes WHERE scope = ? AND project_id = ?")
    .all(scope, projectKey) as unknown as IndexedRow[];
  const indexedRowsByPath = new Map(indexedRows.map((indexedRow) => [indexedRow.path, indexedRow]));
  const memorySettings = memoryConfig.read();
  const wantedEmbeddingModel =
    memorySettings.embeddingProvider === "off" ? null : memorySettings.embeddingModel || defaultEmbeddingModels[memorySettings.embeddingProvider];
  let changed = false;

  for (const notePath of notePaths) {
    const absolutePath = notePath === "HARNOLD.md" && scope === "project" ? path.join(project!.path, notePath) : path.join(rootDirectory, notePath);
    let fileStats: fs.Stats;
    try {
      fileStats = fs.statSync(absolutePath);
    } catch {
      continue;
    }
    const indexedRow = indexedRowsByPath.get(notePath);
    indexedRowsByPath.delete(notePath);
    const embeddingOutdated = Boolean(wantedEmbeddingModel) && indexedRow?.embedding_model !== wantedEmbeddingModel;
    if (indexedRow && indexedRow.modified_at === fileStats.mtimeMs && !embeddingOutdated) continue;

    const body = fs.readFileSync(absolutePath, "utf8").slice(0, maxIndexedCharacters);
    const contentHash = createHash("sha1").update(body).digest("hex");
    if (indexedRow && indexedRow.content_hash === contentHash && !embeddingOutdated) {
      database.prepare("UPDATE memory_notes SET modified_at = ? WHERE id = ?").run(fileStats.mtimeMs, indexedRow.id);
      continue;
    }
    const title = titleOf(notePath, body);
    let embedding: { vector: Float32Array; model: string } | null = null;
    try {
      embedding = await embed(`${title}\n\n${body}`);
    } catch (embeddingError) {
      if (!embeddingWarningShown) console.warn("[memory] Embedding fehlgeschlagen:", embeddingError instanceof Error ? embeddingError.message : embeddingError);
      embeddingWarningShown = true;
    }
    const embeddingBlob = embedding ? new Uint8Array(embedding.vector.buffer) : null;
    const savedRow = database
      .prepare(
        `INSERT INTO memory_notes (scope, project_id, path, title, body, modified_at, content_hash, embedding, embedding_model)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (scope, project_id, path) DO UPDATE SET title = excluded.title, body = excluded.body, modified_at = excluded.modified_at,
           content_hash = excluded.content_hash, embedding = excluded.embedding, embedding_model = excluded.embedding_model
         RETURNING id`,
      )
      .get(scope, projectKey, notePath, title, body, fileStats.mtimeMs, contentHash, embeddingBlob, embedding?.model ?? null) as { id: number };
    database.prepare("DELETE FROM memory_fts WHERE rowid = ?").run(savedRow.id);
    database.prepare("INSERT INTO memory_fts (rowid, title, body) VALUES (?, ?, ?)").run(savedRow.id, title, body);
    changed = true;
  }

  for (const removedRow of indexedRowsByPath.values()) {
    database.prepare("DELETE FROM memory_fts WHERE rowid = ?").run(removedRow.id);
    database.prepare("DELETE FROM memory_notes WHERE id = ?").run(removedRow.id);
    changed = true;
  }
  return changed;
}

/** Serializes reindex runs per root so watchers and writes don't race. */
const reindexQueue = new Map<string, Promise<void>>();

function queueReindexRoot(memoryRoot: MemoryRoot): Promise<void> {
  const queueKey = `${memoryRoot.scope}:${memoryRoot.ownerKey}`;
  const previousRun = reindexQueue.get(queueKey) ?? Promise.resolve();
  const nextRun = previousRun
    .then(() => indexRoot(memoryRoot))
    .then((changed) => {
      if (changed) eventHub.publish({ type: "memory_changed", projectId: memoryRoot.scope === "project" ? memoryRoot.ownerKey : null });
    })
    .catch((indexError) => console.warn("[memory] Index-Fehler:", indexError));
  reindexQueue.set(queueKey, nextRun);
  return nextRun;
}

const queueReindex = (scope: MemoryScope, project: Project | null) => queueReindexRoot(memoryRootFor(scope, project));

/** Drops index rows of deleted environments. */
function purgeDeletedEnvironments(): void {
  const environmentIds = environmentStore.list().map((environment) => environment.id);
  const placeholders = environmentIds.map(() => "?").join(", ");
  const staleCondition = `scope = 'environment'${environmentIds.length ? ` AND project_id NOT IN (${placeholders})` : ""}`;
  database.prepare(`DELETE FROM memory_fts WHERE rowid IN (SELECT id FROM memory_notes WHERE ${staleCondition})`).run(...environmentIds);
  database.prepare(`DELETE FROM memory_notes WHERE ${staleCondition}`).run(...environmentIds);
}

/** SQL condition + parameters for a scope filter, seen from one project. */
function scopeCondition(scopeFilter: MemoryScope | "all", projectId: string | null): { sql: string; parameters: string[] } {
  const projectKey = projectId ?? "";
  const environmentKey = environmentKeyOf(projectId);
  if (scopeFilter === "workspace") return { sql: "n.scope = 'workspace'", parameters: [] };
  if (scopeFilter === "project") return { sql: "(n.scope = 'project' AND n.project_id = ?)", parameters: [projectKey] };
  if (scopeFilter === "environment") return { sql: "(n.scope = 'environment' AND n.project_id = ?)", parameters: [environmentKey] };
  return { sql: "(n.scope = 'workspace' OR (n.scope = 'project' AND n.project_id = ?) OR (n.scope = 'environment' AND n.project_id = ?))", parameters: [projectKey, environmentKey] };
}

type NoteRow = { id: number; scope: MemoryScope; project_id: string; path: string; title: string; modified_at: number; embedding: Uint8Array | null; snippet?: string; rank?: number };

const toSummary = (noteRow: NoteRow): MemoryNoteSummary => ({
  scope: noteRow.scope,
  projectId: noteRow.scope === "project" ? noteRow.project_id : null,
  path: noteRow.path,
  title: noteRow.title,
  modifiedAt: noteRow.modified_at,
});

/** Turns free text into a forgiving FTS5 query (prefix match per word, OR-combined). */
function toFtsQuery(searchText: string): string {
  const words = searchText.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  return words.map((word) => `"${word}"*`).join(" OR ");
}

export const memoryIndex = {
  reindex: queueReindex,

  async reindexAll(): Promise<void> {
    purgeDeletedEnvironments();
    await Promise.all([
      queueReindex("workspace", null),
      ...environmentStore.list().map((environment) => queueReindexRoot(environmentRoot(environment.id))),
      ...projectStore.list().map((project) => queueReindex("project", project)),
    ]);
  },

  list(projectId: string | null): MemoryNoteSummary[] {
    const condition = scopeCondition("all", projectId);
    const noteRows = database
      .prepare(`SELECT n.id, n.scope, n.project_id, n.path, n.title, n.modified_at FROM memory_notes n WHERE ${condition.sql} ORDER BY n.modified_at DESC`)
      .all(...condition.parameters) as unknown as NoteRow[];
    return noteRows.map(toSummary);
  },

  /** Hybrid search: FTS5 (bm25) + optional vector similarity, fused by reciprocal rank. */
  async search(searchText: string, projectId: string | null, scopeFilter: MemoryScope | "all" = "all", limit = 8): Promise<MemorySearchHit[]> {
    const { sql: scopeSql, parameters: scopeParameters } = scopeCondition(scopeFilter, projectId);
    const ftsQuery = toFtsQuery(searchText);
    const fusedScores = new Map<number, { noteRow: NoteRow; score: number; snippet: string }>();
    const fusionConstant = 60;

    if (ftsQuery) {
      const ftsRows = database
        .prepare(
          `SELECT n.id, n.scope, n.project_id, n.path, n.title, n.modified_at, snippet(memory_fts, 1, '**', '**', '…', 24) AS snippet, bm25(memory_fts, 5.0, 1.0) AS rank
           FROM memory_fts JOIN memory_notes n ON n.id = memory_fts.rowid
           WHERE memory_fts MATCH ? AND ${scopeSql} ORDER BY rank LIMIT 40`,
        )
        .all(ftsQuery, ...scopeParameters) as unknown as NoteRow[];
      ftsRows.forEach((noteRow, rankIndex) => fusedScores.set(noteRow.id, { noteRow, score: 1 / (fusionConstant + rankIndex), snippet: noteRow.snippet ?? "" }));
    }

    let queryEmbedding: Awaited<ReturnType<typeof embed>> = null;
    try {
      queryEmbedding = searchText.trim() ? await embed(searchText) : null;
    } catch {
      queryEmbedding = null; // fall back to full-text only
    }
    if (queryEmbedding) {
      const vectorRows = database
        .prepare(`SELECT n.id, n.scope, n.project_id, n.path, n.title, n.modified_at, n.embedding, substr(n.body, 1, 240) AS snippet FROM memory_notes n WHERE n.embedding IS NOT NULL AND n.embedding_model = ? AND ${scopeSql}`)
        .all(queryEmbedding.model, ...scopeParameters) as unknown as NoteRow[];
      vectorRows
        .map((noteRow) => ({ noteRow, similarity: cosineSimilarity(queryEmbedding.vector, blobToVector(noteRow.embedding!)) }))
        .filter((scoredRow) => scoredRow.similarity > 0.2)
        .sort((first, second) => second.similarity - first.similarity)
        .slice(0, 40)
        .forEach(({ noteRow }, rankIndex) => {
          const existing = fusedScores.get(noteRow.id);
          const vectorScore = 1 / (fusionConstant + rankIndex);
          if (existing) existing.score += vectorScore;
          else fusedScores.set(noteRow.id, { noteRow, score: vectorScore, snippet: (noteRow.snippet ?? "").replace(/\s+/g, " ").trim() });
        });
    }

    return [...fusedScores.values()]
      .sort((first, second) => second.score - first.score)
      .slice(0, limit)
      .map(({ noteRow, score, snippet }) => ({ ...toSummary(noteRow), snippet, score }));
  },
};

// --- Notes (file operations) ---

function projectFor(noteRef: { scope: MemoryScope; projectId: string | null }): Project | null {
  if (noteRef.scope === "workspace") return null;
  const project = noteRef.projectId ? projectStore.get(noteRef.projectId) : undefined;
  if (!project) throw new Error(t("Projekt nicht gefunden"));
  return project;
}

export const memoryNotes = {
  read(noteRef: MemoryNoteRef): string {
    const { absolutePath } = resolveNotePath(noteRef.scope, projectFor(noteRef), noteRef.path);
    if (!fs.existsSync(absolutePath)) throw new Error(t("Notiz nicht gefunden"));
    return fs.readFileSync(absolutePath, "utf8");
  },

  async write(noteRef: MemoryNoteRef, content: string, mode: "replace" | "append" = "replace"): Promise<string> {
    const project = projectFor(noteRef);
    const { absolutePath, relativePath } = resolveNotePath(noteRef.scope, project, noteRef.path);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    if (mode === "append" && fs.existsSync(absolutePath)) {
      const existingContent = fs.readFileSync(absolutePath, "utf8");
      fs.writeFileSync(absolutePath, `${existingContent.replace(/\s*$/, "")}\n\n${content.trim()}\n`);
    } else {
      fs.writeFileSync(absolutePath, content.endsWith("\n") ? content : `${content}\n`);
    }
    await queueReindex(noteRef.scope, project);
    return relativePath;
  },

  async remove(noteRef: MemoryNoteRef): Promise<void> {
    const project = projectFor(noteRef);
    const { absolutePath } = resolveNotePath(noteRef.scope, project, noteRef.path);
    fs.rmSync(absolutePath, { force: true });
    await queueReindex(noteRef.scope, project);
  },

  /** Context injected into every agent turn: instruction files + a short note index. */
  contextFor(project: Project): string {
    const sections: string[] = [];
    const workspaceInstructions = path.join(memoryConfig.workspaceDirectory(), "HARNOLD.md");
    if (fs.existsSync(workspaceInstructions)) sections.push(`## Workspace-Memory: HARNOLD.md\n${fs.readFileSync(workspaceInstructions, "utf8").slice(0, 8_000)}`);
    const environment = environmentStore.forProject(project.id);
    if (environment) {
      const environmentInstructions = path.join(environmentMemoryDirectory(environment.id), "HARNOLD.md");
      sections.push(
        fs.existsSync(environmentInstructions)
          ? `## Umgebung „${environment.name}“: HARNOLD.md\n${fs.readFileSync(environmentInstructions, "utf8").slice(0, 8_000)}`
          : `Memory-Ebene "environment" = Umgebung „${environment.name}“ (gilt für alle ihre Projekte).`,
      );
    }
    const projectInstructions = path.join(project.path, "HARNOLD.md");
    if (fs.existsSync(projectInstructions)) sections.push(`## Projekt: HARNOLD.md\n${fs.readFileSync(projectInstructions, "utf8").slice(0, 8_000)}`);
    const noteSummaries = memoryIndex.list(project.id).filter((noteSummary) => noteSummary.path !== "HARNOLD.md").slice(0, 60);
    if (noteSummaries.length) {
      sections.push(
        `## Vorhandene Notizen (neueste zuerst, Auszug)\n${noteSummaries.map((noteSummary) => `- [${noteSummary.scope}] ${noteSummary.path} – ${noteSummary.title}`).join("\n")}`,
      );
    }
    return sections.join("\n\n");
  },
};

// --- Watching ---

let workspaceWatcher: fs.FSWatcher | undefined;
let workspaceDebounceTimer: NodeJS.Timeout | undefined;

export function watchWorkspaceMemory(): void {
  workspaceWatcher?.close();
  const workspaceDirectory = memoryConfig.workspaceDirectory();
  fs.mkdirSync(workspaceDirectory, { recursive: true });
  try {
    workspaceWatcher = fs.watch(workspaceDirectory, { recursive: true }, (_eventType, changedName) => {
      if (changedName && !changedName.toString().toLowerCase().endsWith(".md")) return;
      clearTimeout(workspaceDebounceTimer);
      workspaceDebounceTimer = setTimeout(() => void queueReindex("workspace", null), 400);
    });
  } catch (watchError) {
    console.warn("[memory] watch failed:", watchError);
  }
}

let environmentWatcher: fs.FSWatcher | undefined;
const environmentDebounceTimers = new Map<string, NodeJS.Timeout>();

function watchEnvironmentMemory(): void {
  fs.mkdirSync(environmentMemoryBaseDirectory, { recursive: true });
  try {
    environmentWatcher = fs.watch(environmentMemoryBaseDirectory, { recursive: true }, (_eventType, changedName) => {
      const changedPath = changedName?.toString().split(path.sep).join("/");
      if (!changedPath?.toLowerCase().endsWith(".md")) return;
      const environmentId = changedPath.split("/")[0];
      clearTimeout(environmentDebounceTimers.get(environmentId));
      environmentDebounceTimers.set(
        environmentId,
        setTimeout(() => {
          if (environmentStore.list().some((environment) => environment.id === environmentId)) void queueReindexRoot(environmentRoot(environmentId));
        }, 400),
      );
    });
  } catch (watchError) {
    console.warn("[memory] watch failed:", watchError);
  }
}

const projectDebounceTimers = new Map<string, NodeJS.Timeout>();

/** Called from the project file watcher's events. */
export function handleProjectFilesChanged(projectId: string, changedPaths: string[]): void {
  if (!changedPaths.some((changedPath) => changedPath === "HARNOLD.md" || changedPath === "memory" || changedPath.startsWith("memory/"))) return;
  clearTimeout(projectDebounceTimers.get(projectId));
  projectDebounceTimers.set(
    projectId,
    setTimeout(() => {
      const project = projectStore.get(projectId);
      if (project) void queueReindex("project", project);
    }, 400),
  );
}

export function startMemory(): void {
  watchWorkspaceMemory();
  if (!environmentWatcher) watchEnvironmentMemory();
  eventHub.subscribe((serverEvent) => {
    if (serverEvent.type === "files_changed") handleProjectFilesChanged(serverEvent.projectId, serverEvent.paths);
    if (serverEvent.type === "environments_changed") {
      purgeDeletedEnvironments();
      for (const environment of environmentStore.list()) void queueReindexRoot(environmentRoot(environment.id));
      eventHub.publish({ type: "memory_changed", projectId: null });
    }
  });
  void memoryIndex.reindexAll();
}
