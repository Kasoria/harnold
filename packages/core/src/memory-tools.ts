import fs from "node:fs";
import path from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Project } from "./db.ts";
import { eventHub } from "./events.ts";
import { memoryIndex, memoryNotes, type MemoryScope } from "./memory.ts";
import { memoryFiles } from "./memory-files.ts";
import { t } from "./i18n.ts";

export const memoryServerName = "harnold_memory";
export const memoryToolNames = ["memory_search", "memory_read", "memory_write", "memory_list", "memory_add_file"].map((toolName) => `mcp__${memoryServerName}__${toolName}`);

export const memoryInstructions = `
Langzeit-Gedächtnis (Tools ${memoryServerName}):
- Ebenen: "workspace" (projektübergreifend: Nutzer, Vorlieben, allgemeine Fakten), "environment" (alle Projekte der Umgebung, z. B. ein Kunde – nur wenn das Projekt einer Umgebung angehört) und "project" (dieses Projekt, liegt in memory/).
- Bei Fragen, die Vorwissen brauchen, zuerst memory_search nutzen.
- Speichern, wenn der Nutzer darum bittet oder dauerhaft relevante Fakten/Entscheidungen entstehen: memory_write. Eine Notiz pro Thema, sprechender Dateiname (z. B. entscheidungen/datenbank.md), Markdown mit # Titel, Obsidian-kompatibel ([[Wikilinks]] erlaubt). Vorhandene Notiz lieber ergänzen als duplizieren.
- Dateien (PDFs, Bilder, Dokumente – z. B. Anhänge einer Nachricht) als Kontext ablegen: memory_add_file. Sie erscheinen danach in jedem Durchlauf als Pfadliste.
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
    ],
  });
}
