import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectStore, type Project } from "./db.ts";
import { mcpServerStore, type McpServerInput } from "./integrations.ts";
import { t } from "./i18n.ts";

/**
 * MCP servers the user already set up in other AI tools. Claude Code's own (user/project scope, claude.ai connectors)
 * are active in every agent turn anyway; the others can be taken over into Harnold with one click.
 */
export type ExternalMcpSourceId = "claude-code" | "claude-code-project" | "claude-desktop" | "cursor" | "vscode" | "windsurf" | "gemini";
export type ExternalMcpServer = {
  sourceId: ExternalMcpSourceId | "claude-connector";
  sourceLabel: string;
  name: string;
  transport: McpServerInput["transport"];
  /** Command line or URL, for display. */
  target: string;
  /** Already used by the agent without importing (Claude Code loads these itself). */
  activeViaClaude: boolean;
  /** A Harnold server with this name exists. */
  imported: boolean;
  importable: boolean;
};

type RawServer = { type?: string; command?: string; args?: string[]; env?: Record<string, string>; url?: string; serverUrl?: string; httpUrl?: string; headers?: Record<string, string> };
type SourceDefinition = { label: string; activeViaClaude: boolean; read: (project: Project | null) => Record<string, RawServer> };

const homeDirectory = os.homedir();
const applicationSupport = path.join(homeDirectory, "Library", "Application Support");
const claudeConfigDirectory = () => process.env.CLAUDE_CONFIG_DIR ?? homeDirectory;

function readJson(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}
const serversIn = (value: unknown): Record<string, RawServer> => (value && typeof value === "object" ? (value as Record<string, RawServer>) : {});

const sourceDefinitions: Record<ExternalMcpSourceId, SourceDefinition> = {
  "claude-code": { label: "Claude Code", activeViaClaude: true, read: () => serversIn(readJson(path.join(claudeConfigDirectory(), ".claude.json"))?.mcpServers) },
  "claude-code-project": {
    label: "Claude Code (Projekt)",
    activeViaClaude: true,
    read: (project) => {
      if (!project) return {};
      const localServers = serversIn((readJson(path.join(claudeConfigDirectory(), ".claude.json"))?.projects as Record<string, { mcpServers?: unknown }> | undefined)?.[project.path]?.mcpServers);
      return { ...serversIn(readJson(path.join(project.path, ".mcp.json"))?.mcpServers), ...localServers };
    },
  },
  "claude-desktop": { label: "Claude Desktop", activeViaClaude: false, read: () => serversIn(readJson(path.join(applicationSupport, "Claude", "claude_desktop_config.json"))?.mcpServers) },
  cursor: { label: "Cursor", activeViaClaude: false, read: () => serversIn(readJson(path.join(homeDirectory, ".cursor", "mcp.json"))?.mcpServers) },
  vscode: { label: "VS Code", activeViaClaude: false, read: () => serversIn(readJson(path.join(applicationSupport, "Code", "User", "mcp.json"))?.servers) },
  windsurf: { label: "Windsurf", activeViaClaude: false, read: () => serversIn(readJson(path.join(homeDirectory, ".codeium", "windsurf", "mcp_config.json"))?.mcpServers) },
  gemini: { label: "Gemini CLI", activeViaClaude: false, read: () => serversIn(readJson(path.join(homeDirectory, ".gemini", "settings.json"))?.mcpServers) },
};

const harnoldName = (name: string) => name.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "server";

function toInput(name: string, rawServer: RawServer, project: Project | null, sourceId: ExternalMcpSourceId): McpServerInput | null {
  const url = rawServer.url ?? rawServer.httpUrl ?? rawServer.serverUrl;
  const transport: McpServerInput["transport"] | null = rawServer.command ? "stdio" : url ? (rawServer.type === "sse" ? "sse" : "http") : null;
  if (!transport) return null;
  const projectScoped = sourceId === "claude-code-project" && project;
  return {
    name: harnoldName(name),
    scope: projectScoped ? "project" : "workspace",
    projectId: projectScoped ? project.id : null,
    transport,
    command: rawServer.command ?? "",
    args: rawServer.args ?? [],
    url: url ?? "",
    env: rawServer.env ?? {},
    headers: rawServer.headers ?? {},
    autoAllow: false,
    enabled: true,
  };
}

/** Servers Claude Code reported at the start of the last agent turn (incl. claude.ai connectors). */
let lastClaudeReportedServers: { name: string; source?: string; status?: string }[] = [];
export function recordClaudeMcpServers(reportedServers: { name: string; source?: string; status?: string }[]): void {
  lastClaudeReportedServers = reportedServers;
}

export function discoverExternalMcpServers(project: Project | null): ExternalMcpServer[] {
  const harnoldNames = new Set(mcpServerStore.list().map((server) => server.name));
  const discovered: ExternalMcpServer[] = [];
  for (const [sourceId, definition] of Object.entries(sourceDefinitions) as [ExternalMcpSourceId, SourceDefinition][]) {
    for (const [name, rawServer] of Object.entries(definition.read(project))) {
      const serverInput = toInput(name, rawServer, project, sourceId);
      if (!serverInput) continue;
      discovered.push({
        sourceId,
        sourceLabel: definition.label,
        name,
        transport: serverInput.transport,
        target: serverInput.transport === "stdio" ? [serverInput.command, ...serverInput.args].join(" ") : serverInput.url,
        activeViaClaude: definition.activeViaClaude,
        imported: harnoldNames.has(serverInput.name),
        importable: true,
      });
    }
  }
  for (const reportedServer of lastClaudeReportedServers.filter((server) => server.source === "claudeai")) {
    discovered.push({
      sourceId: "claude-connector",
      sourceLabel: "claude.ai-Connector",
      name: reportedServer.name.replace(/^claude\.ai /, ""),
      transport: "http",
      target: reportedServer.status === "needs-auth" ? "Anmeldung in Claude nötig" : "über dein Claude-Konto",
      activeViaClaude: true,
      imported: false,
      importable: false,
    });
  }
  return discovered;
}

/** Copies one server (incl. its env/headers, stored encrypted) into Harnold. */
export function importExternalMcpServer(sourceId: ExternalMcpSourceId, name: string, projectId: string | null): void {
  const definition = sourceDefinitions[sourceId];
  if (!definition) throw new Error(t("Unbekannte Quelle"));
  const project = projectId ? (projectStore.get(projectId) ?? null) : null;
  const rawServer = definition.read(project)[name];
  const serverInput = rawServer && toInput(name, rawServer, project, sourceId);
  if (!serverInput) throw new Error(t("Server „{0}“ nicht gefunden", name));
  mcpServerStore.save(serverInput);
}
