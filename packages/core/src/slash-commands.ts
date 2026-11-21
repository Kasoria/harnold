import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import { settingsStore } from "./settings.ts";
import type { Project } from "./db.ts";

export type AgentCommand = { name: string; description: string; argumentHint: string };

/** Harnold handles these itself or they only make sense in a terminal. */
const hiddenCommandNames = new Set(["clear", "model", "exit", "quit", "statusline", "terminal-setup", "vim", "theme", "config", "login", "logout", "doctor", "ide", "resume", "help", "upgrade", "bug", "feedback", "release-notes", "permissions", "hooks", "keybindings-help", "fast"]);

/** Built-ins of the agent that work over the SDK, used until the agent reported its own list. */
const knownAgentCommands: AgentCommand[] = [
  { name: "compact", description: "Verlauf zusammenfassen, Kontext sparen", argumentHint: "[Fokus]" },
  { name: "context", description: "Kontextverbrauch anzeigen", argumentHint: "" },
  { name: "init", description: "CLAUDE.md für das Projekt anlegen", argumentHint: "" },
  { name: "review", description: "Code-Review der Änderungen", argumentHint: "" },
  { name: "security-review", description: "Sicherheits-Review der Änderungen", argumentHint: "" },
];

const cacheKey = (projectId: string) => `agentCommands.${projectId}`;

function frontmatterDescription(filePath: string): string {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const descriptionLine = /^description:\s*["']?(.+?)["']?\s*$/m.exec(content.split(/^---\s*$/m)[1] ?? "");
    return descriptionLine?.[1] ?? content.replace(/^---[\s\S]*?---/, "").trim().split("\n")[0]?.slice(0, 120) ?? "";
  } catch {
    return "";
  }
}

/** Custom commands and skills on disk – a stand-in before the first turn of a project. */
function scanCommandsOnDisk(project: Project): AgentCommand[] {
  const userDirectory = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  const foundCommands: AgentCommand[] = [];
  for (const baseDirectory of [userDirectory, path.join(project.path, ".claude")]) {
    const commandsDirectory = path.join(baseDirectory, "commands");
    if (fs.existsSync(commandsDirectory)) {
      for (const fileName of fs.readdirSync(commandsDirectory).filter((entryName) => entryName.endsWith(".md"))) {
        foundCommands.push({ name: fileName.replace(/\.md$/, ""), description: frontmatterDescription(path.join(commandsDirectory, fileName)), argumentHint: "" });
      }
    }
    const skillsDirectory = path.join(baseDirectory, "skills");
    if (fs.existsSync(skillsDirectory)) {
      for (const skillName of fs.readdirSync(skillsDirectory)) {
        const skillFile = path.join(skillsDirectory, skillName, "SKILL.md");
        if (fs.existsSync(skillFile)) foundCommands.push({ name: skillName, description: frontmatterDescription(skillFile), argumentHint: "" });
      }
    }
  }
  return foundCommands;
}

export const agentCommands = {
  /** Stores what the agent reported (supportedCommands / commands_changed). */
  remember(projectId: string, reportedCommands: SlashCommand[], terminalOnlyNames: string[] = []): void {
    const terminalOnly = new Set(terminalOnlyNames);
    settingsStore.write(
      cacheKey(projectId),
      reportedCommands
        .filter((command) => !terminalOnly.has(command.name))
        .map((command) => ({ name: command.name, description: command.description, argumentHint: command.argumentHint ?? "" })),
    );
  },

  list(project: Project): AgentCommand[] {
    const reported = settingsStore.read<AgentCommand[]>(cacheKey(project.id), []);
    const germanDescriptions = new Map(knownAgentCommands.map((command) => [command.name, command.description]));
    const merged = new Map<string, AgentCommand>();
    for (const command of [...knownAgentCommands, ...(reported.length ? reported : scanCommandsOnDisk(project))]) {
      if (hiddenCommandNames.has(command.name)) continue;
      merged.set(command.name, { ...command, description: germanDescriptions.get(command.name) ?? command.description });
    }
    return [...merged.values()];
  },
};
