import { randomUUID } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Project } from "./db.ts";
import { config } from "./config.ts";
import { createHarnoldToolServers, harnoldAutoAllowedToolNames } from "./harnold-tools.ts";

/**
 * Harnold's tools over MCP/HTTP for agent programs that cannot run them in-process (Codex …).
 * Every turn registers a random token; the URL is only valid while the turn runs.
 * Only tools that run without asking are served: these programs have no per-call approval in Harnold.
 */
type Registration = { project: Project; sessionId: string; permissionMode: string };
const registrations = new Map<string, Registration>();

const allowedPairs = new Set(harnoldAutoAllowedToolNames.map((qualifiedName) => qualifiedName.replace(/^mcp__/, "")));

type RegisteredToolMap = Record<string, unknown>;

export const harnoldMcp = {
  /** Server name → URL for this turn, plus a release callback for when it ends. */
  register(project: Project, sessionId: string, permissionMode: string): { servers: Record<string, string>; release: () => void } {
    const token = randomUUID();
    registrations.set(token, { project, sessionId, permissionMode });
    const toolServers = createHarnoldToolServers(project, sessionId, permissionMode);
    const servers = Object.fromEntries(
      Object.keys(toolServers)
        // Servers without a single allowed tool (e.g. media: every call costs money) are not offered.
        .filter((serverName) => [...allowedPairs].some((pair) => pair.startsWith(`${serverName}__`)))
        .map((serverName) => [serverName, `http://127.0.0.1:${config.port}/mcp/${token}/${serverName}`]),
    );
    return { servers, release: () => registrations.delete(token) };
  },

  /** One stateless MCP request: a fresh server instance (own tool set, own transport) per call. */
  async handle(token: string, serverName: string, request: Request): Promise<Response> {
    const registration = registrations.get(token);
    const toolServer = registration && (createHarnoldToolServers(registration.project, registration.sessionId, registration.permissionMode) as unknown as Record<string, { instance: { connect: (transport: unknown) => Promise<void>; _registeredTools?: RegisteredToolMap } }>)[serverName];
    if (!registration || !toolServer) return new Response("Not found", { status: 404 });
    const registeredTools = toolServer.instance._registeredTools ?? {};
    for (const toolName of Object.keys(registeredTools)) {
      if (!allowedPairs.has(`${serverName}__${toolName}`)) delete registeredTools[toolName];
    }
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await toolServer.instance.connect(transport);
    return transport.handleRequest(request);
  },
};
