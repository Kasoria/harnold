import fs from "node:fs";
import path from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Project } from "./db.ts";
import { eventHub } from "./events.ts";
import { memoryIndex, memoryNotes, type MemoryScope } from "./memory.ts";
import { memoryFiles } from "./memory-files.ts";
import { folderStore } from "./folders.ts";
import { environmentStore } from "./environments.ts";
import { t } from "./i18n.ts";

export const memoryServerName = "harnold_memory";
export const memoryToolNames = ["memory_search", "memory_read", "memory_write", "memory_list", "memory_add_file", "memory_list_folders", "memory_add_folder", "memory_remove_folder"].map((toolName) => `mcp__${memoryServerName}__${toolName}`);

export const memoryInstructions = `
Langzeit-Gedächtnis (Tools ${memoryServerName}):
- Ebenen: "workspace" (projektübergreifend: Nutzer, Vorlieben, allgemeine Fakten), "environment" (alle Projekte der Umgebung, z. B. ein Kunde – nur wenn das Projekt einer Umgebung angehört) und "project" (dieses Projekt, liegt in memory/).
- Bei Fragen, die Vorwissen brauchen, zuerst memory_search nutzen.
- Speichern, wenn der Nutzer darum bittet oder dauerhaft relevante Fakten/Entscheidungen entstehen: memory_write. Eine Notiz pro Thema, sprechender Dateiname (z. B. entscheidungen/datenbank.md), Markdown mit # Titel, Obsidian-kompatibel ([[Wikilinks]] erlaubt). Vorhandene Notiz lieber ergänzen als duplizieren.
- Löschen: memory_delete.
- Dateien (PDFs, Bilder, Dokumente – z. B. Anhänge einer Nachricht) als Kontext ablegen: memory_add_file. Sie erscheinen danach in jedem Durchlauf als Pfadliste.
- Ordner anhängen (Code, Doku, Assets außerhalb des Projektordners): memory_add_folder mit Ebene und absolutem Pfad. Angehängte Ordner gehören dann zum Kontext jeder Session der Ebene (Lese-/Schreibzugriff, Dateibaum, Git, Terminal) und stehen im Systemprompt. Sie gelten ab der nächsten Nachricht. Ansehen: memory_list_folders, lösen (Platte bleibt unberührt): memory_remove_folder.
- HARNOLD.md (Projekt-Root, Umgebungs- bzw. Workspace-Memory) enthält dauerhafte Anweisungen und wird automatisch geladen.
`.trim();

const scopeSchema = z.enum(["workspace", "environment", "project"]);
const textResult = (text: string) => ({ content: [{ type: "text" as const, text }] });

/** In-process MCP server giving the agent read/write access to Harnold memory. */
export function createMemoryServer(project: Project) {
  const noteRef = (scope: MemoryScope, notePath: string) => ({ scope, projectId: scope === "workspace" ? null : project.id, path: notePath });

  return createSdkMcpServer({
    name: memoryServerName,
    version: "1.0.0",
    tools: [
      tool(
        "memory_search",
        "Durchsucht das Gedächtnis (Volltext + semantisch). Liefert Pfade, Titel und Ausschnitte.",
        { query: z.string().describe("Suchbegriffe oder Frage"), scope: z.enum(["all", "workspace", "environment", "project"]).optional(), limit: z.number().int().min(1).max(20).optional() },
        async ({ query, scope, limit }) => {
          const searchHits = await memoryIndex.search(query, project.id, scope ?? "all", limit ?? 8);
          if (!searchHits.length) return textResult("Keine Treffer.");
          return textResult(searchHits.map((searchHit) => `[${searchHit.scope}] ${searchHit.path} – ${searchHit.title}\n${searchHit.snippet}`).join("\n\n"));
        },
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        "memory_read",
        "Liest eine Notiz vollständig.",
        { scope: scopeSchema, path: z.string() },
        async ({ scope, path }) => textResult(memoryNotes.read(noteRef(scope, path))),
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        "memory_list",
        "Listet Notizen einer Ebene (neueste zuerst).",
        { scope: scopeSchema },
        async ({ scope }) => {
          const noteSummaries = memoryIndex.list(project.id).filter((noteSummary) => noteSummary.scope === scope);
          return textResult(noteSummaries.map((noteSummary) => `${noteSummary.path} – ${noteSummary.title}`).join("\n") || "Keine Notizen.");
        },
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        "memory_write",
        "Legt eine Notiz an, ersetzt sie (mode=replace) oder hängt Text an (mode=append).",
        { scope: scopeSchema, path: z.string().describe("Relativer Pfad, .md wird ergänzt"), content: z.string(), mode: z.enum(["replace", "append"]).optional() },
        async ({ scope, path, content, mode }) => {
          const savedPath = await memoryNotes.write(noteRef(scope, path), content, mode ?? "replace");
          return textResult(`Gespeichert: [${scope}] ${savedPath}`);
        },
      ),
      tool(
        "memory_add_file",
        "Kopiert eine Datei ins Gedächtnis (Ordner dateien/ der Ebene), z. B. einen Anhang. Danach sieht jeder Durchlauf der Ebene die Datei.",
        {
          scope: scopeSchema,
          sourcePath: z.string().describe("Pfad relativ zum Projekt (z. B. attachments/…) oder absolut"),
          name: z.string().optional().describe("Dateiname im Gedächtnis, leer = wie Quelle"),
        },
        async ({ scope, sourcePath, name }) => {
          try {
            const absoluteSource = path.resolve(project.path, sourcePath.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
            if (!fs.existsSync(absoluteSource) || !fs.statSync(absoluteSource).isFile()) throw new Error(t("Datei nicht gefunden: {0}", sourcePath));
            const fileName = name?.trim() || path.basename(absoluteSource).replace(/^\d{8}-\d{6}-/, ""); // drop the attachment timestamp
            const savedFile = memoryFiles.save(scope, scope === "workspace" ? null : project, fileName, fs.readFileSync(absoluteSource));
            eventHub.publish({ type: "memory_changed", projectId: project.id });
            return textResult(`Abgelegt: [${scope}] ${savedFile.path}`);
          } catch (toolError) {
            return { ...textResult(toolError instanceof Error ? toolError.message : String(toolError)), isError: true };
          }
        },
      ),
      tool(
        "memory_list_folders",
        "Listet die Ordner, die dem Projekt als Kontext angehängt sind (Projekt-, Umgebungs- und Workspace-Ebene).",
        {},
        async () => {
          const folders = folderStore.forProject(project.id);
          return textResult(folders.map((folder) => `[${folder.scope}] ${folder.path}`).join("\n") || "Keine Ordner angehängt.");
        },
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        "memory_add_folder",
        "Hängt einen Ordner des Servers als Kontext an: Er gehört danach zu jeder Session der Ebene (project = nur dieses Projekt, environment = alle Projekte der Umgebung, workspace = alle Projekte).",
        { scope: scopeSchema, path: z.string().describe("Absoluter Pfad des Ordners (oder ~/…)") },
        async ({ scope, path: folderPath }) => {
          try {
            const environment = environmentStore.forProject(project.id);
            if (scope === "environment" && !environment) throw new Error(t("Projekt gehört zu keiner Umgebung"));
            const ownerId = scope === "workspace" ? "" : scope === "project" ? project.id : environment!.id;
            const addedFolder = folderStore.add(scope, ownerId, folderPath);
            eventHub.publish({ type: "folders_changed" });
            return textResult(`Angehängt: [${scope}] ${addedFolder.path} (gilt ab der nächsten Nachricht)`);
          } catch (toolError) {
            return { ...textResult(toolError instanceof Error ? toolError.message : String(toolError)), isError: true };
          }
        },
      ),
      tool(
        "memory_remove_folder",
        "Löst einen angehängten Ordner von der Ebene. Auf der Platte ändert sich nichts.",
        { scope: scopeSchema, path: z.string() },
        async ({ scope, path: folderPath }) => {
          try {
            const environment = environmentStore.forProject(project.id);
            if (scope === "environment" && !environment) throw new Error(t("Projekt gehört zu keiner Umgebung"));
            folderStore.remove(scope, scope === "workspace" ? "" : scope === "project" ? project.id : environment!.id, folderPath);
            eventHub.publish({ type: "folders_changed" });
            return textResult(`Gelöst: [${scope}] ${folderPath}`);
          } catch (toolError) {
            return { ...textResult(toolError instanceof Error ? toolError.message : String(toolError)), isError: true };
          }
        },
      ),
      tool(
        "memory_delete",
        "Löscht eine Notiz.",
        { scope: scopeSchema, path: z.string() },
        async ({ scope, path }) => {
          await memoryNotes.remove(noteRef(scope, path));
          eventHub.publish({ type: "memory_changed", projectId: project.id });
          return textResult(`Gelöscht: [${scope}] ${path}`);
        },
        { annotations: { destructiveHint: true } },
      ),
    ],
  });
}
