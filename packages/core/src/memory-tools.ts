import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Project } from "./db.ts";
import { memoryIndex, memoryNotes, type MemoryScope } from "./memory.ts";

export const memoryServerName = "harnold_memory";
export const memoryToolNames = ["memory_search", "memory_read", "memory_write", "memory_list"].map((toolName) => `mcp__${memoryServerName}__${toolName}`);

export const memoryInstructions = `
Langzeit-Gedächtnis (Tools ${memoryServerName}):
- Zwei Ebenen: "workspace" (projektübergreifend: Nutzer, Vorlieben, allgemeine Fakten) und "project" (dieses Projekt, liegt in memory/).
- Bei Fragen, die Vorwissen brauchen, zuerst memory_search nutzen.
- Speichern, wenn der Nutzer darum bittet oder dauerhaft relevante Fakten/Entscheidungen entstehen: memory_write. Eine Notiz pro Thema, sprechender Dateiname (z. B. entscheidungen/datenbank.md), Markdown mit # Titel, Obsidian-kompatibel ([[Wikilinks]] erlaubt). Vorhandene Notiz lieber ergänzen als duplizieren.
- HARNOLD.md (Projekt-Root bzw. Workspace-Memory) enthält dauerhafte Anweisungen und wird automatisch geladen.
`.trim();

const scopeSchema = z.enum(["workspace", "project"]);
const textResult = (text: string) => ({ content: [{ type: "text" as const, text }] });

/** In-process MCP server giving the agent read/write access to Harnold memory. */
export function createMemoryServer(project: Project) {
  const noteRef = (scope: MemoryScope, notePath: string) => ({ scope, projectId: scope === "project" ? project.id : null, path: notePath });

  return createSdkMcpServer({
    name: memoryServerName,
    version: "1.0.0",
    tools: [
      tool(
        "memory_search",
        "Durchsucht das Gedächtnis (Volltext + semantisch). Liefert Pfade, Titel und Ausschnitte.",
        { query: z.string().describe("Suchbegriffe oder Frage"), scope: z.enum(["all", "workspace", "project"]).optional(), limit: z.number().int().min(1).max(20).optional() },
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
    ],
  });
}
