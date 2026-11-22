import { pluginStore } from "./plugins.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { database, projectStore, type Project } from "./db.ts";
import { decryptSecret, encryptSecret } from "./secrets.ts";
import { eventHub } from "./events.ts";
import { settingsStore } from "./settings.ts";
import { t } from "./i18n.ts";

// ---------------------------------------------------------------- MCP servers

database.exec(`
  CREATE TABLE IF NOT EXISTS mcp_servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    scope TEXT NOT NULL,
    project_id TEXT NOT NULL DEFAULT '',
    transport TEXT NOT NULL,
    command TEXT NOT NULL DEFAULT '',
    args TEXT NOT NULL DEFAULT '[]',
    url TEXT NOT NULL DEFAULT '',
    secrets TEXT NOT NULL DEFAULT '',
    auto_allow INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
`);

const reservedServerNames = new Set(["harnold", "harnold_memory", "harnold_media"]);

export const mcpServerInputSchema = z.object({
  name: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,40}$/, "Name: nur Buchstaben, Ziffern, _ und - (max. 40)")
    .refine((serverName) => !reservedServerNames.has(serverName), "Name ist reserviert"),
  scope: z.enum(["workspace", "project"]),
  projectId: z.string().nullable(),
  transport: z.enum(["stdio", "http", "sse"]),
  command: z.string(),
  args: z.array(z.string()),
  url: z.string(),
  /** Values are secret; an empty value keeps the stored one. */
  env: z.record(z.string(), z.string()),
  headers: z.record(z.string(), z.string()),
  autoAllow: z.boolean(),
  enabled: z.boolean(),
});
export type McpServerInput = z.infer<typeof mcpServerInputSchema>;

export type McpServer = Omit<McpServerInput, "env" | "headers"> & {
  id: string;
  env: Record<string, string>;
  headers: Record<string, string>;
  createdAt: number;
};

export type McpServerTestResult = { ok: boolean; testedAt: number; tools: { name: string; description: string }[]; error?: string };

/** Client-facing: secret values replaced by their keys only. */
export type PublicMcpServer = Omit<McpServer, "env" | "headers"> & { envKeys: string[]; headerKeys: string[]; lastTest: McpServerTestResult | null };

type Row = Record<string, unknown>;
type StoredSecrets = { env: Record<string, string>; headers: Record<string, string> };

const mapServer = (row: Row): McpServer => {
  const storedSecrets: StoredSecrets = row.secrets ? JSON.parse(decryptSecret(String(row.secrets))) : { env: {}, headers: {} };
  return {
    id: String(row.id),
    name: String(row.name),
    scope: String(row.scope) as McpServer["scope"],
    projectId: row.project_id ? String(row.project_id) : null,
    transport: String(row.transport) as McpServer["transport"],
    command: String(row.command),
    args: JSON.parse(String(row.args)),
    url: String(row.url),
    env: storedSecrets.env,
    headers: storedSecrets.headers,
    autoAllow: Boolean(row.auto_allow),
    enabled: Boolean(row.enabled),
    createdAt: Number(row.created_at),
  };
};

const lastTestResults = new Map<string, McpServerTestResult>();

export function toPublicMcpServer(server: McpServer): PublicMcpServer {
  const { env, headers, ...rest } = server;
  return { ...rest, envKeys: Object.keys(env), headerKeys: Object.keys(headers), lastTest: lastTestResults.get(server.id) ?? null };
}

/** Keeps stored values for keys submitted empty; drops keys no longer listed. */
function mergeSecretValues(submitted: Record<string, string>, stored: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(submitted)
      .map(([secretKey, secretValue]) => [secretKey.trim(), secretValue || stored[secretKey.trim()] || ""] as const)
      .filter(([secretKey]) => secretKey),
  );
}

function validateServerInput(serverInput: McpServerInput, existingId?: string): void {
  if (serverInput.scope === "project" && !(serverInput.projectId && projectStore.get(serverInput.projectId))) throw new Error(t("Projekt fehlt"));
  if (serverInput.transport === "stdio" && !serverInput.command.trim()) throw new Error(t("Befehl fehlt"));
  if (serverInput.transport !== "stdio" && !/^https?:\/\//.test(serverInput.url.trim())) throw new Error(t("URL muss mit http(s):// beginnen"));
  const duplicate = mcpServerStore
    .list()
    .find(
      (server) =>
        server.id !== existingId &&
        server.name === serverInput.name &&
        server.scope === serverInput.scope &&
        (serverInput.scope === "workspace" || server.projectId === serverInput.projectId),
    );
  if (duplicate) throw new Error(t("Name „{0}“ ist bereits vergeben", serverInput.name));
}

export const mcpServerStore = {
  list(): McpServer[] {
    return (database.prepare("SELECT * FROM mcp_servers ORDER BY created_at").all() as Row[]).map(mapServer);
  },
  get(serverId: string): McpServer | undefined {
    const row = database.prepare("SELECT * FROM mcp_servers WHERE id = ?").get(serverId) as Row | undefined;
    return row ? mapServer(row) : undefined;
  },
  save(serverInput: McpServerInput, serverId?: string): McpServer {
    validateServerInput(serverInput, serverId);
    const existingServer = serverId ? mcpServerStore.get(serverId) : undefined;
    if (serverId && !existingServer) throw new Error(t("Server nicht gefunden"));
    const storedSecrets: StoredSecrets = {
      env: mergeSecretValues(serverInput.env, existingServer?.env ?? {}),
      headers: mergeSecretValues(serverInput.headers, existingServer?.headers ?? {}),
    };
    const id = serverId ?? randomUUID();
    database
      .prepare(
        `INSERT INTO mcp_servers (id, name, scope, project_id, transport, command, args, url, secrets, auto_allow, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, scope = excluded.scope, project_id = excluded.project_id, transport = excluded.transport,
           command = excluded.command, args = excluded.args, url = excluded.url, secrets = excluded.secrets, auto_allow = excluded.auto_allow, enabled = excluded.enabled`,
      )
      .run(
        id,
        serverInput.name,
        serverInput.scope,
        serverInput.scope === "project" ? (serverInput.projectId ?? "") : "",
        serverInput.transport,
        serverInput.command.trim(),
        JSON.stringify(serverInput.args.filter((argument) => argument !== "")),
        serverInput.url.trim(),
        encryptSecret(JSON.stringify(storedSecrets)),
        serverInput.autoAllow ? 1 : 0,
        serverInput.enabled ? 1 : 0,
        existingServer?.createdAt ?? Date.now(),
      );
    lastTestResults.delete(id);
    eventHub.publish({ type: "integrations_changed" });
    return mcpServerStore.get(id)!;
  },
  remove(serverId: string): void {
    database.prepare("DELETE FROM mcp_servers WHERE id = ?").run(serverId);
    lastTestResults.delete(serverId);
    eventHub.publish({ type: "integrations_changed" });
  },

  /** Enabled servers for a project; project servers override workspace servers of the same name. */
  activeFor(projectId: string): McpServer[] {
    const serversByName = new Map<string, McpServer>();
    for (const server of mcpServerStore.list()) {
      if (!server.enabled) continue;
      if (server.scope === "workspace" && !serversByName.has(server.name)) serversByName.set(server.name, server);
    }
    for (const server of mcpServerStore.list()) {
      if (server.enabled && server.scope === "project" && server.projectId === projectId) serversByName.set(server.name, server);
    }
    return [...serversByName.values()];
  },
};

function toAgentConfig(server: McpServer): McpServerConfig {
  if (server.transport === "stdio") return { type: "stdio", command: server.command, args: server.args, env: server.env };
  return { type: server.transport, url: server.url, headers: server.headers };
}

/** Options fragment for `query()`: MCP servers and the tools allowed without asking. */
export function agentIntegrationOptions(project: Project): { mcpServers: Record<string, McpServerConfig>; allowedTools: string[]; skills: string[] | "all" } {
  const activeServers = mcpServerStore.activeFor(project.id);
  return {
    mcpServers: Object.fromEntries(activeServers.map((server) => [server.name, toAgentConfig(server)])),
    allowedTools: activeServers.filter((server) => server.autoAllow).map((server) => `mcp__${server.name}`),
    skills: skillOptionFor(project),
  };
}

/** Connects once, lists the tools, disconnects. */
export async function testMcpServer(server: McpServer): Promise<McpServerTestResult> {
  const project = server.projectId ? projectStore.get(server.projectId) : undefined;
  let transport: Transport;
  if (server.transport === "stdio") {
    const inheritedEnvironment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    transport = new StdioClientTransport({
      command: server.command,
      args: server.args,
      env: { ...inheritedEnvironment, ...server.env },
      cwd: project?.path ?? os.homedir(),
      stderr: "pipe",
    });
  } else {
    const requestInit = { headers: server.headers };
    transport = server.transport === "http" ? new StreamableHTTPClientTransport(new URL(server.url), { requestInit }) : new SSEClientTransport(new URL(server.url), { requestInit });
  }
  const client = new Client({ name: "harnold", version: "0.1.0" });
  let timeoutTimer: NodeJS.Timeout | undefined;
  let testResult: McpServerTestResult;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutTimer = setTimeout(() => reject(new Error(t("Zeitüberschreitung (30 s)"))), 30_000);
    });
    await Promise.race([client.connect(transport), timeout]);
    const toolList = await Promise.race([client.listTools(), timeout]);
    testResult = {
      ok: true,
      testedAt: Date.now(),
      tools: toolList.tools.map((listedTool) => ({ name: listedTool.name, description: (listedTool.description ?? "").split("\n")[0].slice(0, 200) })),
    };
  } catch (testError) {
    testResult = { ok: false, testedAt: Date.now(), tools: [], error: testError instanceof Error ? testError.message : String(testError) };
  } finally {
    clearTimeout(timeoutTimer);
    await client.close().catch(() => undefined);
  }
  lastTestResults.set(server.id, testResult);
  eventHub.publish({ type: "integrations_changed" });
  return testResult;
}

// ---------------------------------------------------------------- Skills (Claude skill format)

export type SkillScope = "user" | "project";
export type Skill = { name: string; description: string; scope: SkillScope; path: string; enabled: boolean };

const skillNamePattern = /^[a-z0-9][a-z0-9-]{0,63}$/;

function skillsRootOf(scope: SkillScope, project: Project | null): string {
  if (scope === "user") return path.join(os.homedir(), ".claude", "skills");
  if (!project) throw new Error(t("Projekt fehlt"));
  return path.join(project.path, ".claude", "skills");
}

function parseFrontmatter(markdown: string): Record<string, string> {
  const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
  const fields: Record<string, string> = {};
  let currentKey: string | null = null;
  for (const line of frontmatter.split(/\r?\n/)) {
    const keyMatch = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (keyMatch) {
      currentKey = keyMatch[1];
      fields[currentKey] = keyMatch[2].replace(/^["']|["']$/g, "").replace(/\\"/g, "\"").replace(/^[>|]-?$/, "");
    } else if (currentKey && /^\s+/.test(line)) {
      fields[currentKey] = `${fields[currentKey]} ${line.trim()}`.trim();
    }
  }
  return fields;
}

const disabledSkillNames = () => new Set(settingsStore.read<string[]>("skills.disabled", []));

function discoverSkills(scope: SkillScope, project: Project | null): Skill[] {
  const skillsRoot = skillsRootOf(scope, project);
  let directoryEntries: fs.Dirent[];
  try {
    directoryEntries = fs.readdirSync(skillsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const disabledNames = disabledSkillNames();
  return directoryEntries.flatMap((entry) => {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) return [];
    const skillFile = path.join(skillsRoot, entry.name, "SKILL.md");
    if (!fs.existsSync(skillFile)) return [];
    const frontmatter = parseFrontmatter(fs.readFileSync(skillFile, "utf8").slice(0, 8_000));
    const name = frontmatter.name || entry.name;
    return [{ name, description: frontmatter.description ?? "", scope, path: entry.name, enabled: !disabledNames.has(name) }];
  });
}

function skillOptionFor(project: Project): string[] | "all" {
  const disabledNames = disabledSkillNames();
  if (!disabledNames.size) return "all";
  // A list hides everything unlisted – so the skills of enabled plugins (`plugin:skill`) are listed too.
  const pluginSkillNames = pluginStore
    .list()
    .filter((plugin) => plugin.enabled)
    .flatMap((plugin) => {
      try {
        return fs.readdirSync(path.join(plugin.path, "skills"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => `${plugin.name}:${entry.name}`);
      } catch {
        return [];
      }
    });
  return [...skillStore.list(project).filter((skill) => skill.enabled).map((skill) => skill.name), ...pluginSkillNames];
}

function resolveSkillFile(scope: SkillScope, project: Project | null, skillDirectory: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(skillDirectory) || skillDirectory.startsWith(".")) throw new Error(t("Ungültiger Skill-Name"));
  return path.join(skillsRootOf(scope, project), skillDirectory, "SKILL.md");
}

export const skillStore = {
  list(project: Project | null): Skill[] {
    const skills = [...(project ? discoverSkills("project", project) : []), ...discoverSkills("user", null)];
    return skills.sort((first, second) => first.name.localeCompare(second.name));
  },
  read(scope: SkillScope, project: Project | null, skillDirectory: string): string {
    return fs.readFileSync(resolveSkillFile(scope, project, skillDirectory), "utf8");
  },
  write(scope: SkillScope, project: Project | null, skillDirectory: string, content: string): void {
    const skillFile = resolveSkillFile(scope, project, skillDirectory);
    fs.mkdirSync(path.dirname(skillFile), { recursive: true });
    fs.writeFileSync(skillFile, content.endsWith("\n") ? content : `${content}\n`);
    eventHub.publish({ type: "integrations_changed" });
  },
  create(scope: SkillScope, project: Project | null, name: string, description: string, instructions: string): void {
    if (!skillNamePattern.test(name)) throw new Error(t("Skill-Name: Kleinbuchstaben, Ziffern und -"));
    const skillFile = resolveSkillFile(scope, project, name);
    if (fs.existsSync(skillFile)) throw new Error(t("Skill „{0}“ existiert bereits", name));
    const escapedDescription = description.replace(/\s+/g, " ").trim().replace(/"/g, '\\"');
    skillStore.write(scope, project, name, `---\nname: ${name}\ndescription: "${escapedDescription}"\n---\n\n${instructions.trim()}\n`);
  },
  setEnabled(skillName: string, enabled: boolean): void {
    const disabledNames = disabledSkillNames();
    if (enabled) disabledNames.delete(skillName);
    else disabledNames.add(skillName);
    settingsStore.write("skills.disabled", [...disabledNames]);
    eventHub.publish({ type: "integrations_changed" });
  },

  remove(scope: SkillScope, project: Project | null, name: string): void {
    fs.rmSync(path.dirname(resolveSkillFile(scope, project, name)), { recursive: true, force: true });
  },
};
