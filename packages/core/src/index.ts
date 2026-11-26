import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import path from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { z } from "zod";
import { config } from "./config.ts";
import { pushWorkspaceToServer, receiveWorkspaceArchive } from "./migration.ts";
import { imagePublished, latestRelease, requestUpdateInstall } from "./update-check.ts";
import { chatItemStore, projectStore, sessionStore } from "./db.ts";
import { eventHub } from "./events.ts";
import { agentRuntime } from "./agent.ts";
import { secretInput } from "./secret-input.ts";
import { sessionActions } from "./session-actions.ts";
import { agentCommands } from "./slash-commands.ts";
import { agentExtensions } from "./agent-extensions.ts";
import { readFileTree, resolveInsideProject, unwatchProject, watchProject } from "./files.ts";
import { canvasDocumentSchema, readCanvas, writeCanvas } from "./canvas.ts";
import { nextRunOf, runTask, scheduleTask, startScheduler, taskStore, unscheduleTask } from "./tasks.ts";
import { folderStore } from "./folders.ts";
import { channelStore, toPublicChannel } from "./channels/store.ts";
import { channelManager } from "./channels/manager.ts";
import { mailActionStore, mailInboxFieldDefinitions, mailInboxInputSchema, mailInboxStore, mailMessageStore, type MailInbox } from "./mail/inbox.ts";
import { mailManager } from "./mail/manager.ts";
import { resolveDraft } from "./mail/tools.ts";
import { synthesize, transcribe, voiceConfig, voiceSecretKeys, voiceSettingsSchema } from "./voice.ts";
import { designSystemStore, importLegacyProjectDesignSystems, virtualDesignSystemsPrefix, watchDesignSystems } from "./design-system.ts";
import { environmentInputSchema, environmentStore } from "./environments.ts";
import { presentProviders } from "./environment-providers.ts";
import { discoverProviderModels, providerInputSchema, providerStore } from "./providers.ts";
import { agentBackends } from "./backends/index.ts";
import { agentBackendSettings, isAgentBackendId, normalizeBackendId } from "./agent-backend-settings.ts";
import { agentRoleSettings } from "./agent-roles.ts";
import { codexAuth, codexSettings } from "./codex-auth.ts";
import { listDevServers, openDevServer, startPreviewProxy } from "./dev-servers.ts";
import { attachTerminal, closeProjectTerminals, closeTerminal, createTerminal, listTerminals, terminalAvailable, type TerminalClientMessage } from "./terminal.ts";
import { gitBranches, gitCommit, gitCreateBranch, gitDiff, gitDiscard, gitInit, gitLog, gitPull, gitPush, gitStage, gitStatus, gitSwitch, gitUnstage } from "./git.ts";
import { listProjectRoots, readRootDirectory, repositoryTopLevel, resolveInsideProjectRoot, resolveProjectRoot } from "./project-roots.ts";
import { applySessionWorktree, createSessionWorktree, removeSessionWorktree, sessionWorktreeStatus } from "./worktrees.ts";
import { harnoldMcp } from "./mcp-http.ts";
import { agentModelSettings, claudeAuth, claudeProfileForEnvironment, claudeSettingsSchema, defaultClaudeProfile } from "./claude-auth.ts";
import { agentRuntimes } from "./agent-runtimes.ts";
import { teamAgentInputSchema, teamStore } from "./agents.ts";
import { generateImages, imageConfig, imageRequestSchema, imageSecretKeys, imageSettingsSchema } from "./image-generation.ts";
import { mcpServerInputSchema, mcpServerStore, skillStore, testMcpServer, toPublicMcpServer } from "./integrations.ts";
import { memoryConfig, memoryIndex, memoryNotes, memorySettingsSchema, startMemory } from "./memory.ts";
import { deleteExpiredQuickChats, quickChatProject, quickChatSettings, startQuickChatCleanup } from "./quick-chats.ts";
import { pluginStore } from "./plugins.ts";
import { discoverExternalMcpServers, importExternalMcpServer } from "./mcp-discovery.ts";
import { saveAttachment } from "./attachments.ts";
import { memoryFiles } from "./memory-files.ts";
import { createProjectRecord } from "./setup-tools.ts";
import { managedFiles, resolveManagedFile } from "./managed-files.ts";
import { languageSettings, parseLanguage, runWithLanguage, t } from "./i18n.ts";

const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

const mimeTypesByExtension: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".pdf": "application/pdf",
  ".csv": "text/csv; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

// Messages in the language of the app that sent the request.
app.use("*", (context, next) => runWithLanguage(parseLanguage(context.req.header("x-harnold-language")) ?? languageSettings.read(), next));

// --- Origin guard (browser attacks: DNS rebinding, cross-origin fetch/WebSocket) ---
// Browsers can be tricked into calling a localhost API from a remote page. Only browser requests
// that are same-origin (localhost family) may pass; non-browser clients (curl, agent programs,
// Node's fetch) send no Origin/Sec-Fetch-Site header and stay allowed – the access token remains
// the gate for those. This middleware also covers the /ws WebSocket handshake.
// A local Core is only reachable through a loopback name. DNS rebinding makes the browser talk to
// 127.0.0.1 while the Host header still says the attacker's domain – so the Host has to be checked too.
const isLoopbackHostname = (hostname: string) => hostname === "::1" || hostname === "localhost" || /^127\./.test(hostname);
const boundToLoopbackOnly = isLoopbackHostname(config.host.toLowerCase());

const originHostname = (origin: string): string | null => {
  try {
    return new URL(origin).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return null;
  }
};

/**
 * Server mode (HARNOLD_TOKEN set): the desktop app loads its UI from its own local Core (a loopback origin) and talks to this
 * remote Core, so those requests are cross-origin by design. Safe because every request needs the token explicitly
 * (Authorization header / ?token=, never cookies), and only loopback origins are let through. Without a token the strict
 * guard below applies.
 */
const isDesktopAppOrigin = (origin: string): boolean => {
  if (!config.accessToken) return false;
  const hostname = originHostname(origin);
  return hostname !== null && isLoopbackHostname(hostname);
};

app.use("*", cors({
  origin: (origin) => (isDesktopAppOrigin(origin) ? origin : null),
  allowHeaders: ["authorization", "content-type", "x-harnold-language"],
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  maxAge: 600,
}));

function isTrustedBrowserRequest(context: { req: { header: (name: string) => string | undefined } }): boolean {
  const origin = context.req.header("origin");
  const fetchSite = context.req.header("sec-fetch-site");
  if (fetchSite === "cross-site") return Boolean(config.accessToken) && (!origin || isDesktopAppOrigin(origin));
  const hostHeader = (context.req.header("host") ?? "").toLowerCase().replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  if (boundToLoopbackOnly && hostHeader && !isLoopbackHostname(hostHeader)) return false;
  if (!origin) return true; // not sent by browsers for same-origin GETs and by non-browser clients
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }
  // Same origin as the request itself (also correct behind a reverse proxy in server mode).
  if (originUrl.host.toLowerCase() === (context.req.header("host") ?? "").toLowerCase()) return true;
  return isLoopbackHostname(originUrl.hostname.replace(/^\[|\]$/g, "").toLowerCase());
}

app.use("*", async (context, next) => {
  if (!isTrustedBrowserRequest(context)) return context.json({ error: t("Nicht autorisiert") }, 403);
  await next();
});

// --- Auth (only active when HARNOLD_TOKEN is set) ---
app.use("*", async (context, next) => {
  // /mcp/<token>/… is called by agent programs on this machine; the one-turn token in the URL is its secret.
  if (!config.accessToken || context.req.path.startsWith("/mcp/")) return next();
  // The UI shell (HTML/JS/CSS) is public code without data: it must load so the UI can ask for the token.
  const isDataPath = /^\/(api|ws|preview|design-systems)(\/|$)/.test(context.req.path);
  if (context.req.method === "GET" && !isDataPath) return next();
  const bearerToken = context.req.header("authorization")?.replace(/^Bearer /, "");
  const queryToken = context.req.query("token");
  if (bearerToken === config.accessToken || queryToken === config.accessToken) return next();
  return context.json({ error: t("Nicht autorisiert") }, 401);
});

/** Token check for the login screen: passes the auth middleware above only with a valid token (or none required). */
app.get("/api/auth/check", (context) => context.json({ ok: true, tokenRequired: Boolean(config.accessToken) }));

/** Server mode: tells the UI whether a newer release exists (and, for Docker, whether its image is already published). */
app.get("/api/update-check", async (context) => {
  const deployment = process.env.HARNOLD_DEPLOYMENT ?? "local";
  let latest = await latestRelease(context.req.query("fresh") === "1");
  if (latest && deployment === "docker" && !(await imagePublished(latest.version))) latest = null;
  return context.json({ deployment, latest, canInstall: Boolean(process.env.HARNOLD_UPDATER_URL) });
});

/** Docker server: the update sidecar pulls the new image and restarts this container. */
app.post("/api/update-install", async (context) => {
  try {
    await requestUpdateInstall();
    return context.json({ ok: true });
  } catch (installError) {
    return context.json({ error: installError instanceof Error ? installError.message : String(installError) }, 502);
  }
});

/** Local core: sends this whole workspace (projects, chats, memory, settings, secrets, agent configuration) to a server core. */
app.post("/api/migration/push", async (context) => {
  const { serverUrl, token, includeAgentConfiguration, includeAgentTranscripts } = z
    .object({ serverUrl: z.string().min(1), token: z.string().default(""), includeAgentConfiguration: z.boolean().default(true), includeAgentTranscripts: z.boolean().default(true) })
    .parse(await context.req.json());
  return context.json({ ok: true, ...(await pushWorkspaceToServer(serverUrl, token, { includeConfiguration: includeAgentConfiguration, includeTranscripts: includeAgentTranscripts })) });
});

/** Server core: takes a workspace archive and restarts to swap it in (the old data is kept as a backup). */
app.post("/api/migration/import", async (context) => {
  // Only where a supervisor restarts the core (Docker server); the desktop app's core would just end.
  if (process.env.HARNOLD_DEPLOYMENT !== "docker") return context.json({ error: t("Nur auf einem Docker-Server möglich") }, 400);
  await receiveWorkspaceArchive(context.req.raw.body);
  setTimeout(() => process.exit(0), 500); // Docker (restart: unless-stopped) starts the core again; it applies the import first
  return context.json({ ok: true });
});

// Errors: the full error goes to the log; the client gets the message with filesystem paths
// removed (a stack trace or an absolute path helps an attacker, not the user).
const redactPaths = (message: string): string => {
  // Absolute paths, and the home-relative form they turn into below, say nothing to the user.
  return message
    .split(os.homedir()).join("~")
    .replace(/(?:^|[\s("'`=])((?:~|\/)[\w.@+-]*(?:\/[\w.@+-]+)+)/g, (_match, pathLike: string) => (pathLike.includes("/node_modules/") ? " node_modules/…" : " …"))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
};

app.onError((requestError, context) => {
  console.error("[api]", requestError);
  // Validation errors are about the request itself – field names are safe and useful.
  if (requestError instanceof z.ZodError) {
    const issues = requestError.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ");
    return context.json({ error: redactPaths(issues) }, 400);
  }
  return context.json({ error: redactPaths(requestError.message) || t("Unbekannter Fehler") }, 400);
});

const requireProject = (projectId: string) => {
  const project = projectStore.get(projectId);
  if (!project) throw new Error(t("Projekt nicht gefunden"));
  return project;
};

// --- Projects ---
app.get("/api/projects", (context) => context.json(projectStore.list()));

app.post("/api/projects", async (context) => {
  const body = z
    .object({ name: z.string().min(1), path: z.string().optional(), environmentId: z.string().nullable().optional() })
    .parse(await context.req.json());
  return context.json(createProjectRecord(body.name, body.path, body.environmentId));
});

app.patch("/api/projects/:projectId", async (context) => {
  const project = requireProject(context.req.param("projectId"));
  const body = z.object({ name: z.string().trim().min(1).optional(), icon: z.string().trim().max(40).nullable().optional() }).parse(await context.req.json());
  projectStore.update(project.id, { name: body.name, icon: body.icon === "" ? null : body.icon });
  return context.json(projectStore.get(project.id));
});

app.delete("/api/projects/:projectId", (context) => {
  if (requireProject(context.req.param("projectId")).kind === "quick") throw new Error(t("Quick Chats lassen sich nicht entfernen"));
  // Removes only Harnold's record; the folder on disk stays untouched.
  unwatchProject(context.req.param("projectId"));
  environmentStore.assignProject(context.req.param("projectId"), null);
  for (const task of taskStore.list().filter((candidate) => candidate.projectId === context.req.param("projectId"))) {
    unscheduleTask(task.id);
    taskStore.remove(task.id);
  }
  eventHub.publish({ type: "tasks_changed" });
  folderStore.removeOwner("project", context.req.param("projectId"));
  closeProjectTerminals(context.req.param("projectId"));
  projectStore.remove(context.req.param("projectId"));
  return context.json({ ok: true });
});

/** Desktop: shows the project folder in Finder / the file manager of the machine the Core runs on. */
app.post("/api/projects/:projectId/reveal", (context) => {
  const project = requireProject(context.req.param("projectId"));
  const [command, args] = process.platform === "darwin" ? ["open", [project.path]] : process.platform === "win32" ? ["explorer", [project.path]] : ["xdg-open", [project.path]];
  spawn(command, args, { detached: true, stdio: "ignore" }).on("error", () => undefined).unref();
  return context.json({ ok: true });
});

// --- Files ---
app.get("/api/projects/:projectId/tree", (context) =>
  context.json(readFileTree(requireProject(context.req.param("projectId")))),
);

/** The folders the project consists of (project folder, attached folders, chat worktrees) with their repositories. */
app.get("/api/projects/:projectId/roots", async (context) => context.json(await listProjectRoots(requireProject(context.req.param("projectId")))));

/** One level of a project folder (the file panel loads deeper levels on expand). */
app.get("/api/projects/:projectId/directory", (context) => {
  const project = requireProject(context.req.param("projectId"));
  return context.json(readRootDirectory(resolveProjectRoot(project, context.req.query("root")), context.req.query("path") ?? ""));
});

// ?root= reads/writes in one of the project's folders; without it, the project folder.
app.get("/api/projects/:projectId/file", (context) => {
  const project = requireProject(context.req.param("projectId"));
  const absolutePath = resolveInsideProjectRoot(project, context.req.query("root"), context.req.query("path") ?? "");
  if ((fs.statSync(absolutePath, { throwIfNoEntry: false })?.size ?? 0) > 5 * 1024 * 1024) throw new Error(t("Datei ist zu groß für den Editor."));
  return context.json({ content: fs.readFileSync(absolutePath, "utf8") });
});

app.put("/api/projects/:projectId/file", async (context) => {
  const project = requireProject(context.req.param("projectId"));
  const body = z.object({ path: z.string().min(1), content: z.string(), root: z.string().optional() }).parse(await context.req.json());
  const absolutePath = resolveInsideProjectRoot(project, body.root, body.path);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, body.content);
  return context.json({ ok: true });
});

// --- Canvas ---
app.get("/api/projects/:projectId/canvas", (context) => context.json(readCanvas(requireProject(context.req.param("projectId")))));

app.put("/api/projects/:projectId/canvas", async (context) => {
  const project = requireProject(context.req.param("projectId"));
  writeCanvas(project, canvasDocumentSchema.parse(await context.req.json()));
  return context.json({ ok: true });
});

// Live preview: serves project files as-is so HTML artifacts render with their relative assets.
app.get("/preview/:projectId/*", (context) => {
  const project = requireProject(context.req.param("projectId"));
  const relativePath = decodeURIComponent(context.req.path.split("/").slice(3).join("/"));
  // Both resolvers follow no symlinks: resolving the file (not just the folder) is what makes this safe.
  const resolvePreviewPath = (previewPath: string): string => {
    if (!previewPath.startsWith(virtualDesignSystemsPrefix)) return resolveInsideProject(project, previewPath);
    // Linked design systems appear inside every project under _harnold/design-systems/<id>/
    const [designSystemId, ...fileSegments] = previewPath.slice(virtualDesignSystemsPrefix.length).split("/");
    return designSystemStore.resolveFile(designSystemId, fileSegments.join("/"));
  };
  let absolutePath = resolvePreviewPath(relativePath);
  if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isDirectory()) absolutePath = resolvePreviewPath(`${relativePath.replace(/\/+$/, "")}/index.html`);
  if (!fs.existsSync(absolutePath)) return context.text("Nicht gefunden", 404);
  const contentType = mimeTypesByExtension[path.extname(absolutePath).toLowerCase()] ?? "application/octet-stream";
  return context.body(fs.readFileSync(absolutePath), 200, { "content-type": contentType, "cache-control": "no-store" });
});

// --- Sessions ---
app.get("/api/projects/:projectId/sessions", (context) =>
  context.json(
    sessionStore
      .listByProject(context.req.param("projectId"))
      .map((session) => ({ ...session, running: agentRuntime.isRunning(session.id) })),
  ),
);

/** "New session" reuses a still empty session of the project instead of piling up empty ones. */
/** Reuses an unused empty session (switching it to the requested team agent) or creates one. */
function emptyOrNewSession(projectId: string, agentId: string | null = null) {
  if (agentId && !teamStore.forProject(projectId).some((agent) => agent.id === agentId)) throw new Error(t("Agent gehört nicht zum Team dieses Projekts"));
  const emptySession = sessionStore
    .listByProject(projectId)
    .find((session) => !session.agentSessionId && !session.forkOriginSessionId && !agentRuntime.isRunning(session.id) && chatItemStore.list(session.id).length === 0 && !session.title.startsWith("Team · ") && !session.taskId && !session.mailInboxId);
  if (emptySession) {
    if (emptySession.agentId !== agentId) {
      sessionStore.update(emptySession.id, { agentId });
      eventHub.publish({ type: "sessions_changed", projectId });
    }
    return sessionStore.get(emptySession.id)!;
  }
  const session = sessionStore.create(projectId, "Neue Session", undefined, agentId);
  eventHub.publish({ type: "sessions_changed", projectId });
  return session;
}

/** Folders added to a chat: absolute, existing, without duplicates (`~` = home). */
function chatDirectories(requestedDirectories: string[]): string[] {
  const resolved = requestedDirectories.map((directory) => path.resolve(directory.replace(/^~(?=$|\/)/, os.homedir())));
  for (const directory of resolved) {
    if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) throw new Error(t("Ordner nicht gefunden: {0}", directory));
  }
  return [...new Set(resolved)];
}

app.post("/api/projects/:projectId/sessions", async (context) => {
  const body = z.object({ agentId: z.string().nullish() }).parse(await context.req.json().catch(() => ({})));
  return context.json(emptyOrNewSession(requireProject(context.req.param("projectId")).id, body.agentId ?? null));
});

// --- Team (several agents per environment) ---
app.get("/api/team", (context) => context.json(teamStore.list()));
app.post("/api/team", async (context) => context.json(teamStore.save(teamAgentInputSchema.parse(await context.req.json()))));
app.put("/api/team/:agentId", async (context) => context.json(teamStore.save(teamAgentInputSchema.parse(await context.req.json()), context.req.param("agentId"))));
app.delete("/api/team/:agentId", (context) => {
  teamStore.remove(context.req.param("agentId"));
  return context.json({ ok: true });
});

// --- Quick Chats (no project) ---
app.post("/api/quick-chats", (context) => context.json(emptyOrNewSession(quickChatProject().id)));

app.get("/api/settings/quick-chats", (context) => context.json(quickChatSettings.read()));
app.put("/api/settings/quick-chats", async (context) => {
  const body = z.object({ autoDeleteDays: z.number().int().min(1).max(3650).nullable() }).parse(await context.req.json());
  quickChatSettings.write(body);
  deleteExpiredQuickChats();
  return context.json(quickChatSettings.read());
});

// Files only this conversation refers to – offered (opt-in) for deletion together with the session.
app.get("/api/sessions/:sessionId/exclusive-files", (context) => context.json(managedFiles.exclusiveToConversation(context.req.param("sessionId"))));

app.delete("/api/sessions/:sessionId", (context) => {
  const session = sessionStore.get(context.req.param("sessionId"));
  if (session) {
    agentRuntime.clearQueue(session.id);
    agentRuntime.interrupt(session.id);
    agentRuntime.release(session.id);
    // Opt-in only: ?deleteFiles=1 also removes attachments/images no other session or design file uses.
    if (context.req.query("deleteFiles") === "1") managedFiles.remove(managedFiles.exclusiveToConversation(session.id).map((file) => file.id));
    sessionStore.remove(session.id);
    eventHub.publish({ type: "sessions_changed", projectId: session.projectId });
  }
  return context.json({ ok: true });
});

app.patch("/api/sessions/:sessionId", async (context) => {
  const body = z
    .object({ title: z.string().min(1).optional(), projectId: z.string().optional(), agentId: z.string().nullable().optional(), directories: z.array(z.string().trim().min(1)).max(20).optional(), model: z.string().nullable().optional() })
    .parse(await context.req.json());
  const sessionId = context.req.param("sessionId");
  if (body.title) sessionActions.rename(sessionId, body.title);
  if (body.directories) {
    const session = sessionStore.get(sessionId);
    if (!session) throw new Error(t("Session nicht gefunden"));
    sessionStore.update(sessionId, { directories: chatDirectories(body.directories) });
    eventHub.publish({ type: "sessions_changed", projectId: session.projectId });
  }
  if (body.model !== undefined) {
    const session = sessionStore.get(sessionId);
    if (!session) throw new Error(t("Session nicht gefunden"));
    sessionStore.update(sessionId, { model: body.model || null });
    eventHub.publish({ type: "sessions_changed", projectId: session.projectId });
  }
  if (body.agentId !== undefined) {
    const session = sessionStore.get(sessionId);
    if (!session) throw new Error(t("Session nicht gefunden"));
    if (body.agentId && !teamStore.forProject(session.projectId).some((agent) => agent.id === body.agentId)) throw new Error(t("Agent gehört nicht zum Team dieses Projekts"));
    // A different agent = a different persona: the next turn starts a fresh agent context, the timeline stays.
    sessionStore.update(sessionId, { agentId: body.agentId, agentSessionId: null });
    eventHub.publish({ type: "sessions_changed", projectId: session.projectId });
  }
  const moveResult = body.projectId ? sessionActions.move(sessionId, body.projectId) : { deferred: false };
  return context.json({ ok: true, ...moveResult });
});

// --- Folders with access (memory levels) ---
const folderScopeSchema = z.enum(["project", "environment", "workspace"]);

/** Owner of a folder level: project id, environment id, or "" for the workspace. */
function folderOwnerId(scope: "project" | "environment" | "workspace", projectId: string | null): string {
  if (scope === "workspace") return "";
  const project = requireProject(projectId ?? "");
  if (scope === "project") return project.id;
  const environment = environmentStore.forProject(project.id);
  if (!environment) throw new Error(t("Projekt gehört zu keiner Umgebung"));
  return environment.id;
}

function foldersForProject(projectId: string | null) {
  const environment = projectId ? environmentStore.forProject(projectId) : undefined;
  return {
    project: projectId ? folderStore.list("project", projectId) : [],
    environment: environment ? folderStore.list("environment", environment.id) : [],
    workspace: folderStore.list("workspace", ""),
  };
}

app.get("/api/folders", (context) => context.json(foldersForProject(context.req.query("projectId") || null)));

app.post("/api/folders", async (context) => {
  const body = z.object({ scope: folderScopeSchema, projectId: z.string().nullish(), path: z.string().trim().min(1) }).parse(await context.req.json());
  const addedFolder = folderStore.add(body.scope, folderOwnerId(body.scope, body.projectId ?? null), body.path);
  eventHub.publish({ type: "folders_changed" });
  return context.json(addedFolder);
});

app.delete("/api/folders", (context) => {
  const scope = folderScopeSchema.parse(context.req.query("scope"));
  folderStore.remove(scope, folderOwnerId(scope, context.req.query("projectId") || null), context.req.query("path") ?? "");
  eventHub.publish({ type: "folders_changed" });
  return context.json({ ok: true });
});

app.post("/api/sessions/:sessionId/clear", (context) => {
  sessionActions.clear(context.req.param("sessionId"));
  return context.json({ ok: true });
});

app.get("/api/projects/:projectId/commands", (context) => {
  const project = requireProject(context.req.param("projectId"));
  // Harnold's own agent: the commands and skills it expands itself.
  if (environmentStore.backendFor(project.id) === "native")
    return context.json([
      ...agentExtensions.commands(project).map(({ name, description, argumentHint }) => ({ name, description, argumentHint })),
      ...agentExtensions.skills(project).map(({ name, description }) => ({ name, description, argumentHint: "" })),
    ]);
  return context.json(agentCommands.list(project));
});

app.get("/api/sessions/:sessionId/items", (context) => context.json(chatItemStore.list(context.req.param("sessionId"))));

const permissionModeSchema = z.enum(["default", "acceptEdits", "bypassPermissions", "plan"]);
const attachmentSchema = z.object({ path: z.string().min(1), name: z.string().min(1), mimeType: z.string(), size: z.number() });

// Files attached to a chat message (multipart field "files"); stored under attachments/ in the project.
app.post("/api/projects/:projectId/attachments", async (context) => {
  const project = requireProject(context.req.param("projectId"));
  const formBody = await context.req.parseBody({ all: true });
  const uploadedFiles = [formBody.files].flat().filter((entry): entry is File => entry instanceof File);
  if (!uploadedFiles.length) throw new Error(t("Keine Datei erhalten"));
  const attachments = await Promise.all(
    uploadedFiles.map(async (uploadedFile) => saveAttachment(project, uploadedFile.name, uploadedFile.type, Buffer.from(await uploadedFile.arrayBuffer()))),
  );
  return context.json(attachments);
});

app.post("/api/sessions/:sessionId/messages", async (context) => {
  const body = z
    .object({
      text: z.string(),
      permissionMode: permissionModeSchema.default("default"),
      model: z.string().optional(),
      effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
      attachments: z.array(attachmentSchema).max(20).optional(),
    })
    .refine((body) => body.text.trim() || body.attachments?.length, "Nachricht ist leer")
    .parse(await context.req.json());
  const sessionId = context.req.param("sessionId");
  const session = sessionStore.get(sessionId);
  if (!session) throw new Error(t("Session nicht gefunden"));
  // While a turn runs, the message waits in the queue and starts afterwards.
  if (agentRuntime.isRunning(sessionId)) {
    // Like the Claude desktop app: the running turn picks the message up; otherwise it waits in the queue.
    if (agentRuntime.steer({ sessionId, ...body })) return context.json({ ok: true, steered: true });
    return context.json({ ok: true, queued: agentRuntime.enqueue({ sessionId, ...body }) });
  }
  await agentRuntime.assertReady(sessionId); // friendly error when the agent program is missing or not signed in
  void agentRuntime.runTurn({ sessionId, ...body }).catch((turnError) => console.error("[agent]", turnError));
  return context.json({ ok: true });
});

app.post("/api/sessions/:sessionId/rewind-files", async (context) => {
  const body = z.object({ itemId: z.string().min(1), dryRun: z.boolean().default(false) }).parse(await context.req.json());
  return context.json(await agentRuntime.rewindFiles(context.req.param("sessionId"), body.itemId, body.dryRun));
});

app.get("/api/sessions/:sessionId/background-tasks", (context) => context.json(agentRuntime.backgroundTasksFor(context.req.param("sessionId"))));

app.post("/api/sessions/:sessionId/background-tasks/:taskId/stop", async (context) => {
  await agentRuntime.stopBackgroundTask(context.req.param("sessionId"), context.req.param("taskId"));
  return context.json({ ok: true });
});

app.get("/api/sessions/:sessionId/context", async (context) =>
  context.json(await agentRuntime.measureContext(context.req.param("sessionId"), context.req.query("model") || undefined)),
);

app.get("/api/sessions/:sessionId/queue", (context) => context.json(agentRuntime.queueFor(context.req.param("sessionId"))));

app.delete("/api/sessions/:sessionId/queue/:queuedMessageId", (context) => {
  agentRuntime.removeQueued(context.req.param("sessionId"), context.req.param("queuedMessageId"));
  return context.json({ ok: true });
});

app.post("/api/sessions/:sessionId/queue/:queuedMessageId/send-now", (context) => {
  agentRuntime.sendQueuedNow(context.req.param("sessionId"), context.req.param("queuedMessageId"));
  return context.json({ ok: true });
});

/** Edit a sent message: new version of the conversation from that message on, then run it. */
app.post("/api/sessions/:sessionId/edit", async (context) => {
  const body = z
    .object({ itemId: z.string(), text: z.string().min(1), permissionMode: permissionModeSchema.default("default"), model: z.string().optional() })
    .parse(await context.req.json());
  const session = sessionStore.get(context.req.param("sessionId"));
  if (!session) throw new Error(t("Session nicht gefunden"));
  await environmentStore.agentSetupFor(session.projectId);
  const editedItem = chatItemStore.list(session.id).find((chatItem) => chatItem.id === body.itemId);
  const forkedSession = sessionActions.forkForEdit(session.id, body.itemId);
  void agentRuntime
    .runTurn({
      sessionId: forkedSession.id,
      text: body.text,
      permissionMode: body.permissionMode,
      model: body.model,
      // The edit changes the text; files attached to the original message stay attached.
      attachments: editedItem?.kind === "user_text" ? editedItem.attachments : undefined,
    })
    .catch((turnError) => console.error("[agent]", turnError));
  return context.json(forkedSession);
});

app.post("/api/sessions/:sessionId/interrupt", (context) => {
  agentRuntime.interrupt(context.req.param("sessionId"));
  return context.json({ ok: true });
});

// --- Today: what needs attention right now ---
app.get("/api/today", (context) => {
  const sessionInfo = (sessionId: string | null) => {
    const session = sessionId ? sessionStore.get(sessionId) : undefined;
    return session ? { sessionId: session.id, sessionTitle: session.title, projectId: session.projectId, projectName: projectStore.get(session.projectId)?.name ?? "" } : null;
  };
  const recentSessions = projectStore
    .list()
    // Task runs are shown as task results, not as chats to continue.
    .flatMap((project) => sessionStore.listByProject(project.id).filter((session) => !session.taskId).slice(0, 3))
    .sort((first, second) => second.updatedAt - first.updatedAt)
    .slice(0, 24)
    .map((session) => ({ ...sessionInfo(session.id)!, updatedAt: session.updatedAt }));
  return context.json({
    waiting: agentRuntime.listPendingPermissions().flatMap((pending) => {
      const info = sessionInfo(pending.sessionId);
      return info ? [{ ...pending, ...info }] : [];
    }),
    running: agentRuntime.listRunningSessionIds().flatMap((sessionId) => {
      const info = sessionInfo(sessionId);
      return info ? [info] : [];
    }),
    taskResults: taskStore
      .listRecentRuns(Date.now() - 24 * 60 * 60 * 1000)
      .filter((taskRun) => taskRun.status !== "running")
      .slice(0, 5)
      .map((taskRun) => ({ ...taskRun, taskName: taskStore.get(taskRun.taskId)?.name ?? "Task", session: sessionInfo(taskRun.sessionId) })),
    recentSessions,
  });
});

// The value only lives in this request: it is stored in the environment and never echoed back.
app.post("/api/secret-input/:requestId", async (context) => {
  const body = z.object({ value: z.string().optional() }).parse(await context.req.json());
  const requestId = context.req.param("requestId");
  const done = body.value?.trim() ? secretInput.submit(requestId, body.value.trim()) : secretInput.cancel(requestId);
  return context.json({ ok: done });
});

app.post("/api/permissions/:requestId", async (context) => {
  const body = z
    .object({
      allow: z.boolean(),
      answers: z.record(z.string(), z.string()).optional(),
      always: z.boolean().optional(),
      permissionMode: permissionModeSchema.optional(),
      message: z.string().max(10_000).optional(),
    })
    .parse(await context.req.json());
  return context.json({ ok: agentRuntime.resolvePermission(context.req.param("requestId"), body) });
});

// --- Tasks ---
const taskInputSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().min(1),
  prompt: z.string().min(1),
  schedule: z.string().min(1),
  enabled: z.boolean(),
  permissionMode: permissionModeSchema,
  model: z.string().nullable(),
  /** Agent program of the runs; null = the project's environment, else the workspace default. */
  backendId: z.string().trim().nullable().default(null).transform(normalizeBackendId),
  agentId: z.string().nullable().default(null),
  sessionMode: z.enum(["new", "continue"]).default("new"),
  cleanupAfterDays: z.number().int().min(1).max(3650).nullable().default(null),
  contextResetRuns: z.number().int().min(1).max(10000).nullable().default(null),
  directories: z.array(z.string().trim().min(1)).max(20).default([]),
  notifyChannelId: z.string().nullable(),
  notifyChatId: z.string().nullable(),
});

const presentTask = (task: ReturnType<typeof taskStore.list>[number]) => ({
  ...task,
  nextRunAt: nextRunOf(task),
  lastRun: taskStore.lastRun(task.id) ?? null,
});

app.get("/api/tasks", (context) => context.json(taskStore.list().map(presentTask)));

app.post("/api/tasks", async (context) => {
  const task = taskStore.save(taskInputSchema.parse(await context.req.json()));
  scheduleTask(task);
  eventHub.publish({ type: "tasks_changed" });
  return context.json(presentTask(task));
});

app.put("/api/tasks/:taskId", async (context) => {
  const taskId = context.req.param("taskId");
  if (!taskStore.get(taskId)) throw new Error(t("Task nicht gefunden"));
  const task = taskStore.save(taskInputSchema.parse(await context.req.json()), taskId);
  scheduleTask(task);
  eventHub.publish({ type: "tasks_changed" });
  return context.json(presentTask(task));
});

app.delete("/api/tasks/:taskId", (context) => {
  unscheduleTask(context.req.param("taskId"));
  taskStore.remove(context.req.param("taskId"));
  eventHub.publish({ type: "tasks_changed" });
  return context.json({ ok: true });
});

app.post("/api/tasks/:taskId/run", (context) => {
  void runTask(context.req.param("taskId")).catch((runError) => console.error("[tasks]", runError));
  return context.json({ ok: true });
});

app.get("/api/tasks/:taskId/runs", (context) => context.json(taskStore.listRuns(context.req.param("taskId"))));

// Task results are theirs to clear: a single run (incl. its session) or all finished runs of a task.
app.delete("/api/task-runs/:runId", (context) => {
  const removed = taskStore.removeRun(context.req.param("runId"));
  if (removed) {
    eventHub.publish({ type: "tasks_changed" });
    eventHub.publish({ type: "today_changed" });
  }
  return context.json({ ok: removed });
});

app.delete("/api/tasks/:taskId/runs", (context) => {
  const removed = taskStore.removeFinishedRuns(context.req.param("taskId"));
  eventHub.publish({ type: "tasks_changed" });
  if (removed) eventHub.publish({ type: "today_changed" });
  return context.json({ removed });
});

// --- Channels ---
const channelInputSchema = z.object({
  type: z.enum(["telegram", "discord", "slack", "email"]),
  name: z.string().min(1),
  scope: z.enum(["project", "workspace"]).default("project"),
  projectId: z.string().default(""),
  enabled: z.boolean(),
  permissionMode: permissionModeSchema,
  allowedSenders: z.array(z.string()),
  voiceReplies: z.enum(["off", "voice", "always"]).default("voice"),
  /** Agent program of the channel's conversations; null = the workspace/environment default. */
  backendId: z.string().trim().nullable().default(null).transform(normalizeBackendId),
  /** Model its conversations start with; null = the backend's default. */
  model: z.string().trim().nullable().default(null),
  settings: z.record(z.string(), z.string()),
  secrets: z.record(z.string(), z.string().optional()),
});

/** Workspace channels start in Quick Chats; project channels need an existing project. */
const parseChannelInput = (body: unknown) => {
  const channelInput = channelInputSchema.parse(body);
  if (channelInput.scope === "workspace") return { ...channelInput, projectId: quickChatProject().id };
  requireProject(channelInput.projectId);
  return channelInput;
};

const presentChannel = (channel: ReturnType<typeof channelStore.list>[number]) => ({
  ...toPublicChannel(channel),
  status: channelManager.statusOf(channel.id),
});

app.get("/api/channels", (context) => context.json(channelStore.list().map(presentChannel)));

app.post("/api/channels", async (context) => {
  const channel = channelStore.save(parseChannelInput(await context.req.json()));
  await channelManager.start(channel.id);
  return context.json(presentChannel(channel));
});

app.put("/api/channels/:channelId", async (context) => {
  const channelId = context.req.param("channelId");
  if (!channelStore.get(channelId)) throw new Error(t("Channel nicht gefunden"));
  const channel = channelStore.save(parseChannelInput(await context.req.json()), channelId);
  await channelManager.start(channel.id);
  return context.json(presentChannel(channel));
});

app.delete("/api/channels/:channelId", async (context) => {
  await channelManager.stop(context.req.param("channelId"));
  channelStore.remove(context.req.param("channelId"));
  eventHub.publish({ type: "channels_changed" });
  return context.json({ ok: true });
});

// --- E-Mail-Postfach (Integration: „KI im Postfach“) ---
const presentMailInbox = (inbox: MailInbox) => ({
  id: inbox.id,
  name: inbox.name,
  scope: inbox.scope,
  projectId: inbox.projectId,
  agentId: inbox.agentId,
  autonomy: inbox.autonomy,
  enabled: inbox.enabled,
  backendId: inbox.backendId,
  model: inbox.model,
  instructions: inbox.instructions,
  signature: inbox.signature,
  tone: inbox.tone,
  context: inbox.context,
  includeSenders: inbox.includeSenders,
  excludeSenders: inbox.excludeSenders,
  folders: inbox.folders,
  settings: inbox.settings,
  secretsSet: Object.fromEntries(mailInboxFieldDefinitions.secrets.map((secretName) => [secretName, Boolean(inbox.secrets[secretName])])),
  agentName: inbox.agentId ? (teamStore.get(inbox.agentId)?.name ?? null) : null,
  status: mailManager.statusOf(inbox.id),
  createdAt: inbox.createdAt,
});

app.get("/api/mail", (context) => context.json(mailInboxStore.list().map(presentMailInbox)));

app.post("/api/mail", async (context) => {
  const inbox = mailInboxStore.save(mailInboxInputSchema.parse(await context.req.json()));
  await mailManager.start(inbox.id);
  return context.json(presentMailInbox(inbox));
});

app.put("/api/mail/:inboxId", async (context) => {
  const inboxId = context.req.param("inboxId");
  if (!mailInboxStore.get(inboxId)) throw new Error(t("Postfach nicht gefunden"));
  const inbox = mailInboxStore.save(mailInboxInputSchema.parse(await context.req.json()), inboxId);
  await mailManager.start(inbox.id);
  return context.json(presentMailInbox(inbox));
});

app.delete("/api/mail/:inboxId", async (context) => {
  const inboxId = context.req.param("inboxId");
  await mailManager.stop(inboxId);
  mailInboxStore.remove(inboxId);
  return context.json({ ok: true });
});

app.get("/api/mail/:inboxId/activity", (context) => {
  const inboxId = context.req.param("inboxId");
  return context.json({
    messages: mailMessageStore.listByInbox(inboxId).map((message) => ({
      ...message,
      projectId: message.sessionId ? (sessionStore.get(message.sessionId)?.projectId ?? null) : null,
    })),
    actions: mailActionStore.listByInbox(inboxId),
    pending: mailActionStore.pending(inboxId),
  });
});

app.post("/api/mail/:inboxId/actions/:actionId/approve", async (context) => {
  const inboxId = context.req.param("inboxId");
  const actionId = context.req.param("actionId");
  const { allow } = z.object({ allow: z.boolean() }).parse(await context.req.json());
  const status = await resolveDraft(inboxId, actionId, allow);
  return context.json({ status });
});

app.post("/api/mail/:inboxId/poll", async (context) => {
  void mailManager.start(context.req.param("inboxId"));
  return context.json({ ok: true });
});

// --- Voice ---
app.get("/api/settings/voice", (context) => context.json(voiceConfig.present()));

app.put("/api/settings/voice", async (context) => {
  const body = z
    .object({ settings: voiceSettingsSchema, secrets: z.record(z.enum(voiceSecretKeys), z.string().optional()) })
    .parse(await context.req.json());
  voiceConfig.save(body.settings, body.secrets);
  return context.json(voiceConfig.present());
});

app.post("/api/voice/transcribe", async (context) => {
  const mimeType = context.req.header("content-type") ?? "audio/webm";
  const audioData = Buffer.from(await context.req.arrayBuffer());
  if (!audioData.length) throw new Error(t("Keine Audiodaten empfangen"));
  if (audioData.length > 25 * 1024 * 1024) throw new Error(t("Aufnahme zu lang (max. 25 MB)"));
  return context.json({ text: await transcribe({ data: audioData, mimeType }) });
});

app.post("/api/voice/speak", async (context) => {
  const body = z.object({ text: z.string().min(1) }).parse(await context.req.json());
  const audioClip = await synthesize(body.text);
  return context.body(new Uint8Array(audioClip.data), 200, { "content-type": audioClip.mimeType, "cache-control": "no-store" });
});

// --- Memory ---
const noteRefSchema = z.object({ scope: z.enum(["workspace", "environment", "project"]), projectId: z.string().nullable().default(null), path: z.string().min(1) });
const readNoteRef = (context: { req: { query: (name: string) => string | undefined } }) =>
  noteRefSchema.parse({ scope: context.req.query("scope"), projectId: context.req.query("projectId") || null, path: context.req.query("path") });

app.get("/api/settings/memory", (context) => context.json(memoryConfig.present()));

app.put("/api/settings/memory", async (context) => {
  const body = z.object({ settings: memorySettingsSchema, openaiApiKey: z.string().optional() }).parse(await context.req.json());
  memoryConfig.save(body.settings, body.openaiApiKey);
  return context.json(memoryConfig.present());
});

app.get("/api/memory/notes", (context) => context.json(memoryIndex.list(context.req.query("projectId") || null)));

app.get("/api/memory/search", async (context) =>
  context.json(await memoryIndex.search(context.req.query("q") ?? "", context.req.query("projectId") || null, "all", 30)),
);

app.get("/api/memory/note", (context) => context.json({ content: memoryNotes.read(readNoteRef(context)) }));

app.put("/api/memory/note", async (context) => {
  const body = noteRefSchema.extend({ content: z.string() }).parse(await context.req.json());
  return context.json({ path: await memoryNotes.write(body, body.content) });
});

app.delete("/api/memory/note", async (context) => {
  await memoryNotes.remove(readNoteRef(context));
  return context.json({ ok: true });
});

// Files in memory (PDF, images, documents) – the agent sees them as a path list and reads them on demand.
const memoryFileRefSchema = z.object({ scope: z.enum(["project", "environment", "workspace"]), projectId: z.string().nullable(), path: z.string().min(1) });
const memoryProjectOf = (projectId: string | null | undefined) => (projectId ? requireProject(projectId) : null);
const readMemoryFileRef = (context: { req: { query: (name: string) => string | undefined } }) =>
  memoryFileRefSchema.parse({ scope: context.req.query("scope"), projectId: context.req.query("projectId") || null, path: context.req.query("path") });

app.get("/api/memory/files", (context) => context.json(memoryFiles.list(memoryProjectOf(context.req.query("projectId")))));

app.post("/api/memory/files", async (context) => {
  const scope = z.enum(["project", "environment", "workspace"]).parse(context.req.query("scope"));
  const project = memoryProjectOf(context.req.query("projectId"));
  const formBody = await context.req.parseBody({ all: true });
  const uploadedFiles = [formBody.files].flat().filter((entry): entry is File => entry instanceof File);
  if (!uploadedFiles.length) throw new Error(t("Keine Datei erhalten"));
  const savedFiles = [];
  for (const uploadedFile of uploadedFiles) savedFiles.push(memoryFiles.save(scope, project, uploadedFile.name, Buffer.from(await uploadedFile.arrayBuffer())));
  return context.json(savedFiles);
});

app.get("/api/memory/files/raw", (context) => {
  const fileRef = readMemoryFileRef(context);
  const absolutePath = memoryFiles.absolutePath(fileRef.scope, memoryProjectOf(fileRef.projectId), fileRef.path);
  const contentType = mimeTypesByExtension[path.extname(absolutePath).toLowerCase()] ?? "application/octet-stream";
  return context.body(fs.readFileSync(absolutePath), 200, { "content-type": contentType, "cache-control": "no-store" });
});

app.delete("/api/memory/files", (context) => {
  const fileRef = readMemoryFileRef(context);
  memoryFiles.remove(fileRef.scope, memoryProjectOf(fileRef.projectId), fileRef.path);
  return context.json({ ok: true });
});

app.post("/api/memory/reindex", async (context) => {
  await memoryIndex.reindexAll();
  return context.json({ ok: true });
});

// --- Files Harnold created (attachments, generated images, memory files) ---
app.get("/api/files", (context) => context.json(managedFiles.list()));

app.get("/api/files/raw", (context) => {
  const absolutePath = resolveManagedFile(context.req.query("id") ?? "");
  const contentType = mimeTypesByExtension[path.extname(absolutePath).toLowerCase()] ?? "application/octet-stream";
  return context.body(fs.readFileSync(absolutePath), 200, { "content-type": contentType, "cache-control": "no-store" });
});

app.post("/api/files/delete", async (context) => {
  const body = z.object({ fileIds: z.array(z.string().min(1)).min(1).max(5000) }).parse(await context.req.json());
  const removedCount = managedFiles.remove(body.fileIds);
  eventHub.publish({ type: "memory_changed", projectId: null });
  return context.json({ removedCount });
});

app.post("/api/files/to-memory", async (context) => {
  const body = z.object({ fileId: z.string().min(1), scope: z.enum(["project", "environment", "workspace"]), projectId: z.string().nullable() }).parse(await context.req.json());
  const savedFile = managedFiles.copyToMemory(body.fileId, body.scope, body.projectId ? requireProject(body.projectId) : null);
  eventHub.publish({ type: "memory_changed", projectId: body.projectId });
  return context.json(savedFile);
});

// --- Design systems ---
const designSystemLinkSchema = z.object({ targetType: z.enum(["project", "session"]), targetId: z.string().min(1) });

app.get("/api/design-systems", (context) => context.json(designSystemStore.list()));

app.post("/api/design-systems", async (context) => {
  const body = z.object({ name: z.string().trim().min(1), template: z.enum(["starter", "empty"]).default("starter"), links: z.array(designSystemLinkSchema).default([]) }).parse(await context.req.json());
  const createdSystem = designSystemStore.create(body.name, body.template);
  return context.json(body.links.length ? designSystemStore.setLinks(createdSystem.id, body.links) : createdSystem);
});

app.get("/api/design-systems/:designSystemId", (context) => context.json(designSystemStore.get(context.req.param("designSystemId"))));

app.put("/api/design-systems/:designSystemId", async (context) => {
  const body = z.object({ name: z.string().trim().min(1) }).parse(await context.req.json());
  return context.json(designSystemStore.rename(context.req.param("designSystemId"), body.name));
});

app.delete("/api/design-systems/:designSystemId", (context) => {
  designSystemStore.remove(context.req.param("designSystemId"));
  return context.json({ ok: true });
});

app.put("/api/design-systems/:designSystemId/tokens", async (context) => {
  const body = z.object({ tokens: z.record(z.string(), z.unknown()) }).parse(await context.req.json());
  return context.json(designSystemStore.writeTokens(context.req.param("designSystemId"), body.tokens));
});

app.put("/api/design-systems/:designSystemId/links", async (context) => {
  const body = z.object({ links: z.array(designSystemLinkSchema) }).parse(await context.req.json());
  return context.json(designSystemStore.setLinks(context.req.param("designSystemId"), body.links));
});

// Raw files (component thumbnails); components link ../tokens.css relatively.
app.get("/design-systems/:designSystemId/*", (context) => {
  const relativePath = decodeURIComponent(context.req.path.split("/").slice(3).join("/"));
  const absolutePath = designSystemStore.resolveFile(context.req.param("designSystemId"), relativePath);
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) return context.text("Nicht gefunden", 404);
  const contentType = mimeTypesByExtension[path.extname(absolutePath).toLowerCase()] ?? "application/octet-stream";
  return context.body(fs.readFileSync(absolutePath), 200, { "content-type": contentType, "cache-control": "no-store" });
});

// --- Environments ---
app.get("/api/environments", (context) => context.json(environmentStore.list()));
app.get("/api/environment-providers", (context) => context.json(presentProviders()));
app.post("/api/environments/:environmentId/import", async (context) => {
  const result = await environmentStore.importCurrent(context.req.param("environmentId"), {});
  return context.json(result);
});
app.post("/api/environments", async (context) => context.json(environmentStore.create(environmentInputSchema.parse(await context.req.json()))));
app.put("/api/environments/:environmentId", async (context) =>
  context.json(environmentStore.update(context.req.param("environmentId"), environmentInputSchema.parse(await context.req.json()))),
);
app.patch("/api/environments/:environmentId", async (context) => {
  const body = z.object({ icon: z.string().trim().max(40).nullable() }).parse(await context.req.json());
  return context.json(environmentStore.setIcon(context.req.param("environmentId"), body.icon));
});

app.delete("/api/environments/:environmentId", (context) => {
  for (const agent of teamStore.list().filter((candidate) => candidate.environmentId === context.req.param("environmentId"))) teamStore.remove(agent.id);
  environmentStore.remove(context.req.param("environmentId"));
  folderStore.removeOwner("environment", context.req.param("environmentId"));
  return context.json({ ok: true });
});
app.post("/api/environments/:environmentId/check", async (context) => context.json(await environmentStore.checkAccounts(context.req.param("environmentId"))));
app.put("/api/projects/:projectId/environment", async (context) => {
  const body = z.object({ environmentId: z.string().nullable() }).parse(await context.req.json());
  environmentStore.assignProject(requireProject(context.req.param("projectId")).id, body.environmentId);
  return context.json({ ok: true });
});

// --- Claude connection ---
/** Claude login of the workspace (default) or of an environment with its own Claude account (?environmentId= / body). */
const claudeProfileOf = (environmentId: string | undefined | null) => {
  if (!environmentId) return defaultClaudeProfile;
  environmentStore.get(environmentId); // throws when unknown
  return claudeProfileForEnvironment(environmentId);
};
const readEnvironmentId = async (context: { req: { json: () => Promise<unknown> } }) =>
  z.object({ environmentId: z.string().nullish() }).passthrough().parse(await context.req.json().catch(() => ({}))).environmentId;

app.get("/api/claude/status", async (context) =>
  context.json(await claudeAuth.status(context.req.query("refresh") === "1", claudeProfileOf(context.req.query("environmentId")))),
);

app.post("/api/runtimes/:runtimeId/download", (context) => {
  agentRuntimes.download(z.enum(["claude-code"]).parse(context.req.param("runtimeId")));
  return context.json({ ok: true });
});

app.put("/api/settings/language", async (context) => {
  const language = parseLanguage(((await context.req.json()) as { language?: string }).language);
  if (!language) throw new Error(t("Unbekannte Sprache"));
  languageSettings.write(language);
  return context.json({ language });
});

/** Default model of one agent (`?backend=`), else of the active one. */
const modelBackendOf = (backendQuery: string | undefined) => (isAgentBackendId(backendQuery) ? backendQuery : agentBackendSettings.read());
app.get("/api/settings/model", (context) => context.json({ defaultModel: agentModelSettings.read(modelBackendOf(context.req.query("backend"))) }));
app.put("/api/settings/model", async (context) => {
  const body = z.object({ defaultModel: z.string().trim().min(1) }).parse(await context.req.json());
  const backendId = modelBackendOf(context.req.query("backend"));
  return context.json({ defaultModel: agentModelSettings.write(body.defaultModel, backendId) });
});

app.put("/api/claude/settings", async (context) => context.json(await claudeAuth.save(claudeSettingsSchema.parse(await context.req.json()))));

// --- Rollen: welches Agent-Programm/Modell für Unterhaltungen und für Hintergrundläufe ---
const agentRoleDefaultsSchema = z.object({ backendId: z.string().nullable(), model: z.string().nullable() });
const agentRolesSchema = z.object({ chat: agentRoleDefaultsSchema.optional(), automation: agentRoleDefaultsSchema.optional() }).partial();

app.get("/api/agent-roles", (context) => context.json(agentRoleSettings.read()));
app.put("/api/agent-roles", async (context) => {
  const roles = agentRoleSettings.write(agentRolesSchema.parse(await context.req.json()));
  eventHub.publish({ type: "claude_auth_changed" });
  return context.json(roles);
});

// --- Agent programs (Claude Code, Codex, …) ---
const codexSettingsSchema = z.object({ mode: z.enum(["login", "apiKey"]), apiKey: z.string().optional(), models: z.array(z.string()).optional() });
const codexView = async (forceRefresh = false) => ({ ...(await codexAuth.status(forceRefresh)), models: codexSettings.models() });

app.get("/api/agent-backends", async (context) => context.json(await agentBackends.view(context.req.query("refresh") === "1")));
app.put("/api/agent-backends-active", async (context) => {
  const { backendId } = z.object({ backendId: z.string() }).parse(await context.req.json());
  if (!isAgentBackendId(backendId)) throw new Error(t("Unbekannter Agent"));
  agentBackends.setActive(backendId);
  // The default model belongs to the program: keep each one's own, but make sure the Claude side stays valid.
  return context.json(await agentBackends.view());
});
app.get("/api/codex/status", async (context) => context.json(await codexView(context.req.query("refresh") === "1")));
app.put("/api/codex/settings", async (context) => {
  await codexAuth.save(codexSettingsSchema.parse(await context.req.json()));
  return context.json(await codexView());
});
app.post("/api/codex/login", async (context) => context.json(await codexAuth.startLogin()));
app.post("/api/codex/login/cancel", (context) => {
  codexAuth.cancelLogin();
  return context.json({ ok: true });
});
app.post("/api/codex/logout", async (context) => {
  await codexAuth.logout();
  return context.json(await codexView(true));
});
// Harnold's tools for agent programs that reach them over HTTP (see mcp-http.ts).
app.all("/mcp/:token/:serverName", (context) => harnoldMcp.handle(context.req.param("token"), context.req.param("serverName"), context.req.raw));

// --- Providers ---
/** After a provider switch the default model must belong to it. */
function alignDefaultModelWithProvider(): void {
  if (agentBackendSettings.read() !== "claude-code") return;
  const activeProvider = providerStore.active();
  const currentModel = agentModelSettings.read();
  if (activeProvider) {
    if (!activeProvider.models.includes(currentModel) && activeProvider.models[0]) agentModelSettings.write(activeProvider.models[0]);
  } else if (!currentModel.startsWith("claude-")) agentModelSettings.write("claude-opus-5-5");
}
app.get("/api/providers", (context) => context.json(providerStore.view()));
app.post("/api/providers", async (context) => {
  providerStore.create(providerInputSchema.parse(await context.req.json()));
  return context.json(providerStore.view());
});
app.put("/api/providers/:providerId", async (context) => {
  providerStore.update(context.req.param("providerId"), providerInputSchema.parse(await context.req.json()));
  alignDefaultModelWithProvider();
  return context.json(providerStore.view());
});
app.delete("/api/providers/:providerId", (context) => {
  providerStore.remove(context.req.param("providerId"));
  alignDefaultModelWithProvider();
  return context.json(providerStore.view());
});
/** Model list of an endpoint; without a key the stored one of providerId is used. */
app.post("/api/providers/discover-models", async (context) => {
  const body = z
    .object({ protocol: z.enum(["anthropic", "openai"]), baseUrl: z.string().trim().url(), apiKey: z.string().optional(), providerId: z.string().optional() })
    .parse(await context.req.json());
  const apiKey = body.apiKey?.trim() || (body.providerId ? providerStore.apiKeyOf(body.providerId) : "");
  return context.json({ models: await discoverProviderModels({ protocol: body.protocol, baseUrl: body.baseUrl, apiKey }) });
});
app.put("/api/providers-active", async (context) => {
  providerStore.setActive(z.object({ providerId: z.string().min(1) }).parse(await context.req.json()).providerId);
  alignDefaultModelWithProvider();
  return context.json(providerStore.view());
});

app.post("/api/claude/login", async (context) => {
  const body = z
    .object({ method: z.enum(["claudeai", "console"]).default("claudeai"), environmentId: z.string().nullish() })
    .parse(await context.req.json().catch(() => ({})));
  return context.json(await claudeAuth.startLogin(body.method, claudeProfileOf(body.environmentId)));
});

app.post("/api/claude/login/code", async (context) => {
  const body = z.object({ code: z.string().trim().min(1), environmentId: z.string().nullish() }).parse(await context.req.json());
  return context.json(await claudeAuth.submitLoginCode(body.code, claudeProfileOf(body.environmentId)));
});

app.post("/api/claude/login/cancel", async (context) => {
  claudeAuth.cancelLogin(claudeProfileOf(await readEnvironmentId(context)));
  return context.json({ ok: true });
});

app.post("/api/claude/logout", async (context) => context.json(await claudeAuth.logout(claudeProfileOf(await readEnvironmentId(context)))));

// --- Image generation ---
app.get("/api/settings/images", (context) => context.json(imageConfig.present()));

app.put("/api/settings/images", async (context) => {
  const body = z
    .object({ settings: imageSettingsSchema, secrets: z.record(z.enum(imageSecretKeys), z.string().optional()) })
    .parse(await context.req.json());
  imageConfig.save(body.settings, body.secrets);
  return context.json(imageConfig.present());
});

app.post("/api/projects/:projectId/images", async (context) => {
  const imageRequest = imageRequestSchema.parse(await context.req.json());
  return context.json({ paths: await generateImages(requireProject(context.req.param("projectId")), imageRequest) });
});

// --- Integrations ---
app.get("/api/mcp-servers", (context) => context.json(mcpServerStore.list().map(toPublicMcpServer)));

app.get("/api/mcp-servers/external", (context) => context.json(discoverExternalMcpServers(projectStore.get(context.req.query("projectId") ?? "") ?? null)));
app.post("/api/mcp-servers/import", async (context) => {
  const body = z
    .object({ sourceId: z.enum(["claude-code", "claude-code-project", "claude-desktop", "cursor", "vscode", "windsurf", "gemini"]), name: z.string().min(1), projectId: z.string().nullish() })
    .parse(await context.req.json());
  importExternalMcpServer(body.sourceId, body.name, body.projectId ?? null);
  return context.json({ ok: true });
});

app.post("/api/mcp-servers", async (context) => {
  const serverInput = mcpServerInputSchema.parse(await context.req.json());
  return context.json(toPublicMcpServer(mcpServerStore.save(serverInput)));
});

app.put("/api/mcp-servers/:serverId", async (context) => {
  const serverInput = mcpServerInputSchema.parse(await context.req.json());
  return context.json(toPublicMcpServer(mcpServerStore.save(serverInput, context.req.param("serverId"))));
});

app.delete("/api/mcp-servers/:serverId", (context) => {
  mcpServerStore.remove(context.req.param("serverId"));
  return context.json({ ok: true });
});

app.post("/api/mcp-servers/:serverId/test", async (context) => {
  const server = mcpServerStore.get(context.req.param("serverId"));
  if (!server) throw new Error(t("Server nicht gefunden"));
  return context.json(await testMcpServer(server));
});

const skillScopeSchema = z.enum(["user", "project"]);
const projectForSkill = (scope: "user" | "project", projectId: string | undefined | null) => (scope === "project" ? requireProject(projectId ?? "") : null);

app.get("/api/skills", (context) => {
  const projectId = context.req.query("projectId");
  return context.json(skillStore.list(projectId ? requireProject(projectId) : null));
});

app.post("/api/skills", async (context) => {
  const body = z
    .object({ scope: skillScopeSchema, projectId: z.string().nullable(), name: z.string(), description: z.string().min(1), instructions: z.string() })
    .parse(await context.req.json());
  skillStore.create(body.scope, projectForSkill(body.scope, body.projectId), body.name, body.description, body.instructions);
  return context.json({ ok: true });
});

app.get("/api/skills/file", (context) => {
  const scope = skillScopeSchema.parse(context.req.query("scope"));
  return context.json({ content: skillStore.read(scope, projectForSkill(scope, context.req.query("projectId")), context.req.query("path") ?? "") });
});

app.put("/api/skills/file", async (context) => {
  const body = z.object({ scope: skillScopeSchema, projectId: z.string().nullable(), path: z.string(), content: z.string() }).parse(await context.req.json());
  skillStore.write(body.scope, projectForSkill(body.scope, body.projectId), body.path, body.content);
  return context.json({ ok: true });
});

app.put("/api/skills/:skillName/enabled", async (context) => {
  const body = z.object({ enabled: z.boolean() }).parse(await context.req.json());
  skillStore.setEnabled(context.req.param("skillName"), body.enabled);
  return context.json({ ok: true });
});

// --- Plugins ---
app.get("/api/plugins", (context) => context.json(pluginStore.list()));
app.put("/api/plugins/enabled", async (context) => {
  const body = z.object({ pluginId: z.string().min(1), enabled: z.boolean() }).parse(await context.req.json());
  pluginStore.setEnabled(body.pluginId, body.enabled);
  eventHub.publish({ type: "integrations_changed" });
  return context.json({ ok: true });
});
app.post("/api/plugins/folders", async (context) => {
  const body = z.object({ path: z.string().min(1) }).parse(await context.req.json());
  const plugin = pluginStore.addFolder(body.path);
  eventHub.publish({ type: "integrations_changed" });
  return context.json(plugin);
});
app.post("/api/plugins/folders/remove", async (context) => {
  const body = z.object({ pluginId: z.string().min(1) }).parse(await context.req.json());
  pluginStore.removeFolder(body.pluginId);
  eventHub.publish({ type: "integrations_changed" });
  return context.json({ ok: true });
});

// --- Git (Workspace → Git): status, diff, stage, commit, push/pull with the project's environment ---
// ?root= picks one of the project's folders (project folder, attached folders, chat worktrees); Git works on its repository.
const gitPathsSchema = z.object({ paths: z.array(z.string().min(1)).min(1) });
async function gitTarget(context: { req: { param: (name: string) => string | undefined; query: (name: string) => string | undefined } }) {
  const project = requireProject(context.req.param("projectId") ?? "");
  const rootPath = resolveProjectRoot(project, context.req.query("root"));
  return { id: project.id, path: (await repositoryTopLevel(rootPath)) ?? rootPath };
}
app.get("/api/projects/:projectId/git/status", async (context) => context.json(await gitStatus(await gitTarget(context))));
app.get("/api/projects/:projectId/git/diff", async (context) => {
  return context.json({ diff: await gitDiff(await gitTarget(context), context.req.query("path") ?? "", context.req.query("staged") === "1") });
});
app.get("/api/projects/:projectId/git/log", async (context) => context.json(await gitLog(await gitTarget(context))));
app.get("/api/projects/:projectId/git/branches", async (context) => context.json(await gitBranches(await gitTarget(context))));
for (const [actionName, gitAction] of [["stage", gitStage], ["unstage", gitUnstage], ["discard", gitDiscard]] as const) {
  app.post(`/api/projects/:projectId/git/${actionName}`, async (context) => {
    const target = await gitTarget(context);
    await gitAction(target, gitPathsSchema.parse(await context.req.json()).paths);
    return context.json(await gitStatus(target));
  });
}
app.post("/api/projects/:projectId/git/commit", async (context) => {
  const target = await gitTarget(context);
  const { message } = z.object({ message: z.string().trim().min(1) }).parse(await context.req.json());
  return context.json({ commit: await gitCommit(target, message), status: await gitStatus(target) });
});
for (const [actionName, gitAction] of [["push", gitPush], ["pull", gitPull], ["init", gitInit]] as const) {
  app.post(`/api/projects/:projectId/git/${actionName}`, async (context) => {
    const target = await gitTarget(context);
    await gitAction(target);
    return context.json(await gitStatus(target));
  });
}
app.post("/api/projects/:projectId/git/switch", async (context) => {
  const target = await gitTarget(context);
  const { branch, create } = z.object({ branch: z.string().trim().min(1), create: z.boolean().default(false) }).parse(await context.req.json());
  if (create) await gitCreateBranch(target, branch);
  else await gitSwitch(target, branch);
  return context.json(await gitStatus(target));
});

// --- Worktree of a chat: own checkout on its own branch ---
app.get("/api/sessions/:sessionId/worktree", async (context) => context.json({ worktree: await sessionWorktreeStatus(context.req.param("sessionId")) }));
app.post("/api/sessions/:sessionId/worktree", async (context) => {
  const { folder } = z.object({ folder: z.string().min(1) }).parse(await context.req.json());
  const sessionId = context.req.param("sessionId");
  await createSessionWorktree(sessionId, folder);
  agentRuntime.release(sessionId);
  eventHub.publish({ type: "sessions_changed", projectId: sessionStore.get(sessionId)?.projectId ?? "" });
  return context.json({ worktree: await sessionWorktreeStatus(sessionId) });
});
app.post("/api/sessions/:sessionId/worktree/apply", async (context) => {
  const sessionId = context.req.param("sessionId");
  await applySessionWorktree(sessionId);
  return context.json({ worktree: await sessionWorktreeStatus(sessionId) });
});
app.delete("/api/sessions/:sessionId/worktree", async (context) => {
  const sessionId = context.req.param("sessionId");
  if (agentRuntime.isRunning(sessionId)) throw new Error(t("Erst den laufenden Durchlauf beenden."));
  agentRuntime.release(sessionId);
  await removeSessionWorktree(sessionId, { deleteBranch: context.req.query("deleteBranch") === "1" });
  eventHub.publish({ type: "sessions_changed", projectId: sessionStore.get(sessionId)?.projectId ?? "" });
  return context.json({ worktree: null });
});

// --- Terminals (Workspace → Terminal): shells in the project folder, kept alive in the Core ---
app.get("/api/projects/:projectId/terminals", (context) => {
  const project = requireProject(context.req.param("projectId"));
  return context.json({ available: terminalAvailable(), terminals: listTerminals(project.id) });
});
app.post("/api/projects/:projectId/terminals", async (context) => {
  const project = requireProject(context.req.param("projectId"));
  const request = z.object({ cols: z.number().int().min(2).max(1000).default(100), rows: z.number().int().min(2).max(500).default(30), root: z.string().optional() }).parse(await context.req.json().catch(() => ({})));
  return context.json(createTerminal(project, request, resolveProjectRoot(project, request.root)));
});
app.delete("/api/terminals/:terminalId", (context) => context.json({ ok: closeTerminal(context.req.param("terminalId")) }));
app.get(
  "/ws/terminals/:terminalId",
  upgradeWebSocket((context) => {
    const terminalId = context.req.param("terminalId") ?? "";
    let connection: ReturnType<typeof attachTerminal> = null;
    return {
      onOpen(_openEvent, socket) {
        connection = attachTerminal(terminalId, (message) => socket.send(JSON.stringify(message)));
        if (!connection) socket.close(4404, "terminal not found");
      },
      onMessage(messageEvent) {
        try {
          connection?.receive(JSON.parse(String(messageEvent.data)) as TerminalClientMessage);
        } catch {
          // ignore malformed messages
        }
      },
      onClose() {
        connection?.detach();
      },
    };
  }),
);

// --- Dev servers (Workspace → App): running servers and opening them through the preview proxy ---
app.get("/api/dev-servers", async (context) => context.json(await listDevServers()));
app.post("/api/dev-servers/:port/open", async (context) => context.json(await openDevServer(Number(context.req.param("port")))));

// --- Live events ---
app.get(
  "/ws",
  upgradeWebSocket(() => {
    let unsubscribe: (() => void) | undefined;
    return {
      onOpen(_openEvent, socket) {
        unsubscribe = eventHub.subscribe((serverEvent) => socket.send(JSON.stringify(serverEvent)));
      },
      onClose() {
        unsubscribe?.();
      },
    };
  }),
);

// Server mode: serve the built UI (apps/ui/dist) from the same origin.
const uiDistDirectory = process.env.HARNOLD_UI_DIR ?? path.resolve(import.meta.dirname, "../../../apps/ui/dist");
if (fs.existsSync(uiDistDirectory)) {
  app.get("*", (context) => {
    const requestedPath = path.resolve(uiDistDirectory, "." + context.req.path);
    const isInsideUi = requestedPath.startsWith(uiDistDirectory + path.sep);
    const filePath = isInsideUi && fs.existsSync(requestedPath) && fs.statSync(requestedPath).isFile()
      ? requestedPath
      : path.join(uiDistDirectory, "index.html");
    const contentType = mimeTypesByExtension[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
    return context.body(fs.readFileSync(filePath), 200, { "content-type": contentType });
  });
}

for (const project of projectStore.list()) watchProject(project);
startScheduler();
channelManager.startAll();
mailManager.startAll();
startMemory();
startQuickChatCleanup();
importLegacyProjectDesignSystems();
watchDesignSystems();

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (address) => {
  console.log(`Harnold Core läuft auf http://${config.host}:${address.port}`);
});
injectWebSocket(server);
startPreviewProxy();

// Desktop app: the app holds our stdin open; when it closes (quit, crash, kill), the Core ends too.
if (process.env.HARNOLD_EXIT_WITH_PARENT === "1") {
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("error", () => process.exit(0));
  process.stdin.resume();
}
