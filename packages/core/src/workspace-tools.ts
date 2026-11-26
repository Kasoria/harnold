import { closeProjectTerminals } from "./terminal.ts";
import fs from "node:fs";
import path from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { chatItemStore, projectStore, sessionStore, type Project } from "./db.ts";
import { eventHub } from "./events.ts";
import { designSystemStore, virtualDesignSystemsPrefix, type DesignSystemDetail, type DesignSystemLinkTarget } from "./design-system.ts";
import { nextRunOf, runTask, scheduleTask, taskStore, unscheduleTask } from "./tasks.ts";
import { channelStore } from "./channels/store.ts";
import { mcpServerStore, skillStore } from "./integrations.ts";
import { claudeAuth } from "./claude-auth.ts";
import { voiceConfig } from "./voice.ts";
import { imageConfig } from "./image-generation.ts";
import { memoryConfig } from "./memory.ts";
import { environmentStore } from "./environments.ts";
import { environmentProviders } from "./environment-providers.ts";
import { sessionActions } from "./session-actions.ts";
import { createSetupTools, setupInstructions, setupReadOnlyToolNames } from "./setup-tools.ts";
import { createTeamTools, teamStore, teamToolNames } from "./agents.ts";
import { createMailTools, mailToolNames } from "./mail/tools.ts";
import { normalizeBackendId } from "./agent-backend-settings.ts";
import { mailAutonomyLabels, mailInboxStore } from "./mail/inbox.ts";
import { unwatchProject } from "./files.ts";
import { folderStore } from "./folders.ts";
import { secretInput } from "./secret-input.ts";
import { t } from "./i18n.ts";

/**
 * In-process MCP server giving the agent access to everything in Harnold (projects, sessions, design systems,
 * tasks, channels, integrations) – so a single chat can do what the screens do.
 */
export const workspaceServerName = "harnold";

const readOnlyToolNames = ["overview", "project_list", "session_list", "session_read", "design_system_list", "design_system_get", "task_list", "channel_list", "integration_list", "environment_list", "environment_check"];
/** Low-risk, Harnold-internal edits: no prompt (like memory_write). Everything else goes through the permission flow. */
const autoAllowedWriteToolNames = ["secret_request", "session_rename", "design_system_create", "design_system_link", "design_system_write_tokens", "design_system_write_file"];
export const workspaceToolNames = [...readOnlyToolNames, ...setupReadOnlyToolNames, ...autoAllowedWriteToolNames, ...teamToolNames, ...mailToolNames].map((toolName) => `mcp__${workspaceServerName}__${toolName}`);

export const workspaceInstructions = `
Harnold-Workspace (Tools ${workspaceServerName}): Du hast Zugriff auf alles in Harnold – Projekte, andere Sessions, Design Systems, Tasks, Channels, Integrationen, Umgebungen.
- Wenn der Nutzer etwas aus Harnold anspricht ("erstelle ein Design System und nutze es", "plane einen Task", "was lief in der anderen Session"), erledige es direkt mit diesen Tools – der Nutzer muss nichts manuell in den Screens verknüpfen.
- Umgebungen (Konten/Tokens je Kontext): environment_import_current übernimmt die auf dem Rechner angemeldeten Konten (gh, vercel, netlify, supabase, npm, git-Identität …) direkt im Core – Tokens laufen dabei nicht durch den Chat. environment_save legt an/ändert (auch Tokens, die der Nutzer nennt), environment_check prüft die Konten.
- Sessions: session_move verschiebt eine Session in ein anderes Projekt/eine andere Umgebung (Projekte via project_list), session_rename benennt um, session_delete löscht eine andere Session. Will der Nutzer in einer Quick-Chat- oder Channel-Unterhaltung an einem bestimmten Projekt arbeiten, verschiebe die aktuelle Session mit session_move dorthin.
- Überblick: overview. Design Systems: design_system_create (verknüpft standardmäßig mit diesem Projekt), design_system_link, design_system_write_tokens, design_system_write_file. Ein neu verknüpftes System gilt sofort; binde dessen tokens.css wie im Tool-Ergebnis beschrieben ein.
${setupInstructions}
`.trim();

const providerCatalogText = environmentProviders.map((provider) => `${provider.id} (${provider.label}): ${provider.fields.map((providerField) => providerField.key).join(", ")}`).join("; ");
const textResult = (text: string) => ({ content: [{ type: "text" as const, text }] });
const errorResult = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
const formatTime = (timestamp: number | null) => (timestamp ? new Date(timestamp).toLocaleString("de-DE") : "–");

function describeDesignSystem(designSystem: DesignSystemDetail): string {
  const projectName = (projectId: string) => projectStore.get(projectId)?.name ?? projectId;
  const linkLabels = designSystem.links.map((link) =>
    link.targetType === "project" ? `Projekt ${projectName(link.targetId)}` : `Session ${sessionStore.get(link.targetId)?.title ?? link.targetId} (${link.targetId})`,
  );
  return [
    `Design System „${designSystem.name}“ (id ${designSystem.id})`,
    `Ordner: ${designSystem.directory}`,
    `Einbinden in Entwürfen dieses Projekts: <link rel="stylesheet" href="../${virtualDesignSystemsPrefix}${designSystem.id}/tokens.css"> (aus design/…; Pfad relativ zur Datei anpassen). Im App-Code tokens.css bei Bedarf ins Projekt kopieren.`,
    `Verknüpft mit: ${linkLabels.join(", ") || "nichts"}`,
    `Tokens (${designSystem.flatTokens.length}): ${designSystem.flatTokens.slice(0, 60).map((flatToken) => `${flatToken.cssVariable}: ${flatToken.value}`).join("; ") || "keine"}`,
    `Komponenten: ${designSystem.components.map((component) => component.path).join(", ") || "keine"}`,
    designSystem.error ? `Fehler: ${designSystem.error}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function createWorkspaceServer(project: Project, sessionId: string, permissionMode: string | (() => string) = "default") {
  /** Resolves "session"/"project" shortcuts or explicit ids to a link target. */
  const resolveTarget = (target: "session" | "project", explicitId?: string): DesignSystemLinkTarget => {
    if (target === "session") {
      const targetSessionId = explicitId ?? sessionId;
      if (!sessionStore.get(targetSessionId)) throw new Error(t("Session {0} nicht gefunden", targetSessionId));
      return { targetType: "session", targetId: targetSessionId };
    }
    const targetProjectId = explicitId ?? project.id;
    if (!projectStore.get(targetProjectId)) throw new Error(t("Projekt {0} nicht gefunden", targetProjectId));
    return { targetType: "project", targetId: targetProjectId };
  };

  const safely =
    <Input,>(handler: (input: Input) => Promise<ReturnType<typeof textResult>> | ReturnType<typeof textResult>) =>
    async (input: Input) => {
      try {
        return await handler(input);
      } catch (toolError) {
        return errorResult(toolError instanceof Error ? toolError.message : String(toolError));
      }
    };

  return createSdkMcpServer({
    name: workspaceServerName,
    version: "1.0.0",
    tools: [
      ...createTeamTools(project, sessionId, permissionMode),
      ...createMailTools(sessionId),
      // ------------------------------------------------------------ Overview
      tool(
        "overview",
        "Überblick über Harnold: aktuelles Projekt/Session, geltendes Design System, Anzahl Projekte/Tasks/Channels/Integrationen und welche Funktionen eingerichtet sind.",
        {},
        safely(async () => {
          const linkedSystem = designSystemStore.resolveFor(project.id, sessionId);
          const claudeStatus = await claudeAuth.status();
          const voiceStatus = voiceConfig.present();
          const memoryStatus = memoryConfig.present();
          return textResult(
            [
              `Aktuelles Projekt: ${project.name} (id ${project.id}, ${project.path})`,
              `Aktuelle Session: ${sessionStore.get(sessionId)?.title ?? "–"} (id ${sessionId})`,
              `Umgebung hier: ${environmentStore.forProject(project.id)?.name ?? "keine (Standard-Konten des Rechners)"}`,
              `Design System hier: ${linkedSystem ? `${linkedSystem.name} (id ${linkedSystem.id})` : "keins verknüpft"}`,
              `Projekte: ${projectStore.list().length} · Design Systems: ${designSystemStore.list().length} · Tasks: ${taskStore.list().length} · Channels: ${channelStore.list().length} · Postfächer: ${mailInboxStore.list().length} · MCP-Server: ${mcpServerStore.list().length}`,
              `Eingerichtet: Claude ${claudeStatus.ready ? "ja" : "nein"} · Spracherkennung ${voiceStatus.sttReady ? "ja" : "nein"} · Sprachausgabe ${voiceStatus.ttsReady ? "ja" : "nein"} · Bilder ${imageConfig.present().ready ? "ja" : "nein"} · Semantische Memory-Suche ${memoryStatus.embeddingProvider !== "off" ? "ja" : "nein"}`,
              "Details und Ändern: settings_overview / settings_update.",
            ].join("\n"),
          );
        }),
        { annotations: { readOnlyHint: true } },
      ),

      // ------------------------------------------------------------ Projects & sessions
      tool(
        "project_list",
        "Listet alle Projekte in Harnold.",
        {},
        safely(() => textResult(projectStore.list().map((listedProject) => `${listedProject.name} – id ${listedProject.id} – ${listedProject.path}`).join("\n") || "Keine Projekte.")),
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        "environment_list",
        "Listet Umgebungen (Konten GitHub/Vercel, Git-Identität, Variablennamen – nie Werte) und ihre Projekte.",
        {},
        safely(() =>
          textResult(
            environmentStore
              .list()
              .map((environment) =>
                [
                  `${environment.name} – id ${environment.id}`,
                  `  Konten: ${[...environment.accounts.map((account) => `${account.label} [${account.setKeys.join(", ")}]`), environment.sshKeyPath && "SSH-Key"].filter(Boolean).join(", ") || "keine"}`,
                  `  Git: ${[environment.gitName, environment.gitEmail].filter(Boolean).join(" ") || "–"}`,
                  `  KI: ${({ inherit: "wie Einstellungen", subscription: "eigenes Claude-Konto", apiKey: "eigener API-Key", "backend:codex": "Codex", "backend:native": "Harnold-Agent" } as Record<string, string>)[environment.claudeMode] ?? "eigener Anbieter"} · Modell ${environment.model || "Standard"}`,
                  `  Variablen: ${environment.variables.map((variable) => variable.key).join(", ") || "keine"}`,
                  `  Projekte: ${environment.projectIds.map((projectId) => projectStore.get(projectId)?.name ?? projectId).join(", ") || "keine"}`,
                ].join("\n"),
              )
              .join("\n") || "Keine Umgebungen. Anlegen und Tokens eintragen macht der Nutzer im Screen Umgebungen.",
          ),
        ),
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        "project_set_environment",
        "Ordnet ein Projekt (Standard: aktuelles) einer Umgebung zu (environmentId null = keine). Gilt ab dem nächsten Durchlauf.",
        { environmentId: z.string().nullable(), projectId: z.string().optional() },
        safely(({ environmentId, projectId }) => {
          const targetProject = projectStore.get(projectId ?? project.id);
          if (!targetProject) throw new Error(t("Projekt nicht gefunden"));
          environmentStore.assignProject(targetProject.id, environmentId);
          return textResult(`${targetProject.name} → ${environmentId ? environmentStore.get(environmentId).name : "keine Umgebung"}. Gilt ab dem nächsten Durchlauf.`);
        }),
      ),
      tool(
        "project_delete",
        "Löscht ein Projekt (nur Harnolds Datensatz – der Ordner auf der Festplatte bleibt). Entfernt auch dessen Sessions, Tasks und Ordner-Freigaben. Quick Chats und das aktuelle Projekt lassen sich hier nicht löschen.",
        { projectId: z.string() },
        safely(({ projectId }) => {
          const targetProject = projectStore.get(projectId);
          if (!targetProject) throw new Error(t("Projekt nicht gefunden"));
          if (targetProject.kind === "quick") throw new Error(t("Quick Chats lassen sich nicht entfernen"));
          if (targetProject.id === project.id) throw new Error(t("Das aktuelle Projekt lässt sich hier nicht löschen – zuerst die Session verschieben oder es im Projekt-Screen entfernen"));
          unwatchProject(targetProject.id);
          environmentStore.assignProject(targetProject.id, null);
          for (const task of taskStore.list().filter((candidate) => candidate.projectId === targetProject.id)) {
            unscheduleTask(task.id);
            taskStore.remove(task.id);
          }
          eventHub.publish({ type: "tasks_changed" });
          folderStore.removeOwner("project", targetProject.id);
          closeProjectTerminals(targetProject.id);
          projectStore.remove(targetProject.id);
          return textResult(`Projekt „${targetProject.name}“ gelöscht.`);
        }),
        { annotations: { destructiveHint: true } },
      ),
      tool(
        "environment_import_current",
        "Übernimmt die aktuell auf diesem Rechner angemeldeten Konten (gh-Token, Vercel/Netlify/Supabase/Fly/Railway/npm/Sentry-Logins, passende Env-Variablen, git-Identität) in eine Umgebung – neu (name) oder bestehend (environmentId). Werte werden im Core gelesen und verschlüsselt gespeichert, nicht angezeigt.",
        {
          environmentId: z.string().optional(),
          name: z.string().optional().describe("Name einer neuen Umgebung"),
          providers: z.array(z.string()).optional().describe("Nur diese Anbieter-IDs; leer = alle erkennbaren"),
          assignCurrentProject: z.boolean().optional().describe("Aktuelles Projekt zuordnen (Standard true)"),
        },
        safely(async ({ environmentId, name, providers, assignCurrentProject }) => {
          if (!environmentId && !name) throw new Error(t("name (neue Umgebung) oder environmentId angeben"));
          const result = await environmentStore.importCurrent(environmentId, { name, providerIds: providers, addProjectIds: assignCurrentProject === false ? [] : [project.id] });
          return textResult(
            [
              `Umgebung „${result.environment.name}“ (id ${result.environment.id}) gespeichert.`,
              `Übernommen: ${result.found.join(", ") || "nichts"}.`,
              `Nicht gefunden: ${result.notFound.join(", ") || "–"}.`,
              `Git: ${[result.environment.gitName, result.environment.gitEmail].filter(Boolean).join(" ") || "–"}.`,
              `Projekte: ${result.environment.projectIds.map((projectId) => projectStore.get(projectId)?.name ?? projectId).join(", ") || "keine"}. Gilt ab dem nächsten Durchlauf.`,
            ].join("\n"),
          );
        }),
      ),
      tool(
        "environment_save",
        `Legt eine Umgebung an (ohne environmentId) oder ändert sie teilweise. Konten je Anbieter-ID mit ihren Feldern; Anbieter: ${providerCatalogText}. Alles andere als variables (secret true für Tokens).`,
        {
          environmentId: z.string().optional(),
          name: z.string().optional(),
          gitName: z.string().optional(),
          gitEmail: z.string().optional(),
          sshKeyPath: z.string().optional(),
          accounts: z.record(z.string(), z.record(z.string(), z.string())).optional().describe('z. B. { "github": { "GH_TOKEN": "…" }, "cloudflare": { "CLOUDFLARE_API_TOKEN": "…" } }'),
          removeAccounts: z.array(z.string()).optional(),
          claudeMode: z.enum(["inherit", "subscription", "apiKey"]).optional().describe("inherit = Einstellungen; subscription = eigenes Claude-Login (anmelden im Screen Umgebungen)"),
          claudeApiKey: z.string().optional(),
          model: z.string().optional().describe('Modell-ID, "" = aus den Einstellungen'),
          variables: z.array(z.object({ key: z.string(), value: z.string(), secret: z.boolean() })).optional(),
          removeVariables: z.array(z.string()).optional(),
          assignCurrentProject: z.boolean().optional(),
          addProjectIds: z.array(z.string()).optional(),
          removeProjectIds: z.array(z.string()).optional(),
        },
        safely(({ environmentId, assignCurrentProject, addProjectIds, ...patch }) => {
          const unknownProviders = Object.keys(patch.accounts ?? {}).filter((providerId) => !environmentProviders.some((provider) => provider.id === providerId));
          if (unknownProviders.length) throw new Error(t("Unbekannte Anbieter: {0} – dafür variables nutzen", unknownProviders.join(", ")));
          const environment = environmentStore.save(environmentId, { ...patch, addProjectIds: [...(addProjectIds ?? []), ...(assignCurrentProject ? [project.id] : [])] });
          return textResult(`Umgebung „${environment.name}“ (id ${environment.id}) gespeichert. Konten: ${environment.accounts.map((account) => account.label).join(", ") || "keine"}. Gilt ab dem nächsten Durchlauf.`);
        }),
      ),
      tool(
        "secret_request",
        "Fragt den Nutzer im Chat nach einem Secret (z. B. API-Key). Der Wert geht NICHT an dich: du erfährst nur, ob gespeichert wurde. Nutze das statt den Nutzer Keys in den Chat schreiben zu lassen. scope \"project\" (Standard): schreibt KEY=Wert sofort in eine Datei im Projektordner (file, Standard .env; wird in .gitignore eingetragen) – ideal, wenn du die .env zum Starten/Testen brauchst; nur für dieses Projekt. scope \"environment\": geheime Variable der Umgebung, gilt für alle Projekte der Umgebung und steht erst ab dem nächsten Durchlauf in der Shell.",
        {
          key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).describe("Variablenname, z. B. STRIPE_SECRET_KEY"),
          description: z.string().describe("Kurz für den Nutzer: wofür und wo er den Wert findet"),
          secret: z.boolean().optional().describe("Standard true; false für unkritische Werte"),
          scope: z.enum(["project", "environment"]).optional().describe("Standard project"),
          file: z.string().optional().describe("Nur scope project: Datei relativ zum Projektordner, Standard .env"),
        },
        safely(async ({ key, description, secret, scope, file }) => {
          const target = scope ?? "project";
          const envFile = file?.trim() || ".env";
          const outcome = await secretInput.request({ sessionId, projectId: project.id, key, description, secret: secret ?? true, scope: target, file: envFile });
          if (outcome !== "saved") return textResult(`Der Nutzer hat ${key} nicht eingegeben.`);
          return textResult(target === "project" ? `${key} wurde in ${envFile} (Projektordner) gespeichert und ist sofort lesbar.` : `${key} wurde gespeichert (Umgebungsvariable, ab dem nächsten Durchlauf verfügbar).`);
        }),
      ),
      tool(
        "environment_check",
        "Prüft bei den Anbietern, wem die Tokens einer Umgebung gehören.",
        { environmentId: z.string() },
        safely(async ({ environmentId }) => {
          const results = await environmentStore.checkAccounts(environmentId);
          return textResult(Object.entries(results).map(([providerId, check]) => `${providerId}: ${check.ok ? `ok – ${check.detail}` : `Fehler – ${check.detail}`}`).join("\n") || "Keine prüfbaren Konten.");
        }),
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        "environment_delete",
        "Löscht eine Umgebung; ihre Projekte nutzen danach die normalen Konten des Rechners.",
        { environmentId: z.string() },
        safely(({ environmentId }) => {
          const environment = environmentStore.get(environmentId);
          environmentStore.remove(environmentId);
          return textResult(`Umgebung „${environment.name}“ gelöscht.`);
        }),
      ),
      tool(
        "session_list",
        "Listet Sessions eines Projekts (Standard: aktuelles Projekt), neueste zuerst.",
        { projectId: z.string().optional() },
        safely(({ projectId }) => {
          const sessions = sessionStore.listByProject(projectId ?? project.id);
          return textResult(sessions.map((session) => `${session.title} – id ${session.id} – zuletzt ${formatTime(session.updatedAt)}`).join("\n") || "Keine Sessions.");
        }),
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        "session_read",
        "Liest den Verlauf einer anderen Session (Nutzer- und Assistenz-Texte, neueste zuletzt).",
        { sessionId: z.string(), limit: z.number().int().min(1).max(200).optional().describe("Anzahl letzter Einträge, Standard 40") },
        safely(({ sessionId: readSessionId, limit }) => {
          const session = sessionStore.get(readSessionId);
          if (!session) return errorResult("Session nicht gefunden");
          const textItems = chatItemStore
            .list(readSessionId)
            .flatMap((chatItem) => (chatItem.kind === "user_text" ? [`Nutzer: ${chatItem.text}`] : chatItem.kind === "assistant_text" ? [`Assistent: ${chatItem.text}`] : []));
          return textResult(`Session „${session.title}“ (Projekt ${projectStore.get(session.projectId)?.name ?? "?"})\n\n${textItems.slice(-(limit ?? 40)).join("\n\n") || "Leer."}`);
        }),
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        "session_rename",
        "Benennt eine Session um (Standard: aktuelle).",
        { title: z.string().min(1), sessionId: z.string().optional() },
        safely(({ title, sessionId: targetSessionId }) => {
          sessionActions.rename(targetSessionId ?? sessionId, title);
          return textResult(`Umbenannt in „${title}“.`);
        }),
      ),
      tool(
        "session_move",
        "Verschiebt eine Session (Standard: aktuelle) samt Agent-Kontext in ein anderes Projekt – damit auch in dessen Umgebung. Die aktuelle Session wird nach diesem Durchlauf verschoben.",
        { projectId: z.string(), sessionId: z.string().optional() },
        safely(({ projectId, sessionId: targetSessionId }) => {
          const targetProject = projectStore.get(projectId);
          if (!targetProject) throw new Error(t("Projekt nicht gefunden"));
          const { deferred } = sessionActions.move(targetSessionId ?? sessionId, targetProject.id);
          const environment = environmentStore.forProject(targetProject.id);
          return textResult(`${deferred ? "Wird nach diesem Durchlauf verschoben" : "Verschoben"} nach ${targetProject.name}${environment ? ` (Umgebung ${environment.name})` : ""}.`);
        }),
      ),
      tool(
        "session_delete",
        "Löscht eine Session samt Verlauf (die aktuelle Session lässt sich hier nicht löschen).",
        { sessionId: z.string() },
        safely(({ sessionId: targetSessionId }) => {
          if (targetSessionId === sessionId) throw new Error(t("Die aktuelle Session lässt sich hier nicht löschen"));
          const targetSession = sessionStore.get(targetSessionId);
          if (!targetSession) throw new Error(t("Session nicht gefunden"));
          sessionActions.remove(targetSessionId);
          return textResult(`Session „${targetSession.title}“ gelöscht.`);
        }),
        { annotations: { destructiveHint: true } },
      ),

      // ------------------------------------------------------------ Design systems
      tool(
        "design_system_list",
        "Listet alle Design Systems mit Verknüpfungen. Ein System kann mit beliebig vielen Projekten/Sessions verknüpft sein; Session-Verknüpfung geht vor Projekt.",
        {},
        safely(() =>
          textResult(
            designSystemStore
              .list()
              .map((summary) => `${summary.name} – id ${summary.id} – ${summary.tokenCount} Tokens – ${summary.links.length} Verknüpfungen`)
              .join("\n") || "Keine Design Systems.",
          ),
        ),
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        "design_system_get",
        "Details eines Design Systems: Ordner, Einbindung, Verknüpfungen, Tokens, Komponenten. Ohne id: das hier geltende System. Mit includeTokensJson das komplette tokens.json.",
        { designSystemId: z.string().optional(), includeTokensJson: z.boolean().optional() },
        safely(({ designSystemId, includeTokensJson }) => {
          const designSystem = designSystemId ? designSystemStore.get(designSystemId) : designSystemStore.resolveFor(project.id, sessionId);
          if (!designSystem) return textResult("Hier ist kein Design System verknüpft.");
          const tokensJson = includeTokensJson ? `\n\ntokens.json:\n${JSON.stringify(designSystem.tokens, null, 2)}` : "";
          return textResult(describeDesignSystem(designSystem) + tokensJson);
        }),
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        "design_system_create",
        "Legt ein Design System an. template starter = neutrale Tokens + Button/Karte, empty = leer (danach mit design_system_write_tokens füllen). linkTo verknüpft es direkt (Standard: dieses Projekt).",
        {
          name: z.string().min(1),
          template: z.enum(["starter", "empty"]).optional(),
          linkTo: z.enum(["project", "session", "none"]).optional(),
        },
        safely(({ name, template, linkTo }) => {
          const createdSystem = designSystemStore.create(name, template ?? "empty");
          const linkedSystem = (linkTo ?? "project") === "none" ? createdSystem : designSystemStore.setLinks(createdSystem.id, [resolveTarget(linkTo === "session" ? "session" : "project")]);
          return textResult(`Angelegt.\n${describeDesignSystem(linkedSystem)}`);
        }),
      ),
      tool(
        "design_system_link",
        "Verknüpft ein Design System mit einem Projekt oder einer Session (Standard: aktuelles Projekt bzw. diese Session) oder löst die Verknüpfung (unlink). Ein Ziel hat höchstens ein System – ein vorhandenes wird ersetzt.",
        {
          designSystemId: z.string(),
          target: z.enum(["project", "session"]),
          targetId: z.string().optional().describe("Projekt- bzw. Session-id; leer = aktuelles"),
          unlink: z.boolean().optional(),
        },
        safely(({ designSystemId, target, targetId, unlink }) => {
          const linkTarget = resolveTarget(target, targetId);
          const existingLinks = designSystemStore.get(designSystemId).links.filter((link) => !(link.targetType === linkTarget.targetType && link.targetId === linkTarget.targetId));
          const updatedSystem = designSystemStore.setLinks(designSystemId, unlink ? existingLinks : [...existingLinks, linkTarget]);
          return textResult(`${unlink ? "Verknüpfung gelöst" : "Verknüpft"}.\n${describeDesignSystem(updatedSystem)}`);
        }),
      ),
      tool(
        "design_system_write_tokens",
        "Ersetzt tokens.json eines Design Systems (DTCG-ähnlich: Gruppen, Werte oder { $value, $type }, Referenzen {color.accent}, $modes.dark für Dunkel-Overrides). tokens.css wird automatisch erzeugt.",
        { designSystemId: z.string(), tokens: z.record(z.string(), z.unknown()) },
        safely(({ designSystemId, tokens }) => {
          const updatedSystem = designSystemStore.writeTokens(designSystemId, tokens);
          return textResult(`Gespeichert: ${updatedSystem.flatTokens.length} Tokens${updatedSystem.error ? ` – Fehler: ${updatedSystem.error}` : ""}.`);
        }),
      ),
      tool(
        "design_system_write_file",
        "Schreibt eine Datei in ein Design System, z. B. components/button.html (bindet ../tokens.css ein) oder README.md. tokens.json über design_system_write_tokens.",
        { designSystemId: z.string(), path: z.string().describe("Relativer Pfad, z. B. components/card.html"), content: z.string() },
        safely(({ designSystemId, path: relativePath, content }) => {
          if (/^tokens\.(css|json)$/.test(relativePath)) return errorResult("tokens.json über design_system_write_tokens; tokens.css wird erzeugt.");
          const absolutePath = designSystemStore.resolveFile(designSystemId, relativePath);
          fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
          fs.writeFileSync(absolutePath, content);
          eventHub.publish({ type: "design_systems_changed" });
          return textResult(`Geschrieben: ${relativePath}`);
        }),
      ),
      tool(
        "design_system_delete",
        "Löscht ein Design System mit allen Dateien und Verknüpfungen.",
        { designSystemId: z.string() },
        safely(({ designSystemId }) => {
          designSystemStore.remove(designSystemId);
          return textResult("Gelöscht.");
        }),
        { annotations: { destructiveHint: true } },
      ),

      // ------------------------------------------------------------ Tasks
      tool(
        "task_list",
        "Listet geplante Tasks (Zeitplan, nächster Lauf, letzter Lauf).",
        {},
        safely(() =>
          textResult(
            taskStore
              .list()
              .map((task) => {
                const lastRun = taskStore.lastRun(task.id);
                return `${task.name} – id ${task.id} – Projekt ${projectStore.get(task.projectId)?.name ?? "?"} – "${task.schedule}" – ${task.enabled ? "aktiv" : "pausiert"} – nächster ${formatTime(nextRunOf(task))} – letzter ${lastRun ? `${formatTime(lastRun.startedAt)} (${lastRun.status})` : "–"}`;
              })
              .join("\n") || "Keine Tasks.",
          ),
        ),
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        "task_save",
        "Legt einen Task an oder ändert ihn (mit taskId). Ein Task startet zum Zeitplan (Cron, z. B. \"0 8 * * 1-5\") den Prompt – in einer neuen Session je Lauf oder fortlaufend in derselben (sessionMode). agentName: Teammitglied, das ihn ausführt (leer = Standard-Agent).",
        {
          taskId: z.string().optional(),
          name: z.string().min(1),
          prompt: z.string().min(1),
          schedule: z.string().describe("Cron-Ausdruck (Minute Stunde Tag Monat Wochentag)"),
          projectId: z.string().optional().describe("Standard: aktuelles Projekt"),
          enabled: z.boolean().optional(),
          permissionMode: z.enum(["default", "acceptEdits", "bypassPermissions", "plan"]).optional(),
          agentName: z.string().nullable().optional().describe("Name aus team_list; null = Standard-Agent"),
          sessionMode: z.enum(["new", "continue"]).optional().describe("new: neue Session je Lauf, continue: immer dieselbe Session"),
          directories: z.array(z.string()).optional().describe("Ordner, in denen die Läufe arbeiten dürfen (zusätzlich zum Projektordner)"),
          backendId: z.string().nullable().optional().describe("Agent-Programm (claude-code, codex, native) nur für diesen Task; null = wie Einstellungen/Umgebung, weglassen = unverändert"),
          model: z.string().nullable().optional().describe("Modell nur für diesen Task; null = Standard des Programms, weglassen = unverändert"),
        },
        safely(({ taskId, name, prompt, schedule, projectId, enabled, permissionMode, agentName, sessionMode, directories, backendId, model }) => {
          const existingTask = taskId ? taskStore.get(taskId) : undefined;
          if (taskId && !existingTask) return errorResult("Task nicht gefunden");
          const targetProjectId = projectId ?? existingTask?.projectId ?? project.id;
          if (!projectStore.get(targetProjectId)) return errorResult("Projekt nicht gefunden");
          let agentId = existingTask?.agentId ?? null;
          if (agentName === null || agentName === "") agentId = null;
          else if (agentName) {
            const teamAgent = teamStore.forProject(targetProjectId).find((agent) => agent.name.toLowerCase() === agentName.trim().toLowerCase());
            if (!teamAgent) return errorResult(`Kein Teammitglied „${agentName}“ in diesem Projekt`);
            agentId = teamAgent.id;
          }
          const savedTask = taskStore.save(
            {
              projectId: targetProjectId,
              name,
              prompt,
              schedule,
              enabled: enabled ?? existingTask?.enabled ?? true,
              permissionMode: permissionMode ?? existingTask?.permissionMode ?? "acceptEdits",
              model: model === undefined ? (existingTask?.model ?? null) : model,
              backendId: backendId === undefined ? (existingTask?.backendId ?? null) : normalizeBackendId(backendId),
              agentId,
              sessionMode: sessionMode ?? existingTask?.sessionMode ?? "new",
              cleanupAfterDays: existingTask?.cleanupAfterDays ?? null,
              contextResetRuns: existingTask?.contextResetRuns ?? null,
              directories: directories ?? existingTask?.directories ?? [],
              notifyChannelId: existingTask?.notifyChannelId ?? null,
              notifyChatId: existingTask?.notifyChatId ?? null,
            },
            taskId,
          );
          scheduleTask(savedTask);
          eventHub.publish({ type: "tasks_changed" });
          return textResult(`Gespeichert: ${savedTask.name} (id ${savedTask.id}), nächster Lauf ${formatTime(nextRunOf(savedTask))}.`);
        }),
      ),
      tool(
        "task_run",
        "Startet einen Task sofort (läuft im Hintergrund in einer neuen Session).",
        { taskId: z.string() },
        safely(({ taskId }) => {
          if (!taskStore.get(taskId)) return errorResult("Task nicht gefunden");
          void runTask(taskId).catch((runError) => console.error("[tasks]", runError));
          return textResult("Gestartet.");
        }),
      ),
      tool(
        "task_delete",
        "Löscht einen Task.",
        { taskId: z.string() },
        safely(({ taskId }) => {
          unscheduleTask(taskId);
          taskStore.remove(taskId);
          eventHub.publish({ type: "tasks_changed" });
          return textResult("Gelöscht.");
        }),
        { annotations: { destructiveHint: true } },
      ),

      // ------------------------------------------------------------ Channels & integrations
      tool(
        "channel_list",
        "Listet Channels (Telegram, Slack …), über die Harnold erreichbar ist. Einrichten mit Zugangsdaten macht der Nutzer im Channels-Screen.",
        {},
        safely(() => textResult(channelStore.list().map((channel) => `${channel.name} – ${channel.type} – id ${channel.id} – ${channel.enabled ? "aktiv" : "aus"} – ${channel.scope === "workspace" ? "ganz Harnold" : `Projekt ${projectStore.get(channel.projectId)?.name ?? "?"}`}`).join("\n") || "Keine Channels.")),
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        "integration_list",
        "Listet MCP-Server, Skills und E-Mail-Postfächer (mit Status).",
        {},
        safely(() => {
          const serverLines = mcpServerStore.list().map((server) => `MCP ${server.name} – ${server.transport} – ${server.enabled ? "aktiv" : "aus"}${server.projectId ? " – nur Projekt" : ""}`);
          const skillLines = skillStore.list(project).map((skill) => `Skill ${skill.name} (${skill.scope}) – ${skill.enabled ? "aktiv" : "aus"} – ${skill.description}`);
          const mailLines = mailInboxStore.list().map((inbox) => `Postfach ${inbox.name} – Agent ${inbox.agentId ? (teamStore.get(inbox.agentId)?.name ?? "?") : "Standard"} – ${mailAutonomyLabels[inbox.autonomy]} – ${inbox.enabled ? "aktiv" : "aus"}`);
          return textResult([...serverLines, ...skillLines, ...mailLines].join("\n") || "Keine Integrationen.");
        }),
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        "skill_set_enabled",
        "Aktiviert oder deaktiviert einen Skill für alle Sessions.",
        { skillName: z.string(), enabled: z.boolean() },
        safely(({ skillName, enabled }) => {
          skillStore.setEnabled(skillName, enabled);
          return textResult(`${skillName}: ${enabled ? "aktiv" : "aus"}.`);
        }),
      ),
      ...createSetupTools(project, safely),
    ],
  });
}
