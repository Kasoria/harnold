import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Project } from "../../db.ts";
import { agentIntegrationOptions } from "../../integrations.ts";
import { agentExtensions } from "../../agent-extensions.ts";
import { createHarnoldToolServers, harnoldAutoAllowedToolNames } from "../../harnold-tools.ts";
import type { ToolDefinition } from "./model-adapters.ts";

/** MCP tools (Harnold's own + the user's servers) as tools for Harnold's agent. */
export type McpToolHandle = ToolDefinition & {
  /** `mcp__<server>__<tool>`, shown in the chat and used for permissions. */
  qualifiedName: string;
  /** Runs without asking (Harnold's low-risk tools, servers the user marked auto-allow). */
  autoAllow: boolean;
  call: (input: Record<string, unknown>, signal: AbortSignal) => Promise<{ text: string; isError: boolean }>;
};

const apiNamePattern = /[^a-zA-Z0-9_-]/g;

export async function connectMcpTools(project: Project, sessionId: string, permissionMode: string): Promise<{ tools: McpToolHandle[]; warnings: string[]; close: () => Promise<void> }> {
  const clients: Client[] = [];
  const tools: McpToolHandle[] = [];
  const warnings: string[] = [];
  const usedApiNames = new Set<string>();
  const integrations = agentIntegrationOptions(project);

  const register = async (serverName: string, client: Client, autoAllowServer: boolean) => {
    const listed = await client.listTools();
    for (const listedTool of listed.tools) {
      const qualifiedName = `mcp__${serverName}__${listedTool.name}`;
      let apiName = qualifiedName.replace(apiNamePattern, "_").slice(0, 64);
      for (let suffix = 2; usedApiNames.has(apiName); suffix++) apiName = `${apiName.slice(0, 60)}_${suffix}`;
      usedApiNames.add(apiName);
      tools.push({
        name: apiName,
        qualifiedName,
        description: listedTool.description ?? listedTool.name,
        inputSchema: (listedTool.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
        autoAllow: autoAllowServer || harnoldAutoAllowedToolNames.includes(qualifiedName),
        call: async (input, signal) => {
          const result = await client.callTool({ name: listedTool.name, arguments: input }, undefined, { signal });
          const content = Array.isArray(result.content) ? result.content : [];
          return {
            text: content.map((block) => (block && typeof block === "object" && "text" in block ? String(block.text) : "[nicht-Text-Inhalt]")).join("\n") || "(keine Ausgabe)",
            isError: Boolean(result.isError),
          };
        },
      });
    }
  };

  // Harnold's own tools: in-process, through a linked in-memory pair.
  for (const [serverName, serverConfig] of Object.entries(createHarnoldToolServers(project, sessionId, permissionMode))) {
    try {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "harnold-agent", version: "1.0.0" });
      await Promise.all([(serverConfig.instance as unknown as { connect: (transport: Transport) => Promise<void> }).connect(serverTransport), client.connect(clientTransport)]);
      clients.push(client);
      await register(serverName, client, false);
    } catch (connectError) {
      warnings.push(`${serverName}: ${connectError instanceof Error ? connectError.message : String(connectError)}`);
    }
  }

  // The user's MCP servers (global and per project).
  // Plus the servers that enabled plugins bring along.
  for (const [serverName, serverConfig] of Object.entries({ ...agentExtensions.pluginMcpServers(), ...integrations.mcpServers })) {
    let transport: Transport | null = null;
    if (serverConfig.type === "stdio" || serverConfig.type === undefined) {
      const inheritedEnvironment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
      transport = new StdioClientTransport({ command: serverConfig.command, args: serverConfig.args, env: { ...inheritedEnvironment, ...serverConfig.env }, cwd: project.path || os.homedir(), stderr: "ignore" });
    } else if (serverConfig.type === "http") transport = new StreamableHTTPClientTransport(new URL(serverConfig.url), { requestInit: { headers: serverConfig.headers } });
    else if (serverConfig.type === "sse") transport = new SSEClientTransport(new URL(serverConfig.url), { requestInit: { headers: serverConfig.headers } });
    if (!transport) continue;
    try {
      const client = new Client({ name: "harnold-agent", version: "1.0.0" });
      await Promise.race([client.connect(transport), new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Zeitüberschreitung (20 s)")), 20_000))]);
      clients.push(client);
      await register(serverName, client, integrations.allowedTools.includes(`mcp__${serverName}`));
    } catch (connectError) {
      warnings.push(`${serverName}: ${connectError instanceof Error ? connectError.message : String(connectError)}`);
    }
  }

  return { tools, warnings, close: async () => void (await Promise.allSettled(clients.map((client) => client.close()))) };
}
