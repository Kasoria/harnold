import fs from "node:fs";
import path from "node:path";
import type { Attachment, Project } from "./db.ts";
import { resolveInsideProject } from "./files.ts";

export type { Attachment };

export const attachmentsDirectoryName = "attachments";

const imageMimeTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const textExtensions = new Set([
  ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".jsonl", ".xml", ".yaml", ".yml", ".toml", ".ini", ".log", ".html", ".htm", ".css",
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift", ".php", ".sh", ".sql", ".c", ".h", ".cpp", ".cs", ".vue", ".svelte", ".svg",
]);
const maxImageBytes = 5 * 1024 * 1024;
const maxPdfBytes = 30 * 1024 * 1024;
const maxInlineTextCharacters = 200_000;

const mimeTypesByExtension: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export function mimeTypeOf(fileName: string, declaredMimeType: string): string {
  return declaredMimeType && declaredMimeType !== "application/octet-stream" ? declaredMimeType : (mimeTypesByExtension[path.extname(fileName).toLowerCase()] ?? (textExtensions.has(path.extname(fileName).toLowerCase()) ? "text/plain" : "application/octet-stream"));
}

export function saveAttachment(project: Project, fileName: string, mimeType: string, bytes: Buffer): Attachment {
  const safeName = path.basename(fileName).replace(/[^\w.\- ]+/g, "_").trim() || "datei";
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const relativePath = `${attachmentsDirectoryName}/${timestamp}-${safeName}`;
  const absolutePath = resolveInsideProject(project, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, bytes);
  return { path: relativePath, name: safeName, mimeType: mimeTypeOf(safeName, mimeType), size: bytes.length };
}

const isTextAttachment = (attachment: Attachment) =>
  attachment.mimeType.startsWith("text/") || /^application\/(json|xml|x-yaml|yaml|javascript|typescript)$/.test(attachment.mimeType) || textExtensions.has(path.extname(attachment.name).toLowerCase());

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; data: string } }
  | { type: "document"; source: { type: "base64"; media_type: "application/pdf"; data: string }; title?: string };

/**
 * Message content for Claude: images and PDFs as real image/document blocks, text files inline,
 * everything else (Word, Excel, …) as a path the agent reads with its tools.
 */
export function contentBlocksFor(project: Project, text: string, attachments: Attachment[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const attachment of attachments) {
    const absolutePath = resolveInsideProject(project, attachment.path);
    if (!fs.existsSync(absolutePath)) continue;
    const fileReference = `Angehängt: ${attachment.name} (liegt unter ${attachment.path})`;
    if (imageMimeTypes.has(attachment.mimeType) && attachment.size <= maxImageBytes) {
      blocks.push({ type: "text", text: fileReference });
      blocks.push({ type: "image", source: { type: "base64", media_type: attachment.mimeType as "image/png", data: fs.readFileSync(absolutePath).toString("base64") } });
    } else if (attachment.mimeType === "application/pdf" && attachment.size <= maxPdfBytes) {
      blocks.push({ type: "document", title: attachment.name, source: { type: "base64", media_type: "application/pdf", data: fs.readFileSync(absolutePath).toString("base64") } });
    } else if (isTextAttachment(attachment)) {
      const fileText = fs.readFileSync(absolutePath, "utf8");
      const truncated = fileText.length > maxInlineTextCharacters;
      blocks.push({ type: "text", text: `<datei name="${attachment.name}" pfad="${attachment.path}">\n${fileText.slice(0, maxInlineTextCharacters)}${truncated ? "\n[… gekürzt, vollständige Datei unter dem Pfad]" : ""}\n</datei>` });
    } else {
      blocks.push({ type: "text", text: `${fileReference}. Typ ${attachment.mimeType} – Inhalt bei Bedarf mit deinen Tools lesen (z. B. \`textutil -convert txt\` oder pandoc für Word, Python für Excel).` });
    }
  }
  if (text.trim()) blocks.push({ type: "text", text });
  return blocks;
}
