import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { z } from "zod";
import { config } from "./config.ts";
import { chatItemStore, projectStore, sessionStore } from "./db.ts";
import { eventHub } from "./events.ts";
import { agentRuntime } from "./agent.ts";
import { sessionActions } from "./session-actions.ts";
import { agentCommands } from "./slash-commands.ts";
import { readFileTree, resolveInsideProject, unwatchProject, watchProject } from "./files.ts";
import { canvasDocumentSchema, readCanvas, writeCanvas } from "./canvas.ts";
import { nextRunOf, runTask, scheduleTask, startScheduler, taskStore, unscheduleTask } from "./tasks.ts";
import { channelStore, toPublicChannel } from "./channels/store.ts";
import { channelManager } from "./channels/manager.ts";
import { synthesize, transcribe, voiceConfig, voiceSecretKeys, voiceSettingsSchema } from "./voice.ts";
import { designSystemStore, importLegacyProjectDesignSystems, virtualDesignSystemsPrefix, watchDesignSystems } from "./design-system.ts";
import { environmentInputSchema, environmentStore } from "./environments.ts";
import { presentProviders } from "./environment-providers.ts";
import { agentModelSettings, claudeAuth, claudeProfileForEnvironment, claudeSettingsSchema, defaultClaudeProfile } from "./claude-auth.ts";
import { generateImages, imageConfig, imageRequestSchema, imageSecretKeys, imageSettingsSchema } from "./image-generation.ts";
import { mcpServerInputSchema, mcpServerStore, skillStore, testMcpServer, toPublicMcpServer } from "./integrations.ts";
import { memoryConfig, memoryIndex, memoryNotes, memorySettingsSchema, startMemory } from "./memory.ts";
import { deleteExpiredQuickChats, quickChatProject, quickChatSettings, startQuickChatCleanup } from "./quick-chats.ts";
import { pluginStore } from "./plugins.ts";
import { saveAttachment } from "./attachments.ts";
import { memoryFiles } from "./memory-files.ts";

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

// --- Auth (only active when HARNOLD_TOKEN is set) ---
app.use("*", async (context, next) => {
  if (!config.accessToken) return next();
  const bearerToken = context.req.header("authorization")?.replace(/^Bearer /, "");
  const queryToken = context.req.query("token");
  if (bearerToken === config.accessToken || queryToken === config.accessToken) return next();
  return context.json({ error: "Nicht autorisiert" }, 401);
});

app.onError((requestError, context) => context.json({ error: requestError.message }, 400));

const requireProject = (projectId: string) => {
  const project = projectStore.get(projectId);
  if (!project) throw new Error("Projekt nicht gefunden");
  return project;
};

// --- Projects ---
app.get("/api/projects", (context) => context.json(projectStore.list()));

app.post("/api/projects", async (context) => {
  const body = z
    .object({ name: z.string().min(1), path: z.string().optional(), environmentId: z.string().nullable().optional() })
    .parse(await context.req.json());
  const folderName = body.name.trim().replace(/[^\w.-]+/g, "-").toLowerCase();
  const projectPath = path.resolve(body.path?.trim() || path.join(config.projectsDirectory, folderName));
  fs.mkdirSync(projectPath, { recursive: true });
  const project = projectStore.create(body.name.trim(), projectPath);
  if (body.environmentId) environmentStore.assignProject(project.id, body.environmentId);
  watchProject(project);
  void memoryIndex.reindex("project", project);
  return context.json(project);
});

app.patch("/api/projects/:projectId", async (context) => {
  const project = requireProject(context.req.param("projectId"));
  const body = z.object({ name: z.string().trim().min(1).optional(), icon: z.string().trim().max(16).nullable().optional() }).parse(await context.req.json());
  projectStore.update(project.id, { name: body.name, icon: body.icon === "" ? null : body.icon });
  return context.json(projectStore.get(project.id));
});

app.delete("/api/projects/:projectId", (context) => {
  if (requireProject(context.req.param("projectId")).kind === "quick") throw new Error("Quick Chats lassen sich nicht entfernen");
  // Removes only Harnold's record; the folder on disk stays untouched.
  unwatchProject(context.req.param("projectId"));
  environmentStore.assignProject(context.req.param("projectId"), null);
  projectStore.remove(context.req.param("projectId"));
  return context.json({ ok: true });
});

// --- Files ---
app.get("/api/projects/:projectId/tree", (context) =>
  context.json(readFileTree(requireProject(context.req.param("projectId")))),
);

app.get("/api/projects/:projectId/file", (context) => {
  const project = requireProject(context.req.param("projectId"));
  const absolutePath = resolveInsideProject(project, context.req.query("path") ?? "");
  return context.json({ content: fs.readFileSync(absolutePath, "utf8") });
});

app.put("/api/projects/:projectId/file", async (context) => {
  const project = requireProject(context.req.param("projectId"));
  const body = z.object({ path: z.string().min(1), content: z.string() }).parse(await context.req.json());
  const absolutePath = resolveInsideProject(project, body.path);
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
  let absolutePath: string;
  if (relativePath.startsWith(virtualDesignSystemsPrefix)) {
    // Linked design systems appear inside every project under _harnold/design-systems/<id>/
    const [designSystemId, ...fileSegments] = relativePath.slice(virtualDesignSystemsPrefix.length).split("/");
    absolutePath = designSystemStore.resolveFile(designSystemId, fileSegments.join("/"));
  } else absolutePath = resolveInsideProject(project, relativePath);
  if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isDirectory()) absolutePath = path.join(absolutePath, "index.html");
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

app.post("/api/projects/:projectId/sessions", (context) => {
  const project = requireProject(context.req.param("projectId"));
  const session = sessionStore.create(project.id, "Neue Session");
  eventHub.publish({ type: "sessions_changed", projectId: project.id });
  return context.json(session);
});

// --- Quick Chats (no project) ---
app.post("/api/quick-chats", (context) => {
  const project = quickChatProject();
  const session = sessionStore.create(project.id, "Neue Session");
  eventHub.publish({ type: "sessions_changed", projectId: project.id });
  return context.json(session);
});

app.get("/api/settings/quick-chats", (context) => context.json(quickChatSettings.read()));
app.put("/api/settings/quick-chats", async (context) => {
  const body = z.object({ autoDeleteDays: z.number().int().min(1).max(3650).nullable() }).parse(await context.req.json());
  quickChatSettings.write(body);
  deleteExpiredQuickChats();
  return context.json(quickChatSettings.read());
});

app.delete("/api/sessions/:sessionId", (context) => {
  const session = sessionStore.get(context.req.param("sessionId"));
  if (session) {
    agentRuntime.interrupt(session.id);
    sessionStore.remove(session.id);
    eventHub.publish({ type: "sessions_changed", projectId: session.projectId });
  }
  return context.json({ ok: true });
});

app.patch("/api/sessions/:sessionId", async (context) => {
  const body = z.object({ title: z.string().min(1).optional(), projectId: z.string().optional() }).parse(await context.req.json());
  const sessionId = context.req.param("sessionId");
  if (body.title) sessionActions.rename(sessionId, body.title);
  const moveResult = body.projectId ? sessionActions.move(sessionId, body.projectId) : { deferred: false };
  return context.json({ ok: true, ...moveResult });
});

app.post("/api/sessions/:sessionId/clear", (context) => {
  sessionActions.clear(context.req.param("sessionId"));
  return context.json({ ok: true });
});

app.get("/api/projects/:projectId/commands", (context) => context.json(agentCommands.list(requireProject(context.req.param("projectId")))));

app.get("/api/sessions/:sessionId/items", (context) => context.json(chatItemStore.list(context.req.param("sessionId"))));

const permissionModeSchema = z.enum(["default", "acceptEdits", "bypassPermissions", "plan"]);
const attachmentSchema = z.object({ path: z.string().min(1), name: z.string().min(1), mimeType: z.string(), size: z.number() });

// Files attached to a chat message (multipart field "files"); stored under attachments/ in the project.
app.post("/api/projects/:projectId/attachments", async (context) => {
  const project = requireProject(context.req.param("projectId"));
  const formBody = await context.req.parseBody({ all: true });
  const uploadedFiles = [formBody.files].flat().filter((entry): entry is File => entry instanceof File);
  if (!uploadedFiles.length) throw new Error("Keine Datei erhalten");
  const attachments = await Promise.all(
    uploadedFiles.map(async (uploadedFile) => saveAttachment(project, uploadedFile.name, uploadedFile.type, Buffer.from(await uploadedFile.arrayBuffer()))),
  );
  return context.json(attachments);
});

app.post("/api/sessions/:sessionId/messages", async (context) => {
  const body = z
    .object({ text: z.string(), permissionMode: permissionModeSchema.default("default"), model: z.string().optional(), attachments: z.array(attachmentSchema).max(20).optional() })
    .refine((body) => body.text.trim() || body.attachments?.length, "Nachricht ist leer")
    .parse(await context.req.json());
  const sessionId = context.req.param("sessionId");
  if (agentRuntime.isRunning(sessionId)) throw new Error("In dieser Session läuft bereits ein Durchlauf");
  const session = sessionStore.get(sessionId);
  if (!session) throw new Error("Session nicht gefunden");
  await environmentStore.agentSetupFor(session.projectId); // friendly error when Claude access is missing
  void agentRuntime.runTurn({ sessionId, ...body }).catch((turnError) => console.error("[agent]", turnError));
  return context.json({ ok: true });
});

/** Edit a sent message: new version of the conversation from that message on, then run it. */
app.post("/api/sessions/:sessionId/edit", async (context) => {
  const body = z
    .object({ itemId: z.string(), text: z.string().min(1), permissionMode: permissionModeSchema.default("default"), model: z.string().optional() })
    .parse(await context.req.json());
  const session = sessionStore.get(context.req.param("sessionId"));
  if (!session) throw new Error("Session nicht gefunden");
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
    .flatMap((project) => sessionStore.listByProject(project.id).slice(0, 3))
    .sort((first, second) => second.updatedAt - first.updatedAt)
    .slice(0, 3)
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

app.post("/api/permissions/:requestId", async (context) => {
  const body = z.object({ allow: z.boolean() }).parse(await context.req.json());
  return context.json({ ok: agentRuntime.resolvePermission(context.req.param("requestId"), body.allow) });
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
  if (!taskStore.get(taskId)) throw new Error("Task nicht gefunden");
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

// --- Channels ---
const channelInputSchema = z.object({
  type: z.enum(["telegram", "discord", "slack", "email"]),
  name: z.string().min(1),
  projectId: z.string().min(1),
  enabled: z.boolean(),
  permissionMode: permissionModeSchema,
  allowedSenders: z.array(z.string()),
  voiceReplies: z.enum(["off", "voice", "always"]).default("voice"),
  settings: z.record(z.string(), z.string()),
  secrets: z.record(z.string(), z.string().optional()),
});

const presentChannel = (channel: ReturnType<typeof channelStore.list>[number]) => ({
  ...toPublicChannel(channel),
  status: channelManager.statusOf(channel.id),
});

app.get("/api/channels", (context) => context.json(channelStore.list().map(presentChannel)));

app.post("/api/channels", async (context) => {
  const channel = channelStore.save(channelInputSchema.parse(await context.req.json()));
  await channelManager.start(channel.id);
  return context.json(presentChannel(channel));
});

app.put("/api/channels/:channelId", async (context) => {
  const channelId = context.req.param("channelId");
  if (!channelStore.get(channelId)) throw new Error("Channel nicht gefunden");
  const channel = channelStore.save(channelInputSchema.parse(await context.req.json()), channelId);
  await channelManager.start(channel.id);
  return context.json(presentChannel(channel));
});

app.delete("/api/channels/:channelId", async (context) => {
  await channelManager.stop(context.req.param("channelId"));
  channelStore.remove(context.req.param("channelId"));
  eventHub.publish({ type: "channels_changed" });
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
  if (!audioData.length) throw new Error("Keine Audiodaten empfangen");
  if (audioData.length > 25 * 1024 * 1024) throw new Error("Aufnahme zu lang (max. 25 MB)");
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
  if (!uploadedFiles.length) throw new Error("Keine Datei erhalten");
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
app.delete("/api/environments/:environmentId", (context) => {
  environmentStore.remove(context.req.param("environmentId"));
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

app.get("/api/settings/model", (context) => context.json({ defaultModel: agentModelSettings.read() }));
app.put("/api/settings/model", async (context) => {
  const body = z.object({ defaultModel: z.string().trim().min(1) }).parse(await context.req.json());
  return context.json({ defaultModel: agentModelSettings.write(body.defaultModel) });
});

app.put("/api/claude/settings", async (context) => context.json(await claudeAuth.save(claudeSettingsSchema.parse(await context.req.json()))));

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
  if (!server) throw new Error("Server nicht gefunden");
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
startMemory();
startQuickChatCleanup();
importLegacyProjectDesignSystems();
watchDesignSystems();

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (address) => {
  console.log(`Harnold Core läuft auf http://${config.host}:${address.port}`);
});
injectWebSocket(server);
