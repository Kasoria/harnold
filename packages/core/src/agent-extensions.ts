import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Project } from "./db.ts";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { skillStore } from "./integrations.ts";
import { pluginStore } from "./plugins.ts";

/**
 * Skills, slash commands and plugin MCP servers in the common format (SKILL.md, commands/*.md, .claude-plugin),
 * for agent programs that don't load them themselves (Harnold's own agent).
 */
export type ExtensionSkill = { name: string; description: string; directory: string; file: string };
export type ExtensionCommand = { name: string; description: string; argumentHint: string; file: string };

const claudeDirectory = () => process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");

function splitFrontmatter(markdown: string): { fields: Record<string, string>; body: string } {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const fields: Record<string, string> = {};
  let currentKey: string | null = null;
  for (const line of (match?.[1] ?? "").split(/\r?\n/)) {
    const keyMatch = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (keyMatch) {
      currentKey = keyMatch[1];
      fields[currentKey] = keyMatch[2].replace(/^["']|["']$/g, "").replace(/^[>|]-?$/, "");
    } else if (currentKey && /^\s+/.test(line)) fields[currentKey] = `${fields[currentKey]} ${line.trim()}`.trim();
  }
  return { fields, body: match ? markdown.slice(match[0].length) : markdown };
}

const readHead = (file: string) => {
  try {
    return fs.readFileSync(file, "utf8").slice(0, 8_000);
  } catch {
    return "";
  }
};

const subdirectories = (directory: string) => {
  try {
    return fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map((entry) => entry.name);
  } catch {
    return [];
  }
};

const markdownFiles = (directory: string) => {
  try {
    return fs.readdirSync(directory).filter((fileName) => fileName.endsWith(".md"));
  } catch {
    return [];
  }
};

function skillsIn(skillsRoot: string, namePrefix = ""): ExtensionSkill[] {
  return subdirectories(skillsRoot).flatMap((directoryName) => {
    const file = path.join(skillsRoot, directoryName, "SKILL.md");
    if (!fs.existsSync(file)) return [];
    const { fields } = splitFrontmatter(readHead(file));
    return [{ name: `${namePrefix}${fields.name || directoryName}`, description: fields.description ?? "", directory: path.dirname(file), file }];
  });
}

function commandsIn(commandsRoot: string, namePrefix = ""): ExtensionCommand[] {
  return markdownFiles(commandsRoot).map((fileName) => {
    const file = path.join(commandsRoot, fileName);
    const { fields, body } = splitFrontmatter(readHead(file));
    return { name: `${namePrefix}${fileName.replace(/\.md$/, "")}`, description: fields.description || body.trim().split("\n")[0]?.slice(0, 120) || "", argumentHint: fields["argument-hint"] ?? "", file };
  });
}

const enabledPlugins = () => pluginStore.list().filter((plugin) => plugin.enabled);

export const agentExtensions = {
  /** Project, user and enabled plugin skills (plugin skills as `plugin:skill`), without the ones switched off. */
  skills(project: Project): ExtensionSkill[] {
    const enabledNames = new Set(skillStore.list(project).filter((skill) => skill.enabled).map((skill) => skill.name));
    const ownSkills = [...(project.path ? skillsIn(path.join(project.path, ".claude", "skills")) : []), ...skillsIn(path.join(claudeDirectory(), "skills"))].filter((skill) =>
      enabledNames.has(skill.name),
    );
    const pluginSkills = enabledPlugins().flatMap((plugin) => skillsIn(path.join(plugin.path, "skills"), `${plugin.name}:`));
    const unique = new Map<string, ExtensionSkill>();
    for (const skill of [...ownSkills, ...pluginSkills]) if (!unique.has(skill.name)) unique.set(skill.name, skill);
    return [...unique.values()];
  },

  commands(project: Project): ExtensionCommand[] {
    return [
      ...(project.path ? commandsIn(path.join(project.path, ".claude", "commands")) : []),
      ...commandsIn(path.join(claudeDirectory(), "commands")),
      ...enabledPlugins().flatMap((plugin) => commandsIn(path.join(plugin.path, "commands"), `${plugin.name}:`)),
    ];
  },

  /** MCP servers that enabled plugins bring along (`.mcp.json`), named `plugin_server`. */
  pluginMcpServers(): Record<string, McpServerConfig> {
    const servers: Record<string, McpServerConfig> = {};
    for (const plugin of enabledPlugins()) {
      const raw = readHead(path.join(plugin.path, ".mcp.json")) || readHead(path.join(plugin.path, ".claude-plugin", ".mcp.json"));
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw.split("${CLAUDE_PLUGIN_ROOT}").join(plugin.path)) as { mcpServers?: Record<string, McpServerConfig> } & Record<string, McpServerConfig>;
        for (const [serverName, serverConfig] of Object.entries(parsed.mcpServers ?? parsed)) {
          if (serverConfig && typeof serverConfig === "object") servers[`${plugin.name}_${serverName}`.replace(/[^a-zA-Z0-9_-]/g, "_")] = serverConfig;
        }
      } catch {
        // A broken .mcp.json only costs that plugin's servers.
      }
    }
    return servers;
  },

  /** Folders a skill may read from (its own files, scripts, references). */
  readableRoots(project: Project): string[] {
    return [path.join(claudeDirectory(), "skills"), ...(project.path ? [path.join(project.path, ".claude")] : []), ...enabledPlugins().map((plugin) => plugin.path)];
  },

  /** Full instructions of a skill (frontmatter removed). */
  readSkill(skill: ExtensionSkill): string {
    const { body } = splitFrontmatter(fs.readFileSync(skill.file, "utf8"));
    return body.split("${CLAUDE_SKILL_DIR}").join(skill.directory).split("${CLAUDE_PLUGIN_ROOT}").join(path.resolve(skill.directory, "..", ".."));
  },

  /** A command's prompt with its arguments filled in ($ARGUMENTS, $1 …). */
  expandCommand(command: ExtensionCommand, argumentText: string): string {
    const { body } = splitFrontmatter(fs.readFileSync(command.file, "utf8"));
    const positional = argumentText.trim() ? argumentText.trim().split(/\s+/) : [];
    const expanded = body.replace(/\$ARGUMENTS/g, argumentText.trim()).replace(/\$(\d)/g, (_match, index: string) => positional[Number(index) - 1] ?? "");
    return expanded.includes(argumentText.trim()) || !argumentText.trim() ? expanded : `${expanded}\n\n${argumentText.trim()}`;
  },
};
