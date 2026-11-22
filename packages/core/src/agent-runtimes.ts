import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { config } from "./config.ts";
import { eventHub } from "./events.ts";
import { t } from "./i18n.ts";

/**
 * Agent programs (e.g. Claude Code) that Harnold drives. Never shipped with the desktop app:
 * Harnold uses what is already on the machine and downloads one only when the user asks for it.
 * Order: explicit path (env) → copy from the SDK install (dev/server) → downloaded by Harnold → installed on the system.
 */
export type AgentRuntimeId = "claude-code";
export type AgentRuntimeSource = "configured" | "bundled" | "downloaded" | "installed";
export type AgentRuntimeStatus = {
  id: AgentRuntimeId;
  name: string;
  found: boolean;
  source?: AgentRuntimeSource;
  executablePath?: string;
  version?: string;
  /** Version this Harnold release is built against; older ones may lack features. */
  recommendedVersion: string;
  outdated: boolean;
  /** Found on the system but too old to work. */
  tooOldPath?: string;
  installHint: string;
  installUrl: string;
  download: { running: boolean; receivedBytes: number; totalBytes: number; error?: string };
};

type RuntimeDefinition = {
  name: string;
  executableName: string;
  /** Env var with an explicit path. */
  pathVariable: string;
  minimumVersion: string;
  recommendedVersion: () => string;
  bundledExecutable: () => string | null;
  /** npm package that holds the exact matching binary for this platform. */
  downloadPackage: () => { packageName: string; version: string; pathInArchive: string };
  installHint: string;
  installUrl: string;
};

const claudeSdkDirectory = () => path.dirname(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"));
const claudeSdkPackage = (): { version: string; claudeCodeVersion: string } =>
  JSON.parse(fs.readFileSync(path.join(claudeSdkDirectory(), "package.json"), "utf8"));
const executableSuffix = process.platform === "win32" ? ".exe" : "";

function claudePlatformPackage(): string {
  const isMusl = process.platform === "linux" && !(process.report?.getReport() as { header?: { glibcVersionRuntime?: string } })?.header?.glibcVersionRuntime;
  return `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${isMusl ? "-musl" : ""}`;
}

const runtimeDefinitions: Record<AgentRuntimeId, RuntimeDefinition> = {
  "claude-code": {
    name: "Claude Code",
    executableName: "claude",
    pathVariable: "HARNOLD_CLAUDE_PATH",
    // Older versions reject options the SDK passes at startup.
    minimumVersion: "2.1.261",
    recommendedVersion: () => claudeSdkPackage().claudeCodeVersion,
    bundledExecutable: () => {
      try {
        const sdkRequire = createRequire(path.join(claudeSdkDirectory(), "package.json"));
        const packageDirectory = path.dirname(sdkRequire.resolve(`${claudePlatformPackage()}/package.json`));
        const executablePath = path.join(packageDirectory, `claude${executableSuffix}`);
        return fs.existsSync(executablePath) ? executablePath : null;
      } catch {
        return null;
      }
    },
    downloadPackage: () => ({ packageName: claudePlatformPackage(), version: claudeSdkPackage().version, pathInArchive: `package/claude${executableSuffix}` }),
    installHint: "curl -fsSL https://claude.ai/install.sh | bash",
    installUrl: "https://docs.claude.com/en/docs/claude-code/setup",
  },
};

// ---------------------------------------------------------------- Detection

const parseVersion = (text: string) => text.match(/\d+\.\d+\.\d+/)?.[0];
function compareVersions(leftVersion: string, rightVersion: string): number {
  const leftParts = leftVersion.split(".").map(Number);
  const rightParts = rightVersion.split(".").map(Number);
  for (let partIndex = 0; partIndex < 3; partIndex++) {
    const difference = (leftParts[partIndex] ?? 0) - (rightParts[partIndex] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

const readVersion = (executablePath: string) =>
  new Promise<string | undefined>((resolve) => {
    execFile(executablePath, ["--version"], { timeout: 10_000 }, (runError, standardOutput) => resolve(runError ? undefined : parseVersion(standardOutput)));
  });

const downloadsDirectory = (runtimeId: AgentRuntimeId) => path.join(config.dataDirectory, "runtimes", runtimeId);

function downloadedExecutable(runtimeId: AgentRuntimeId): string | null {
  const definition = runtimeDefinitions[runtimeId];
  const versionDirectory = path.join(downloadsDirectory(runtimeId), definition.downloadPackage().version);
  const executablePath = path.join(versionDirectory, `${definition.executableName}${executableSuffix}`);
  return fs.existsSync(executablePath) ? executablePath : null;
}

/** Executables with this name on PATH plus the usual install folders (GUI apps often get a short PATH). */
function systemCandidates(executableName: string): string[] {
  const homeDirectory = os.homedir();
  const searchDirectories = [
    ...(process.env.PATH ?? "").split(path.delimiter),
    path.join(homeDirectory, ".local/bin"),
    path.join(homeDirectory, ".claude/local"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ].filter(Boolean);
  const candidatePaths = searchDirectories.map((directory) => path.join(directory, `${executableName}${executableSuffix}`));
  return [...new Set(candidatePaths)].filter((candidatePath) => {
    try {
      fs.accessSync(candidatePath, fs.constants.X_OK);
      return fs.statSync(candidatePath).isFile();
    } catch {
      return false;
    }
  });
}

type DetectedRuntime = Pick<AgentRuntimeStatus, "found" | "source" | "executablePath" | "version" | "tooOldPath">;

async function detect(runtimeId: AgentRuntimeId): Promise<DetectedRuntime> {
  const definition = runtimeDefinitions[runtimeId];
  const configuredPath = process.env[definition.pathVariable];
  if (configuredPath) return { found: fs.existsSync(configuredPath), source: "configured", executablePath: configuredPath, version: await readVersion(configuredPath) };

  for (const [source, executablePath] of [["bundled", definition.bundledExecutable()], ["downloaded", downloadedExecutable(runtimeId)]] as const) {
    if (executablePath) return { found: true, source, executablePath, version: await readVersion(executablePath) };
  }

  let tooOldPath: string | undefined;
  for (const candidatePath of systemCandidates(definition.executableName)) {
    const version = await readVersion(candidatePath);
    if (!version) continue;
    if (compareVersions(version, definition.minimumVersion) >= 0) return { found: true, source: "installed", executablePath: candidatePath, version };
    tooOldPath ??= candidatePath;
  }
  return { found: false, tooOldPath };
}

// ---------------------------------------------------------------- Download (only on explicit user request)

type DownloadState = AgentRuntimeStatus["download"];
const downloadStates = new Map<AgentRuntimeId, DownloadState>();
const detectedRuntimes = new Map<AgentRuntimeId, Promise<DetectedRuntime>>();

function announceChange(): void {
  eventHub.publish({ type: "claude_auth_changed" });
}

async function downloadRuntime(runtimeId: AgentRuntimeId, downloadState: DownloadState): Promise<void> {
  const definition = runtimeDefinitions[runtimeId];
  const { packageName, version, pathInArchive } = definition.downloadPackage();
  const metadataResponse = await fetch(`https://registry.npmjs.org/${packageName.replace("/", "%2f")}/${version}`);
  if (!metadataResponse.ok) throw new Error(t("Paketinfo nicht abrufbar ({0})", metadataResponse.status));
  const { dist } = (await metadataResponse.json()) as { dist: { tarball: string; integrity: string } };
  const [hashAlgorithm, expectedHash] = dist.integrity.split("-", 2) as [string, string];

  const archiveResponse = await fetch(dist.tarball);
  if (!archiveResponse.ok || !archiveResponse.body) throw new Error(t("Download fehlgeschlagen ({0})", archiveResponse.status));
  downloadState.totalBytes = Number(archiveResponse.headers.get("content-length") ?? 0);

  const runtimeDirectory = downloadsDirectory(runtimeId);
  fs.mkdirSync(runtimeDirectory, { recursive: true });
  const workDirectory = fs.mkdtempSync(path.join(runtimeDirectory, ".download-"));
  try {
    const archivePath = path.join(workDirectory, "package.tgz");
    const archiveFile = fs.openSync(archivePath, "w");
    const archiveHash = createHash(hashAlgorithm);
    let lastAnnouncedAt = 0;
    try {
      for await (const chunk of archiveResponse.body as AsyncIterable<Uint8Array>) {
        fs.writeSync(archiveFile, chunk);
        archiveHash.update(chunk);
        downloadState.receivedBytes += chunk.byteLength;
        if (Date.now() - lastAnnouncedAt > 500) {
          lastAnnouncedAt = Date.now();
          announceChange();
        }
      }
    } finally {
      fs.closeSync(archiveFile);
    }
    if (archiveHash.digest("base64") !== expectedHash) throw new Error(t("Prüfsumme stimmt nicht – Download verworfen"));

    await new Promise<void>((resolve, reject) =>
      execFile("tar", ["-xzf", archivePath, "-C", workDirectory, pathInArchive], (extractError) => (extractError ? reject(extractError) : resolve())),
    );
    const versionDirectory = path.join(runtimeDirectory, version);
    fs.rmSync(versionDirectory, { recursive: true, force: true });
    fs.mkdirSync(versionDirectory, { recursive: true });
    const executablePath = path.join(versionDirectory, `${definition.executableName}${executableSuffix}`);
    fs.renameSync(path.join(workDirectory, pathInArchive), executablePath);
    fs.chmodSync(executablePath, 0o755);
    // Older downloads are no longer used.
    for (const entryName of fs.readdirSync(runtimeDirectory)) {
      if (entryName !== version && !entryName.startsWith(".")) fs.rmSync(path.join(runtimeDirectory, entryName), { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(workDirectory, { recursive: true, force: true });
  }
}

export const agentRuntimes = {
  async status(runtimeId: AgentRuntimeId, forceRefresh = false): Promise<AgentRuntimeStatus> {
    const definition = runtimeDefinitions[runtimeId];
    if (forceRefresh || !detectedRuntimes.has(runtimeId)) detectedRuntimes.set(runtimeId, detect(runtimeId));
    const detected = await detectedRuntimes.get(runtimeId)!;
    const recommendedVersion = definition.recommendedVersion();
    return {
      id: runtimeId,
      name: definition.name,
      ...detected,
      recommendedVersion,
      outdated: Boolean(detected.version && compareVersions(detected.version, recommendedVersion) < 0),
      installHint: definition.installHint,
      installUrl: definition.installUrl,
      download: downloadStates.get(runtimeId) ?? { running: false, receivedBytes: 0, totalBytes: 0 },
    };
  },

  /** Path to start, or null when nothing usable is on this machine. */
  async executable(runtimeId: AgentRuntimeId): Promise<string | null> {
    const runtimeStatus = await agentRuntimes.status(runtimeId);
    return runtimeStatus.found ? (runtimeStatus.executablePath ?? null) : null;
  },

  /** Starts the download in the background; progress comes via status. */
  download(runtimeId: AgentRuntimeId): void {
    if (downloadStates.get(runtimeId)?.running) return;
    const downloadState: DownloadState = { running: true, receivedBytes: 0, totalBytes: 0 };
    downloadStates.set(runtimeId, downloadState);
    announceChange();
    downloadRuntime(runtimeId, downloadState)
      .catch((downloadError: unknown) => {
        downloadState.error = downloadError instanceof Error ? downloadError.message : String(downloadError);
      })
      .finally(() => {
        downloadState.running = false;
        detectedRuntimes.delete(runtimeId);
        announceChange();
      });
  },
};
