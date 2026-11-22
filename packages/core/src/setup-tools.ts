import fs from "node:fs";
import path from "node:path";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { config } from "./config.ts";
import { projectStore, type Project } from "./db.ts";
import { eventHub } from "./events.ts";
import { watchProject } from "./files.ts";
import { agentModelSettings, claudeAuth } from "./claude-auth.ts";
import { voiceConfig, voiceSecretKeys } from "./voice.ts";
import { imageConfig } from "./image-generation.ts";
import { memoryConfig, memoryIndex } from "./memory.ts";
import { environmentStore } from "./environments.ts";
import { mcpServerInputSchema, mcpServerStore, skillStore } from "./integrations.ts";
import { pluginStore } from "./plugins.ts";
import { channelStore } from "./channels/store.ts";
import { channelFieldDefinitions } from "./channels/types.ts";
import { t } from "./i18n.ts";

/**
 * Tools that let the agent set Harnold up itself (projects, settings, integrations, plugins, channels, skills),
 * so a first setup can happen entirely in chat. Secrets are stored but never echoed back.
 */

/** Creates a project record + folder, like the "Neues Projekt" dialog. */
export function createProjectRecord(name: string, projectPath?: string, environmentId?: string | null): Project {
  const folderName = name.trim().replace(/[^\w.-]+/g, "-").toLowerCase();
  const resolvedPath = path.resolve((projectPath?.trim() || path.join(config.projectsDirectory, folderName)).replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
  fs.mkdirSync(resolvedPath, { recursive: true });
  const project = projectStore.create(name.trim(), resolvedPath);
  if (environmentId) environmentStore.assignProject(project.id, environmentId);
  watchProject(project);
  void memoryIndex.reindex("project", project);
  eventHub.publish({ type: "projects_changed" });
  return project;
}

/** Read-only setup tools (no permission prompt). Writes go through the normal permission flow. */
export const setupReadOnlyToolNames = ["settings_overview", "plugin_list"];

export const setupInstructions = `
Harnold einrichten (Tools harnold): Der Nutzer kann Harnold komplett im Chat einrichten. Erledige solche Wünsche direkt:
- Projekte: project_create, project_update (Name, Emoji-Icon), project_set_environment.
- Kontext: memory_write für Notizen, memory_add_file für Dateien (z. B. Anhänge dieser Nachricht) – Ebene "project", "environment" (alle Projekte der Umgebung) oder "workspace" (alle Projekte). HARNOLD.md einer Ebene = dauerhafte Anweisungen.
- Einstellungen: settings_overview zeigt den Stand, settings_update ändert Standardmodell, Quick-Chat-Aufräumen, Memory (Ordner, Embeddings), Bilder und Sprache – auch API-Keys, wenn der Nutzer sie nennt.
- Integrationen: mcp_server_save/mcp_server_delete, skill_create, skill_set_enabled, plugin_list/plugin_set_enabled/plugin_add_folder. Channels: channel_save/channel_delete.
- API-Keys und Tokens nie in Antworten wiederholen, nur bestätigen, dass sie gesetzt sind.
`.trim();

/** Must match the symbol set of the UI's icon picker (apps/ui/src/lib/entity-icons.ts). */
export const entityIconNames = [
  "folder", "briefcase", "building-2", "house", "user", "users", "globe", "code", "terminal", "database", "server", "cloud", "smartphone", "monitor",
  "palette", "pen-tool", "camera", "film", "music", "book-open", "graduation-cap", "flask-conical", "rocket", "lightbulb", "sparkles", "bot", "brain",
  "shopping-cart", "credit-card", "chart-line", "megaphone", "mail", "message-circle", "calendar", "heart", "star", "leaf", "coffee", "shield", "wrench",
];
const iconHint = `("lucide:<name>", Namen: ${entityIconNames.join(", ")}). Optional Hintergrund anhängen: ";bg=none" (ohne), ";bg=auto" oder ";bg=<Farbton 0–360>" – z. B. "lucide:rocket;bg=265", "🚀;bg=145". Nur ";bg=145" = Buchstabe in dieser Farbe`;

const textResult = (text: string) => ({ content: [{ type: "text" as const, text }] });
const yesNo = (value: boolean) => (value ? "ja" : "nein");

const channelTypeSchema = z.enum(["telegram", "discord", "slack", "email"]);
const channelFieldsText = Object.entries(channelFieldDefinitions)
  .map(([channelType, fields]) => `${channelType}: settings ${fields.settings.join(", ") || "–"}; secrets ${fields.secrets.join(", ")}`)
  .join(" · ");

// Loaded on use: both import the agent runtime, which imports these tools (cycle).
const loadChannelManager = async () => (await import("./channels/manager.ts")).channelManager;
const loadQuickChatSettings = async () => (await import("./quick-chats.ts")).quickChatSettings;

type Safely = <Input>(handler: (input: Input) => Promise<ReturnType<typeof textResult>> | ReturnType<typeof textResult>) => (input: Input) => Promise<ReturnType<typeof textResult>>;

export function createSetupTools(project: Project, safely: Safely) {
  const requireProject = (projectId: string | undefined) => {
    const foundProject = projectStore.get(projectId ?? project.id);
    if (!foundProject) throw new Error(t("Projekt {0} nicht gefunden", projectId));
    return foundProject;
  };

  return [
    // ------------------------------------------------------------ Projects
    tool(
      "project_create",
      "Legt ein neues Projekt an (Ordner wird erstellt, Standard: Harnold-Projektordner). Optional direkt in eine Umgebung.",
      { name: z.string().min(1), path: z.string().optional().describe("Absoluter Ordner, leer = Standardordner"), environmentId: z.string().optional() },
      safely(({ name, path: projectPath, environmentId }) => {
        const createdProject = createProjectRecord(name, projectPath, environmentId);
        return textResult(`Projekt „${createdProject.name}“ angelegt (id ${createdProject.id}, ${createdProject.path}).`);
      }),
    ),
    tool(
      "project_update",
      `Benennt ein Projekt um oder setzt sein Icon: ein Emoji oder ein Symbol ${iconHint} (leer = Buchstabe). Ohne projectId: dieses Projekt.`,
      { projectId: z.string().optional(), name: z.string().min(1).optional(), icon: z.string().max(40).optional() },
      safely(({ projectId, name, icon }) => {
        const targetProject = requireProject(projectId);
        projectStore.update(targetProject.id, { name: name?.trim(), icon: icon === undefined ? undefined : icon.trim() || null });
        eventHub.publish({ type: "projects_changed" });
        return textResult(`Projekt „${projectStore.get(targetProject.id)?.name}“ aktualisiert.`);
      }),
    ),

    tool(
      "environment_set_icon",
      `Setzt das Icon einer Umgebung (id aus environment_list): ein Emoji oder ein Symbol ${iconHint} (leer = Buchstabe).`,
      { environmentId: z.string(), icon: z.string().max(40) },
      safely(({ environmentId, icon }) => {
        const updatedEnvironment = environmentStore.setIcon(environmentId, icon.trim() || null);
        return textResult(`Icon von „${updatedEnvironment.name}“ gesetzt.`);
      }),
    ),

    // ------------------------------------------------------------ Settings
    tool(
      "settings_overview",
      "Zeigt alle Einstellungen (ohne Geheimnisse): Standardmodell, Claude-Zugang, Quick Chats, Memory, Bilder, Sprache.",
      {},
      safely(async () => {
        const claudeStatus = await claudeAuth.status();
        const memorySettings = memoryConfig.present();
        const imageSettings = imageConfig.present();
        const voiceSettings = voiceConfig.present();
        return textResult(
          [
            `Standardmodell: ${agentModelSettings.read()}`,
            `Claude-Zugang eingerichtet: ${yesNo(claudeStatus.ready)} (Anmeldung macht der Nutzer im Einstellungen-Screen)`,
            `Quick Chats automatisch löschen nach: ${(await loadQuickChatSettings()).read().autoDeleteDays ?? "nie"} Tagen`,
            `Memory: Workspace-Ordner ${memorySettings.resolvedWorkspaceDirectory} · Embeddings ${memorySettings.embeddingProvider}${memorySettings.embeddingModel ? ` (${memorySettings.embeddingModel})` : ""} · OpenAI-Key ${yesNo(memorySettings.openaiKeySet)}`,
            `Bilder: Anbieter ${imageSettings.provider} · Gemini-Modell ${imageSettings.geminiModel || "Standard"} · OpenAI-Modell ${imageSettings.openaiModel || "Standard"} · Keys: Gemini ${yesNo(imageSettings.secretsSet.geminiApiKey)}, OpenAI ${yesNo(imageSettings.secretsSet.openaiApiKey)} · bereit ${yesNo(imageSettings.ready)}`,
            `Sprache: Erkennung ${voiceSettings.sttProvider} · Ausgabe ${voiceSettings.ttsProvider} · Sprache ${voiceSettings.language} · Optionen ${JSON.stringify(voiceSettings.options)} · Keys gesetzt: ${Object.entries(voiceSettings.secretsSet).filter(([, isSet]) => isSet).map(([secretKey]) => secretKey).join(", ") || "keine"} · mögliche Keys: ${voiceSecretKeys.join(", ")}`,
          ].join("\n"),
        );
      }),
      { annotations: { readOnlyHint: true } },
    ),
    tool(
      "settings_update",
      "Ändert Einstellungen; nur angegebene Felder werden geändert. API-Keys werden verschlüsselt gespeichert (leer = unverändert).",
      {
        defaultModel: z.string().optional().describe("z. B. claude-opus-5-5"),
        quickChatAutoDeleteDays: z.number().int().min(1).nullable().optional().describe("null = nie löschen"),
        memory: z
          .object({ workspaceDirectory: z.string().optional(), embeddingProvider: z.enum(["off", "openai", "ollama"]).optional(), embeddingModel: z.string().optional(), ollamaUrl: z.string().optional(), openaiApiKey: z.string().optional() })
          .optional(),
        images: z
          .object({ provider: z.enum(["none", "gemini", "openai"]).optional(), geminiModel: z.string().optional(), openaiModel: z.string().optional(), geminiApiKey: z.string().optional(), openaiApiKey: z.string().optional() })
          .optional(),
        voice: z
          .object({ sttProvider: z.string().optional(), ttsProvider: z.string().optional(), language: z.string().optional(), options: z.record(z.string(), z.string()).optional(), secrets: z.record(z.string(), z.string()).optional() })
          .optional(),
      },
      safely(async ({ defaultModel, quickChatAutoDeleteDays, memory, images, voice }) => {
        const changedAreas: string[] = [];
        if (defaultModel) {
          agentModelSettings.write(defaultModel);
          changedAreas.push("Standardmodell");
        }
        if (quickChatAutoDeleteDays !== undefined) {
          (await loadQuickChatSettings()).write({ autoDeleteDays: quickChatAutoDeleteDays });
          changedAreas.push("Quick Chats");
        }
        if (memory) {
          const { openaiApiKey, ...memoryChanges } = memory;
          memoryConfig.save({ ...memoryConfig.read(), ...memoryChanges }, openaiApiKey);
          changedAreas.push("Memory");
        }
        if (images) {
          const { geminiApiKey, openaiApiKey, ...imageChanges } = images;
          imageConfig.save({ ...imageConfig.read(), ...imageChanges } as ReturnType<typeof imageConfig.read>, { geminiApiKey, openaiApiKey });
          changedAreas.push("Bilder");
        }
        if (voice) {
          const currentVoice = voiceConfig.read();
          const { secrets, options, ...voiceChanges } = voice;
          voiceConfig.save({ ...currentVoice, ...voiceChanges, options: { ...currentVoice.options, ...options } } as typeof currentVoice, secrets ?? {});
          changedAreas.push("Sprache");
        }
        if (changedAreas.length) eventHub.publish({ type: "settings_changed" });
        return textResult(changedAreas.length ? `Gespeichert: ${changedAreas.join(", ")}.` : "Nichts geändert.");
      }),
    ),

    // ------------------------------------------------------------ Integrations
    tool(
      "mcp_server_save",
      "Legt einen MCP-Server an oder ändert ihn (serverId). stdio: command + args; http/sse: url. env/headers sind geheim.",
      {
        serverId: z.string().optional(),
        name: z.string(),
        scope: z.enum(["workspace", "project"]).default("workspace"),
        transport: z.enum(["stdio", "http", "sse"]),
        command: z.string().default(""),
        args: z.array(z.string()).default([]),
        url: z.string().default(""),
        env: z.record(z.string(), z.string()).default({}),
        headers: z.record(z.string(), z.string()).default({}),
        autoAllow: z.boolean().default(false),
        enabled: z.boolean().default(true),
      },
      safely(({ serverId, ...serverFields }) => {
        const serverInput = mcpServerInputSchema.parse({ ...serverFields, projectId: serverFields.scope === "project" ? project.id : null });
        const savedServer = mcpServerStore.save(serverInput, serverId);
        eventHub.publish({ type: "integrations_changed" });
        return textResult(`MCP-Server „${savedServer.name}“ gespeichert (id ${savedServer.id}). Gilt ab der nächsten Nachricht.`);
      }),
    ),
    tool(
      "mcp_server_delete",
      "Entfernt einen MCP-Server (id aus integration_list).",
      { serverId: z.string() },
      safely(({ serverId }) => {
        mcpServerStore.remove(serverId);
        eventHub.publish({ type: "integrations_changed" });
        return textResult("MCP-Server entfernt.");
      }),
    ),
    tool(
      "skill_create",
      "Legt einen Skill an (Anweisungen als Markdown). scope user = alle Projekte, project = nur dieses.",
      { scope: z.enum(["user", "project"]), name: z.string().regex(/^[a-z0-9-]{1,64}$/, "Name: kleinbuchstaben-mit-bindestrich"), description: z.string().min(1), instructions: z.string().min(1) },
      safely(({ scope, name, description, instructions }) => {
        skillStore.create(scope, scope === "project" ? project : null, name, description, instructions);
        eventHub.publish({ type: "integrations_changed" });
        return textResult(`Skill „${name}“ angelegt.`);
      }),
    ),
    tool(
      "plugin_list",
      "Listet Plugins (aus Claude Code, Claude Desktop und eigenen Ordnern) mit Status.",
      {},
      safely(() => textResult(pluginStore.list().map((plugin) => `${plugin.name} – id ${plugin.id} – ${plugin.source} – ${plugin.enabled ? "aktiv" : "aus"} – ${plugin.description}`).join("\n") || "Keine Plugins gefunden.")),
      { annotations: { readOnlyHint: true } },
    ),
    tool(
      "plugin_set_enabled",
      "Aktiviert oder deaktiviert ein Plugin (id aus plugin_list).",
      { pluginId: z.string(), enabled: z.boolean() },
      safely(({ pluginId, enabled }) => {
        pluginStore.setEnabled(pluginId, enabled);
        eventHub.publish({ type: "integrations_changed" });
        return textResult(`Plugin ${enabled ? "aktiviert" : "deaktiviert"}.`);
      }),
    ),
    tool(
      "plugin_add_folder",
      "Bindet einen Plugin-Ordner ein (absoluter Pfad mit .claude-plugin/plugin.json).",
      { path: z.string() },
      safely(({ path: folderPath }) => {
        const addedPlugin = pluginStore.addFolder(folderPath);
        eventHub.publish({ type: "integrations_changed" });
        return textResult(`Plugin „${addedPlugin.name}“ eingebunden.`);
      }),
    ),

    // ------------------------------------------------------------ Channels
    tool(
      "channel_save",
      `Richtet einen Channel ein oder ändert ihn (channelId), über den Harnold erreichbar ist, und startet ihn. Felder je Typ – ${channelFieldsText}. allowedSenders = erlaubte Absender-IDs/Adressen (leer = niemand).`,
      {
        channelId: z.string().optional(),
        type: channelTypeSchema,
        name: z.string().min(1),
        scope: z.enum(["project", "workspace"]).default("project").describe('"workspace" = ganze Harnold-Instanz (startet in Quick Chats, Wechsel per /projekt), "project" = nur projectId'),
        projectId: z.string().optional().describe("Projekt für eingehende Nachrichten bei scope project, leer = dieses"),
        enabled: z.boolean().default(true),
        permissionMode: z.enum(["default", "acceptEdits", "bypassPermissions", "plan"]).default("default"),
        allowedSenders: z.array(z.string()).default([]),
        voiceReplies: z.enum(["off", "voice", "always"]).default("voice"),
        settings: z.record(z.string(), z.string()).default({}),
        secrets: z.record(z.string(), z.string()).default({}),
      },
      safely(async ({ channelId, projectId, ...channelFields }) => {
        if (channelId && !channelStore.get(channelId)) throw new Error(t("Channel nicht gefunden"));
        const startProjectId = channelFields.scope === "workspace" ? (await import("./quick-chats.ts")).quickChatProject().id : requireProject(projectId).id;
        const savedChannel = channelStore.save({ ...channelFields, projectId: startProjectId }, channelId);
        const channelManager = await loadChannelManager();
        await channelManager.start(savedChannel.id);
        return textResult(`Channel „${savedChannel.name}“ gespeichert (id ${savedChannel.id}), Status: ${JSON.stringify(channelManager.statusOf(savedChannel.id))}.`);
      }),
    ),
    tool(
      "channel_delete",
      "Entfernt einen Channel (id aus channel_list).",
      { channelId: z.string() },
      safely(async ({ channelId }) => {
        await (await loadChannelManager()).stop(channelId);
        channelStore.remove(channelId);
        eventHub.publish({ type: "channels_changed" });
        return textResult("Channel entfernt.");
      }),
    ),
  ];
}
