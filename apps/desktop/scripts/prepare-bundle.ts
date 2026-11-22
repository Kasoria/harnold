// Prepares everything the desktop app bundles: Node runtime (sidecar), Core with prod deps, built UI.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const nodeVersion = "26.13.1";
const desktopDirectory = path.resolve(import.meta.dirname, "..");
const repositoryDirectory = path.resolve(desktopDirectory, "../..");
const cacheDirectory = path.join(desktopDirectory, ".cache");
const resourcesDirectory = path.join(desktopDirectory, "resources");
const binariesDirectory = path.join(desktopDirectory, "src-tauri/binaries");

const nodeArch = process.arch === "arm64" ? "arm64" : "x64";
const rustTriple = process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";

function run(command: string, args: string[], workingDirectory = repositoryDirectory) {
  console.log(`> ${command} ${args.join(" ")}`);
  execFileSync(command, args, { cwd: workingDirectory, stdio: "inherit" });
}

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download fehlgeschlagen (${response.status}): ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

/** Official Node build (self-contained, unlike Homebrew's), verified against SHASUMS256. */
async function prepareNodeRuntime() {
  const archiveName = `node-v${nodeVersion}-darwin-${nodeArch}.tar.gz`;
  const extractedNodeBinary = path.join(cacheDirectory, `node-v${nodeVersion}-darwin-${nodeArch}`, "bin/node");
  if (!fs.existsSync(extractedNodeBinary)) {
    fs.mkdirSync(cacheDirectory, { recursive: true });
    const baseUrl = `https://nodejs.org/dist/v${nodeVersion}`;
    const checksums = (await download(`${baseUrl}/SHASUMS256.txt`)).toString("utf8");
    const expectedChecksum = checksums.split("\n").find((line) => line.endsWith(`  ${archiveName}`))?.split(" ")[0];
    if (!expectedChecksum) throw new Error(`Keine Prüfsumme für ${archiveName}`);
    const archive = await download(`${baseUrl}/${archiveName}`);
    const actualChecksum = createHash("sha256").update(archive).digest("hex");
    if (actualChecksum !== expectedChecksum) throw new Error(`Prüfsumme falsch für ${archiveName}`);
    const archivePath = path.join(cacheDirectory, archiveName);
    fs.writeFileSync(archivePath, archive);
    run("tar", ["-xzf", archivePath, "-C", cacheDirectory]);
    fs.rmSync(archivePath);
  }
  fs.mkdirSync(binariesDirectory, { recursive: true });
  const sidecarPath = path.join(binariesDirectory, `node-${rustTriple}`);
  fs.copyFileSync(extractedNodeBinary, sidecarPath);
  fs.chmodSync(sidecarPath, 0o755);
}

function prepareCore() {
  const coreTarget = path.join(resourcesDirectory, "core");
  fs.rmSync(coreTarget, { recursive: true, force: true });
  // Hoisted = real folders instead of pnpm symlinks, so the bundler copies them as-is.
  run("pnpm", ["--filter", "@harnold/core", "deploy", "--prod", "--legacy", "--config.node-linker=hoisted", coreTarget]);
  // CLI symlinks are not needed at runtime and would break the app signature.
  fs.rmSync(path.join(coreTarget, "node_modules/.bin"), { recursive: true, force: true });
  // Agent programs (Claude Code …) are not shipped: Harnold uses the installed one or downloads it on request.
  const anthropicDirectory = path.join(coreTarget, "node_modules/@anthropic-ai");
  for (const packageName of fs.readdirSync(anthropicDirectory)) {
    if (packageName.startsWith("claude-agent-sdk-")) fs.rmSync(path.join(anthropicDirectory, packageName), { recursive: true, force: true });
  }
}

function prepareUi() {
  run("pnpm", ["--filter", "@harnold/ui", "build"]);
  const uiTarget = path.join(resourcesDirectory, "ui");
  fs.rmSync(uiTarget, { recursive: true, force: true });
  fs.cpSync(path.join(repositoryDirectory, "apps/ui/dist"), uiTarget, { recursive: true });
}

await prepareNodeRuntime();
prepareCore();
prepareUi();
console.log("Desktop-Bundle vorbereitet.");
