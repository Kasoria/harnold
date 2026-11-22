// Builds a signed desktop release and publishes it on GitHub Releases, where the app's auto update finds it.
// Usage: npm run release -- <version> ["Notes"] [--dry]   (--dry builds and writes latest.json, uploads nothing)
// Needs the updater key at ~/.tauri/harnold.key (or TAURI_SIGNING_PRIVATE_KEY) and an authenticated gh.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { signingIdentity } from "./signing.ts";

const releaseRepository = "Kasoria/harnold";
const desktopDirectory = path.resolve(import.meta.dirname, "..");
const tauriDirectory = path.join(desktopDirectory, "src-tauri");
const bundleDirectory = path.join(tauriDirectory, "target/release/bundle");

const commandArguments = process.argv.slice(2);
const dryRun = commandArguments.includes("--dry");
const [version, releaseNotes = ""] = commandArguments.filter((argument) => argument !== "--dry");
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("Usage: npm run release -- <version, e.g. 0.2.0> [\"Notes\"] [--dry]");
  process.exit(1);
}

function run(command: string, args: string[], extraEnvironment: Record<string, string> = {}) {
  console.log(`> ${command} ${args.join(" ")}`);
  execFileSync(command, args, { cwd: desktopDirectory, stdio: "inherit", env: { ...process.env, ...extraEnvironment } });
}

function setVersions() {
  const tauriConfigPath = path.join(tauriDirectory, "tauri.conf.json");
  const tauriConfig = JSON.parse(fs.readFileSync(tauriConfigPath, "utf8"));
  tauriConfig.version = version;
  fs.writeFileSync(tauriConfigPath, `${JSON.stringify(tauriConfig, null, 2)}\n`);

  const packagePath = path.join(desktopDirectory, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  packageJson.version = version;
  fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

  const cargoPath = path.join(tauriDirectory, "Cargo.toml");
  fs.writeFileSync(cargoPath, fs.readFileSync(cargoPath, "utf8").replace(/^version = ".*"$/m, `version = "${version}"`));
}

function signingEnvironment(): Record<string, string> {
  if (process.env.TAURI_SIGNING_PRIVATE_KEY) return {};
  const keyPath = path.join(os.homedir(), ".tauri/harnold.key");
  if (!fs.existsSync(keyPath)) throw new Error(`Updater key missing: ${keyPath} (or set TAURI_SIGNING_PRIVATE_KEY)`);
  return { TAURI_SIGNING_PRIVATE_KEY: fs.readFileSync(keyPath, "utf8"), TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "" };
}

const architecture = process.arch === "arm64" ? "aarch64" : "x86_64";
setVersions();
// Updater artifacts only for releases, so a plain build:app works without the key.
run("npm", ["run", "prepare-bundle"]);
// Feste Signatur: sonst verliert macOS bei jedem Update die Ordner-Freigaben und fragt wieder nach.
const identity = signingIdentity();
if (identity) console.log(`> Signatur: ${identity}`);
else console.warn("! Keine Signatur-Identität gefunden – macOS fragt nach jedem Update erneut nach Ordner-Zugriffen.");
run(
  "npx",
  ["tauri", "build", "--config", JSON.stringify({ bundle: { createUpdaterArtifacts: true, ...(identity ? { macOS: { signingIdentity: identity } } : {}) } })],
  { CI: "true", ...signingEnvironment() },
);

const updateArchive = path.join(bundleDirectory, "macos/Harnold.app.tar.gz");
const releaseDirectory = path.join(bundleDirectory, "release");
fs.rmSync(releaseDirectory, { recursive: true, force: true });
fs.mkdirSync(releaseDirectory, { recursive: true });
const archiveName = `Harnold_${version}_${architecture}.app.tar.gz`;
fs.copyFileSync(updateArchive, path.join(releaseDirectory, archiveName));
const diskImageName = `Harnold_${version}_${architecture}.dmg`;
fs.copyFileSync(path.join(bundleDirectory, "dmg", diskImageName), path.join(releaseDirectory, diskImageName));

const updateManifest = {
  version,
  notes: releaseNotes,
  pub_date: new Date().toISOString(),
  platforms: {
    [`darwin-${architecture}`]: {
      signature: fs.readFileSync(`${updateArchive}.sig`, "utf8").trim(),
      url: `https://github.com/${releaseRepository}/releases/download/v${version}/${archiveName}`,
    },
  },
};
fs.writeFileSync(path.join(releaseDirectory, "latest.json"), `${JSON.stringify(updateManifest, null, 2)}\n`);
console.log(`Release files: ${releaseDirectory}`);

if (dryRun) process.exit(0);
const releaseFiles = [archiveName, diskImageName, "latest.json"].map((fileName) => path.join(releaseDirectory, fileName));
run("gh", ["release", "create", `v${version}`, ...releaseFiles, "--repo", releaseRepository, "--title", `Harnold ${version}`, "--notes", releaseNotes || `Harnold ${version}`]);
