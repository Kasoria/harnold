import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Settings, SdkPluginConfig } from "@anthropic-ai/claude-agent-sdk";
import { settingsStore } from "./settings.ts";

/**
 * Plugins (skills, commands, agents, hooks, MCP servers as one bundle) from three places:
 * - "claude-code": installed via Claude Code (`~/.claude/plugins`), keyed `name@marketplace`
 * - "claude-desktop": the plugins Claude Desktop syncs for its agent mode
 * - "folder": any plugin folder added in Harnold
 */
export type PluginSource = "claude-code" | "claude-desktop" | "folder";
export type PluginInfo = { id: string; name: string; description: string; version: string | null; source: PluginSource; path: string; enabled: boolean };

const claudeDirectory = () => process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
const claudeDesktopSessionsDirectory = () => path.join(os.homedir(), "Library", "Application Support", "Claude", "local-agent-mode-sessions");

const readJson = <Value>(filePath: string): Value | null => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as Value;
  } catch {
    return null;
  }
};

type PluginManifest = { name?: string; description?: string; version?: string };
const manifestOf = (pluginPath: string) => readJson<PluginManifest>(path.join(pluginPath, ".claude-plugin", "plugin.json"));

/** Harnold's own on/off choice per plugin id (overrides Claude Code's `enabledPlugins`). */
const enabledOverrides = () => settingsStore.read<Record<string, boolean>>("plugins.enabled", {});
const addedFolders = () => settingsStore.read<string[]>("plugins.folders", []);

function claudeCodePlugins(): Omit<PluginInfo, "enabled">[] {
  const installed = readJson<{ plugins?: Record<string, { installPath: string; version?: string }[]> }>(path.join(claudeDirectory(), "plugins", "installed_plugins.json"));
  return Object.entries(installed?.plugins ?? {}).flatMap(([pluginId, installations]) => {
    const installation = installations.at(-1);
    if (!installation || !fs.existsSync(installation.installPath)) return [];
    const manifest = manifestOf(installation.installPath);
    return [{ id: pluginId, name: manifest?.name ?? pluginId.split("@")[0], description: manifest?.description ?? "", version: installation.version ?? manifest?.version ?? null, source: "claude-code" as const, path: installation.installPath }];
  });
}

/** Claude Desktop keeps a copy per agent-mode session (…/<account>/<session>/rpm/plugin_*); the newest copy per name wins. */
function claudeDesktopPlugins(): Omit<PluginInfo, "enabled">[] {
  const newestByName = new Map<string, { pluginPath: string; modifiedAt: number; manifest: PluginManifest }>();
  const listDirectories = (directory: string) => {
    try {
      return fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(directory, entry.name));
    } catch {
      return [];
    }
  };
  for (const accountDirectory of listDirectories(claudeDesktopSessionsDirectory())) {
    for (const sessionDirectory of listDirectories(accountDirectory)) {
      for (const pluginPath of listDirectories(path.join(sessionDirectory, "rpm"))) {
        const manifest = manifestOf(pluginPath);
        if (!manifest?.name) continue;
        const modifiedAt = fs.statSync(pluginPath).mtimeMs;
        const current = newestByName.get(manifest.name);
        if (!current || current.modifiedAt < modifiedAt) newestByName.set(manifest.name, { pluginPath, modifiedAt, manifest });
      }
    }
  }
  return [...newestByName.values()].map(({ pluginPath, manifest }) => ({
    id: `claude-desktop:${manifest.name}`,
    name: manifest.name!,
    description: manifest.description ?? "",
    version: manifest.version ?? null,
    source: "claude-desktop" as const,
    path: pluginPath,
  }));
}

function folderPlugins(): Omit<PluginInfo, "enabled">[] {
  return addedFolders().map((pluginPath) => {
    const manifest = manifestOf(pluginPath);
    return { id: `folder:${pluginPath}`, name: manifest?.name ?? path.basename(pluginPath), description: manifest?.description ?? "", version: manifest?.version ?? null, source: "folder" as const, path: pluginPath };
  });
}

export const pluginStore = {
  list(): PluginInfo[] {
    const overrides = enabledOverrides();
    const claudeCodeEnabled = readJson<Settings>(path.join(claudeDirectory(), "settings.json"))?.enabledPlugins ?? {};
    // Claude Code plugins follow Claude Code until switched in Harnold; Desktop plugins start off (avoid duplicates), added folders on.
    const defaultEnabled = (plugin: Omit<PluginInfo, "enabled">) =>
      plugin.source === "claude-code" ? claudeCodeEnabled[plugin.id] === true : plugin.source === "folder";
    return [...claudeCodePlugins(), ...claudeDesktopPlugins(), ...folderPlugins()].map((plugin) => ({ ...plugin, enabled: overrides[plugin.id] ?? defaultEnabled(plugin) }));
  },

  setEnabled(pluginId: string, enabled: boolean): void {
    settingsStore.write("plugins.enabled", { ...enabledOverrides(), [pluginId]: enabled });
  },

  addFolder(folderPath: string): PluginInfo {
    const resolvedPath = path.resolve(folderPath.replace(/^~(?=$|\/)/, os.homedir()));
    if (!manifestOf(resolvedPath)) throw new Error("Kein Plugin-Ordner (.claude-plugin/plugin.json fehlt)");
    if (!addedFolders().includes(resolvedPath)) settingsStore.write("plugins.folders", [...addedFolders(), resolvedPath]);
    return pluginStore.list().find((plugin) => plugin.id === `folder:${resolvedPath}`)!;
  },

  removeFolder(pluginId: string): void {
    settingsStore.write("plugins.folders", addedFolders().filter((pluginPath) => `folder:${pluginPath}` !== pluginId));
  },
};

/**
 * Agent options: Claude Code plugins are switched via the flag settings layer (`enabledPlugins`, overrides ~/.claude/settings.json);
 * Desktop and folder plugins are loaded from their directory.
 */
export function agentPluginOptions(): { settings: Settings; plugins: SdkPluginConfig[] } {
  const plugins = pluginStore.list();
  return {
    settings: {
      enabledPlugins: Object.fromEntries(plugins.filter((plugin) => plugin.source === "claude-code").map((plugin) => [plugin.id, plugin.enabled])),
    },
    plugins: plugins.filter((plugin) => plugin.source !== "claude-code" && plugin.enabled).map((plugin) => ({ type: "local", path: plugin.path })),
  };
}
