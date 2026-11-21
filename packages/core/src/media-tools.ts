import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Project } from "./db.ts";
import { aspectRatios, generateImages, imageConfig } from "./image-generation.ts";

export const mediaServerName = "harnold_media";

export const mediaInstructions = `
Bilder: Mit dem Tool generate_image (${mediaServerName}) erzeugst du Bilder (Fotos, Illustrationen, Moodboards). Sie landen unter assets/generated/ und auf dem Canvas. Für Varianten oder Bearbeitungen vorhandene Bilder als references übergeben. In Entwürfen relativ einbinden (z. B. ../assets/generated/x.png). Erzeugte Bilder und Bildpfade in deiner Antwort (z. B. assets/generated/x.png) sieht der Nutzer im Chat als Vorschau.
`.trim();

/** In-process MCP server for media generation. Not auto-allowed: each call costs money and goes through the permission flow. */
export function createMediaServer(project: Project) {
  return createSdkMcpServer({
    name: mediaServerName,
    version: "1.0.0",
    tools: [
      tool(
        "generate_image",
        "Erzeugt Bilder per Bild-KI, speichert sie unter assets/generated/ und legt sie auf den Canvas. Liefert die Pfade.",
        {
          prompt: z.string().describe("Ausführliche Bildbeschreibung (Motiv, Stil, Licht, Komposition)"),
          references: z.array(z.string()).max(4).optional().describe("Projektpfade vorhandener Bilder als Vorlage"),
          aspectRatio: z.enum(aspectRatios).optional(),
          count: z.number().int().min(1).max(4).optional(),
        },
        async ({ prompt, references, aspectRatio, count }) => {
          if (!imageConfig.present().ready) {
            return { content: [{ type: "text", text: "Bild-Generierung ist nicht eingerichtet (Einstellungen → Bilder)." }], isError: true };
          }
          const imagePaths = await generateImages(project, { prompt, referencePaths: references ?? [], aspectRatio: aspectRatio ?? "1:1", count: count ?? 1, anchor: null });
          return { content: [{ type: "text", text: `Erzeugt:\n${imagePaths.join("\n")}` }] };
        },
      ),
    ],
  });
}
