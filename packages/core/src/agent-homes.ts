import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Carries the agents' own configuration (Claude Code: ~/.claude + ~/.claude.json, Codex: ~/.codex) along with a
 * workspace move. Logins stay behind (macOS keeps them in the keychain); everything else that shapes how the agent
 * works travels: instructions, settings, skills, agents, commands, plugins, MCP servers and – optionally – the
 * transcripts and auto-memory of chats in the moved projects, so they continue with their context on the server.
 *
 * No imports from config/db: the import side runs at start-up before the database is opened.
 */

export type AgentHomesManifest = {
  sourceHome: string;
  /** macOS: paths match regardless of case (a transcript may say SaaS_Ideas, the project saas_ideas). */
  caseInsensitivePaths: boolean;
  claudeDirectory: string | null;
  claudeJson: boolean;
  codexDirectory: string | null;
};

export type AgentTransferOptions = { includeConfiguration: boolean; includeTranscripts: boolean };

/** Folder inside the archive. */
export const agentHomesFolderName = "agent-homes";

const claudeDirectory = () => process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
/** Claude Code keeps MCP servers and per-project settings in .claude.json next to (or inside) its config dir. */
const claudeJsonPath = () => (process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(os.homedir(), ".claude.json"));
const codexDirectory = () => process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");

/** What shapes the agent's behaviour; caches, logs, history and logins stay behind. */
const claudeConfigurationEntries = ["CLAUDE.md", "settings.json", "keybindings.json", "skills", "agents", "commands", "output-styles", "plugins"];
const codexConfigurationEntries = ["config.toml", "AGENTS.md", "AGENTS.override.md", "prompts", "skills", "rules", "memories"];
/** Rebuildable or huge inside skills/agents/commands; plugins are copied as they are (they may need their files). */
const skippedFolderNames = new Set(["node_modules", ".venv", "__pycache__", ".cache"]);

/** Claude Code keys transcripts by the cwd with every non-alphanumeric character replaced. */
export const transcriptFolderName = (workingDirectory: string) => workingDirectory.replace(/[^a-zA-Z0-9]/g, "-");

const escapeForRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The cwd a transcript (Claude: "cwd", Codex session_meta: "cwd") was recorded in, from the start of the file. */
function recordedWorkingDirectory(filePath: string): string | null {
  let fileHandle: number | null = null;
  try {
    fileHandle = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(256 * 1024);
    const bytesRead = fs.readSync(fileHandle, buffer, 0, buffer.length, 0);
    const match = /"cwd":("(?:[^"\\]|\\.)*")/.exec(buffer.subarray(0, bytesRead).toString("utf8"));
    return match ? (JSON.parse(match[1]) as string) : null;
  } catch {
    return null;
  } finally {
    if (fileHandle !== null) fs.closeSync(fileHandle);
  }
}

const listFiles = (directory: string, extension: string): string[] => {
  try {
    return fs.readdirSync(directory, { recursive: true, encoding: "utf8" }).filter((entry) => entry.endsWith(extension)).map((entry) => path.join(directory, entry));
  } catch {
    return [];
  }
};

const isInsideAny = (candidate: string, parents: string[], caseInsensitive: boolean) => {
  const normalize = (value: string) => (caseInsensitive ? value.toLowerCase() : value);
  return parents.some((parent) => normalize(candidate) === normalize(parent) || normalize(candidate).startsWith(normalize(parent) + path.sep));
};

const copyIfPresent = async (sourcePath: string, targetPath: string, filtered: boolean) => {
  if (!fs.existsSync(sourcePath)) return false;
  await fs.promises.cp(sourcePath, targetPath, { recursive: true, verbatimSymlinks: true, filter: filtered ? (candidate) => !skippedFolderNames.has(path.basename(candidate)) : undefined });
  return true;
};

/**
 * Skills, CLAUDE.md etc. are often links to folders that do not travel (e.g. ~/.agents/skills or a dotfiles repo).
 * Replaces such links in the staged copy with what they point to; broken links are dropped. Relative links within the
 * copied folder stay links.
 */
async function resolveOutsideLinks(stagedPath: string, sourcePath: string, copiedRoot: string, followedTargets: string[] = []): Promise<void> {
  const information = fs.lstatSync(stagedPath, { throwIfNoEntry: false });
  if (information?.isDirectory()) {
    for (const entryName of fs.readdirSync(stagedPath)) await resolveOutsideLinks(path.join(stagedPath, entryName), path.join(sourcePath, entryName), copiedRoot, followedTargets);
    return;
  }
  if (!information?.isSymbolicLink()) return;
  let target: string;
  try {
    target = fs.realpathSync(sourcePath);
  } catch {
    fs.rmSync(stagedPath);
    return;
  }
  const isRelative = !path.isAbsolute(fs.readlinkSync(stagedPath));
  if (isRelative && fs.existsSync(copiedRoot) && isInsideAny(target, [fs.realpathSync(copiedRoot)], false)) return;
  fs.rmSync(stagedPath);
  // A link to one of its own parent folders would copy forever.
  const containsLink = isInsideAny(fs.realpathSync(path.dirname(sourcePath)), [target], false);
  if (containsLink || followedTargets.includes(target)) return;
  await fs.promises.cp(target, stagedPath, { recursive: true, verbatimSymlinks: true, filter: (candidate) => candidate === target || !skippedFolderNames.has(path.basename(candidate)) });
  await resolveOutsideLinks(stagedPath, target, target, [...followedTargets, target]);
}

/** One entry of an agent's configuration folder, complete in itself. */
async function stageConfigurationEntry(sourcePath: string, targetPath: string, filtered: boolean): Promise<void> {
  if (!fs.existsSync(sourcePath)) return;
  await copyIfPresent(sourcePath, targetPath, filtered);
  await resolveOutsideLinks(targetPath, sourcePath, sourcePath);
}

type PlannedEntry = { sourcePath: string; /** Inside the archive folder. */ target: string; kind: "configuration" | "plugins" | "transcript" };

/**
 * Which files of the agent homes belong to a transfer. `movedPaths` are the folders the other side has (projects,
 * extra folders, data directory) – only transcripts recorded inside them are useful there.
 */
function planAgentHomes(movedPaths: string[], options: AgentTransferOptions): { manifest: AgentHomesManifest; entries: PlannedEntry[]; claudeJson: string | null } {
  const caseInsensitivePaths = process.platform === "darwin" || process.platform === "win32";
  const manifest: AgentHomesManifest = { sourceHome: os.homedir(), caseInsensitivePaths, claudeDirectory: null, claudeJson: false, codexDirectory: null };
  const entries: PlannedEntry[] = [];
  let claudeJson: string | null = null;
  if (!options.includeConfiguration && !options.includeTranscripts) return { manifest, entries, claudeJson };
  const wasMoved = (workingDirectory: string | null) => !!workingDirectory && isInsideAny(workingDirectory, movedPaths, caseInsensitivePaths);

  const claudeSource = claudeDirectory();
  if (fs.existsSync(claudeSource)) {
    if (options.includeConfiguration) {
      for (const entryName of claudeConfigurationEntries) entries.push({ sourcePath: path.join(claudeSource, entryName), target: path.join("claude", entryName), kind: entryName === "plugins" ? "plugins" : "configuration" });
    }
    if (options.includeTranscripts) {
      // One folder per working directory: transcripts, subagent logs, tool results and Claude's auto-memory.
      const projectsSource = path.join(claudeSource, "projects");
      const movedEncodedNames = movedPaths.map((movedPath) => transcriptFolderName(movedPath));
      for (const folderName of fs.existsSync(projectsSource) ? fs.readdirSync(projectsSource) : []) {
        const folderPath = path.join(projectsSource, folderName);
        if (!fs.statSync(folderPath).isDirectory()) continue;
        const workingDirectory = listFiles(folderPath, ".jsonl").map(recordedWorkingDirectory).find(Boolean) ?? null;
        // A folder with only auto-memory has no cwd to read: match its name against the moved folders.
        const matchesByName = !workingDirectory && movedEncodedNames.some((encodedName) => (caseInsensitivePaths ? folderName.toLowerCase().startsWith(encodedName.toLowerCase()) : folderName.startsWith(encodedName)));
        if (wasMoved(workingDirectory) || matchesByName) entries.push({ sourcePath: folderPath, target: path.join("claude", "projects", folderName), kind: "transcript" });
      }
    }
    manifest.claudeDirectory = claudeSource;
  }

  if (options.includeConfiguration && fs.existsSync(claudeJsonPath())) {
    try {
      const parsed = JSON.parse(fs.readFileSync(claudeJsonPath(), "utf8")) as { mcpServers?: unknown; projects?: Record<string, unknown> };
      // Only MCP servers and the settings of moved projects; account state and onboarding stay on this machine.
      const movedProjects = Object.fromEntries(Object.entries(parsed.projects ?? {}).filter(([projectPath]) => wasMoved(projectPath)));
      claudeJson = JSON.stringify({ mcpServers: parsed.mcpServers ?? {}, projects: movedProjects });
      manifest.claudeJson = true;
    } catch {
      /* unreadable .claude.json: nothing to carry */
    }
  }

  const codexSource = codexDirectory();
  if (fs.existsSync(codexSource)) {
    if (options.includeConfiguration) {
      for (const entryName of codexConfigurationEntries) entries.push({ sourcePath: path.join(codexSource, entryName), target: path.join("codex", entryName), kind: "configuration" });
    }
    if (options.includeTranscripts) {
      // Rollouts (sessions/YYYY/MM/DD/rollout-…-<thread id>.jsonl) are what `resumeThread` looks up.
      const sessionsSource = path.join(codexSource, "sessions");
      for (const rolloutPath of listFiles(sessionsSource, ".jsonl")) {
        if (wasMoved(recordedWorkingDirectory(rolloutPath))) entries.push({ sourcePath: rolloutPath, target: path.join("codex", "sessions", path.relative(sessionsSource, rolloutPath)), kind: "transcript" });
      }
    }
    manifest.codexDirectory = codexSource;
  }
  return { manifest, entries, claudeJson };
}

/** Export side: copies the planned parts of the agent homes into `<staging>/agent-homes`. */
export async function stageAgentHomes(stagingDirectory: string, movedPaths: string[], options: AgentTransferOptions): Promise<AgentHomesManifest | null> {
  if (!options.includeConfiguration && !options.includeTranscripts) return null;
  const { manifest, entries, claudeJson } = planAgentHomes(movedPaths, options);
  const targetRoot = path.join(stagingDirectory, agentHomesFolderName);
  fs.mkdirSync(targetRoot, { recursive: true });
  for (const entry of entries) {
    const targetPath = path.join(targetRoot, entry.target);
    if (entry.kind === "transcript") await copyIfPresent(entry.sourcePath, targetPath, false);
    else await stageConfigurationEntry(entry.sourcePath, targetPath, entry.kind === "configuration");
  }
  if (claudeJson !== null) fs.writeFileSync(path.join(targetRoot, "claude.json"), claudeJson);
  return manifest;
}

/** Size of a file or folder, counting what links point to (the transfer copies it). */
async function measureEntry(entryPath: string, visited: Set<string>): Promise<number> {
  try {
    const realPath = await fs.promises.realpath(entryPath);
    // Like the copy, a link to one of its own parent folders counts nothing.
    const isLink = (await fs.promises.lstat(entryPath)).isSymbolicLink();
    if (isLink && isInsideAny(await fs.promises.realpath(path.dirname(entryPath)), [realPath], false)) return 0;
    if (visited.has(realPath)) return 0;
    visited.add(realPath);
    const information = await fs.promises.stat(realPath);
    if (!information.isDirectory()) return information.size;
    let totalBytes = 0;
    for (const entryName of await fs.promises.readdir(realPath)) {
      if (!skippedFolderNames.has(entryName)) totalBytes += await measureEntry(path.join(realPath, entryName), visited);
    }
    return totalBytes;
  } catch {
    return 0;
  }
}

export async function measureAgentHomes(movedPaths: string[]): Promise<{ agentConfigurationBytes: number; agentTranscriptBytes: number }> {
  const { entries } = planAgentHomes(movedPaths, { includeConfiguration: true, includeTranscripts: true });
  const visited = new Set<string>();
  let agentConfigurationBytes = 0;
  let agentTranscriptBytes = 0;
  for (const entry of entries) {
    const sizeBytes = await measureEntry(entry.sourcePath, visited);
    if (entry.kind === "transcript") agentTranscriptBytes += sizeBytes;
    else agentConfigurationBytes += sizeBytes;
  }
  return { agentConfigurationBytes, agentTranscriptBytes };
}

/** Rewrites old absolute paths in text (JSON, JSONL, TOML, Markdown) to their new places. */
export type PathRewriter = { text: (content: string) => string; path: (value: string) => string };

export function createPathRewriter(pathPairs: [string, string][], caseInsensitive: boolean): PathRewriter {
  // Longest first, so a project inside the home folder wins over the home folder itself.
  const sortedPairs = pathPairs.filter(([fromPath, toPath]) => fromPath && fromPath !== toPath).sort((first, second) => second[0].length - first[0].length);
  if (!sortedPairs.length) return { text: (content) => content, path: (value) => value };
  const toPathByKey = new Map(sortedPairs.map(([fromPath, toPath]) => [caseInsensitive ? fromPath.toLowerCase() : fromPath, toPath]));
  // A path ends at a separator, a quote, whitespace or JSON/TOML punctuation – never in the middle of a name.
  const pattern = new RegExp(`(${sortedPairs.map(([fromPath]) => escapeForRegex(fromPath)).join("|")})(?=[/\\\\"'\`\\s:,\\]}\\)]|$)`, caseInsensitive ? "gi" : "g");
  const replace = (content: string) => content.replace(pattern, (matched) => toPathByKey.get(caseInsensitive ? matched.toLowerCase() : matched) ?? matched);
  return { text: replace, path: replace };
}

const rewriteFile = (filePath: string, rewriter: PathRewriter) => {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const rewritten = rewriter.text(content);
    if (rewritten !== content) fs.writeFileSync(filePath, rewritten);
  } catch {
    /* unreadable: leave as is */
  }
};

/**
 * Moves transcript folders to the name Claude Code expects for the new cwd and rewrites the paths inside.
 * Works in place; folders of two old spellings that land on the same new name are merged.
 */
export function relocateClaudeTranscripts(claudeConfigDirectory: string, rewriter: PathRewriter): void {
  const projectsDirectory = path.join(claudeConfigDirectory, "projects");
  if (!fs.existsSync(projectsDirectory)) return;
  for (const folderName of fs.readdirSync(projectsDirectory)) {
    const folderPath = path.join(projectsDirectory, folderName);
    if (!fs.statSync(folderPath).isDirectory()) continue;
    const workingDirectory = listFiles(folderPath, ".jsonl").map(recordedWorkingDirectory).find(Boolean) ?? null;
    for (const extension of [".jsonl", ".json", ".md"]) for (const filePath of listFiles(folderPath, extension)) rewriteFile(filePath, rewriter);
    if (!workingDirectory) continue;
    const newFolderName = transcriptFolderName(rewriter.path(workingDirectory));
    if (newFolderName === folderName) continue;
    const newFolderPath = path.join(projectsDirectory, newFolderName);
    if (fs.existsSync(newFolderPath)) {
      fs.cpSync(folderPath, newFolderPath, { recursive: true, verbatimSymlinks: true });
      fs.rmSync(folderPath, { recursive: true, force: true });
    } else {
      fs.renameSync(folderPath, newFolderPath);
    }
  }
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
const isPlainObject = (value: unknown): value is Record<string, JsonValue> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Uploaded values win; objects merge key by key; lists of plain values (permissions) are joined. */
function mergeJson(existing: JsonValue, incoming: JsonValue): JsonValue {
  if (isPlainObject(existing) && isPlainObject(incoming)) {
    const merged: Record<string, JsonValue> = { ...existing };
    for (const [key, value] of Object.entries(incoming)) merged[key] = key in existing ? mergeJson(existing[key], value) : value;
    return merged;
  }
  if (Array.isArray(existing) && Array.isArray(incoming) && [...existing, ...incoming].every((item) => typeof item !== "object" || item === null)) {
    return [...new Set([...existing, ...incoming])];
  }
  return incoming;
}

const readJsonFile = (filePath: string): JsonValue | undefined => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as JsonValue;
  } catch {
    return undefined;
  }
};

/** Files merged as JSON instead of replaced, so settings made on the server survive. */
const mergedJsonFiles = new Set(["settings.json", "keybindings.json", path.join("plugins", "installed_plugins.json"), path.join("plugins", "known_marketplaces.json")]);

/** Copies a single file or link; links are recreated as they are, never followed. */
function copyEntry(sourcePath: string, targetPath: string): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const information = fs.lstatSync(sourcePath);
  if (information.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(sourcePath), targetPath);
  else if (information.isDirectory()) {
    fs.mkdirSync(targetPath, { recursive: true });
    for (const entryName of fs.readdirSync(sourcePath)) copyEntry(path.join(sourcePath, entryName), path.join(targetPath, entryName));
  } else if (information.isFile()) fs.copyFileSync(sourcePath, targetPath);
}

type MergeOptions = { /** Keep a transcript here that is at least as long as the uploaded one. */ keepLongerTranscripts?: boolean };

/**
 * Copies `sourceDirectory` into `targetDirectory`: new files are added, existing ones are moved to `backupDirectory`
 * first (or merged, for the JSON settings above). Nothing on the server is deleted. An entry that fails is noted in
 * `problems` and does not stop the others.
 */
function mergeDirectory(sourceDirectory: string, targetDirectory: string, backupDirectory: string, problems: string[], options: MergeOptions, relativePath = ""): void {
  for (const entry of fs.readdirSync(path.join(sourceDirectory, relativePath), { withFileTypes: true })) {
    const entryRelativePath = path.join(relativePath, entry.name);
    const sourcePath = path.join(sourceDirectory, entryRelativePath);
    const targetPath = path.join(targetDirectory, entryRelativePath);
    try {
      const existing = fs.lstatSync(targetPath, { throwIfNoEntry: false });
      if (entry.isDirectory()) {
        if (existing && !existing.isDirectory()) {
          copyEntry(targetPath, path.join(backupDirectory, entryRelativePath));
          fs.rmSync(targetPath, { force: true });
        }
        fs.mkdirSync(targetPath, { recursive: true });
        mergeDirectory(sourceDirectory, targetDirectory, backupDirectory, problems, options, entryRelativePath);
        continue;
      }
      // Transcripts only grow, so the longer one holds more of the chat.
      const isTranscript = entry.name.endsWith(".jsonl") && /^(projects|sessions)[\\/]/.test(entryRelativePath);
      if (options.keepLongerTranscripts && isTranscript && existing?.isFile() && existing.size >= fs.statSync(sourcePath).size) continue;
      if (existing) {
        copyEntry(targetPath, path.join(backupDirectory, entryRelativePath));
        if (mergedJsonFiles.has(entryRelativePath) && existing.isFile()) {
          const existingValue = readJsonFile(targetPath);
          const incomingValue = readJsonFile(sourcePath);
          if (existingValue !== undefined && incomingValue !== undefined) {
            fs.writeFileSync(targetPath, JSON.stringify(mergeJson(existingValue, incomingValue), null, 2));
            continue;
          }
        }
        fs.rmSync(targetPath, { recursive: true, force: true });
      }
      copyEntry(sourcePath, targetPath);
    } catch (entryError) {
      problems.push(entryError instanceof Error ? entryError.message : String(entryError));
    }
  }
}

/**
 * Import side: rewrites the paths in the uploaded agent homes and merges them into this machine's homes.
 * `movedPathPairs` = old → new for project folders and the data directory. Returns what could not be applied.
 */
export function applyAgentHomes(stagedDirectory: string, manifest: AgentHomesManifest, movedPathPairs: [string, string][], backupDirectory: string, options: MergeOptions = {}): string[] {
  const problems: string[] = [];
  const uploadedRoot = path.join(stagedDirectory, agentHomesFolderName);
  if (!fs.existsSync(uploadedRoot)) return problems;
  /** Claude, its MCP servers and Codex are independent: one failing must not cost the others. */
  const attempt = (work: () => void) => {
    try {
      work();
    } catch (sectionError) {
      problems.push(sectionError instanceof Error ? sectionError.message : String(sectionError));
    }
  };
  const homePairs: [string, string][] = [
    ...(manifest.claudeDirectory ? [[manifest.claudeDirectory, claudeDirectory()] as [string, string]] : []),
    ...(manifest.codexDirectory ? [[manifest.codexDirectory, codexDirectory()] as [string, string]] : []),
  ];
  // Transcripts: only moved folders and the agent homes. Configuration: additionally the old home folder.
  const transcriptRewriter = createPathRewriter([...movedPathPairs, ...homePairs], manifest.caseInsensitivePaths);
  const configurationRewriter = createPathRewriter([...movedPathPairs, ...homePairs, [manifest.sourceHome, os.homedir()]], manifest.caseInsensitivePaths);

  attempt(() => {
    const uploadedClaude = path.join(uploadedRoot, "claude");
    if (!fs.existsSync(uploadedClaude)) return;
    attempt(() => relocateClaudeTranscripts(uploadedClaude, transcriptRewriter));
    for (const fileName of ["settings.json", "keybindings.json", path.join("plugins", "installed_plugins.json"), path.join("plugins", "known_marketplaces.json")]) {
      rewriteFile(path.join(uploadedClaude, fileName), configurationRewriter);
    }
    fs.mkdirSync(claudeDirectory(), { recursive: true });
    mergeDirectory(uploadedClaude, claudeDirectory(), path.join(backupDirectory, "claude"), problems, options);
  });

  attempt(() => {
    const uploadedClaudeJson = readJsonFile(path.join(uploadedRoot, "claude.json"));
    if (!isPlainObject(uploadedClaudeJson)) return;
    const projects = isPlainObject(uploadedClaudeJson.projects) ? uploadedClaudeJson.projects : {};
    const incoming: Record<string, JsonValue> = {
      mcpServers: JSON.parse(configurationRewriter.text(JSON.stringify(uploadedClaudeJson.mcpServers ?? {}))) as JsonValue,
      projects: Object.fromEntries(Object.entries(projects).map(([projectPath, projectSettings]) => [transcriptRewriter.path(projectPath), projectSettings])),
    };
    const existing = readJsonFile(claudeJsonPath());
    if (existing !== undefined) {
      fs.mkdirSync(backupDirectory, { recursive: true });
      fs.copyFileSync(claudeJsonPath(), path.join(backupDirectory, "claude.json"));
    }
    fs.mkdirSync(path.dirname(claudeJsonPath()), { recursive: true });
    fs.writeFileSync(claudeJsonPath(), JSON.stringify(existing === undefined ? incoming : mergeJson(existing, incoming), null, 2));
  });

  attempt(() => {
    const uploadedCodex = path.join(uploadedRoot, "codex");
    if (!fs.existsSync(uploadedCodex)) return;
    rewriteFile(path.join(uploadedCodex, "config.toml"), configurationRewriter);
    for (const rolloutPath of listFiles(path.join(uploadedCodex, "sessions"), ".jsonl")) rewriteFile(rolloutPath, transcriptRewriter);
    fs.mkdirSync(codexDirectory(), { recursive: true });
    mergeDirectory(uploadedCodex, codexDirectory(), path.join(backupDirectory, "codex"), problems, options);
  });
  return problems;
}

/**
 * Claude config dirs of environments (data directory/claude-accounts/<id>) came along with the data directory:
 * their links to the old ~/.claude point nowhere now (they are removed and recreated on first use) and their
 * transcripts still carry the old paths.
 */
export function repairEnvironmentClaudeDirectories(dataDirectory: string, rewriter: PathRewriter): void {
  const accountsDirectory = path.join(dataDirectory, "claude-accounts");
  if (!fs.existsSync(accountsDirectory)) return;
  for (const accountName of fs.readdirSync(accountsDirectory)) {
    const accountDirectory = path.join(accountsDirectory, accountName);
    if (!fs.statSync(accountDirectory).isDirectory()) continue;
    for (const entry of fs.readdirSync(accountDirectory, { withFileTypes: true })) {
      const linkPath = path.join(accountDirectory, entry.name);
      if (entry.isSymbolicLink() && !fs.existsSync(linkPath)) fs.rmSync(linkPath, { force: true });
    }
    relocateClaudeTranscripts(accountDirectory, rewriter);
  }
}
