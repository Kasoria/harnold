import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ToolDefinition } from "./model-adapters.ts";
import type { PermissionMode } from "../types.ts";

/**
 * Tools of Harnold's own agent. Names and input fields follow the common coding-agent vocabulary
 * (Read, Write, Edit, Glob, Grep, Bash, WebFetch) so the chat shows them like any other agent's tools.
 */
export type ToolRisk = "read" | "edit" | "network" | "execute";
export type NativeToolContext = { cwd: string; allowedRoots: string[]; env: NodeJS.ProcessEnv; signal: AbortSignal; permissionMode: PermissionMode };
export type NativeTool = ToolDefinition & { risk: ToolRisk; run: (input: Record<string, unknown>, context: NativeToolContext) => Promise<string> };

const ignoredDirectories = new Set(["node_modules", ".git", "dist", "build", ".next", ".turbo", "__pycache__", ".venv"]);
const maxOutputCharacters = 30_000;

const text = (value: unknown, name: string): string => {
  if (typeof value !== "string" || !value) throw new Error(`Parameter „${name}“ fehlt`);
  return value;
};

function resolveInside(context: NativeToolContext, inputPath: unknown, name = "file_path"): string {
  const resolved = path.resolve(context.cwd, text(inputPath, name));
  if (context.permissionMode === "bypassPermissions") return resolved;
  const inside = context.allowedRoots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
  if (!inside) throw new Error(`Pfad liegt außerhalb des Projekts: ${resolved}`);
  return resolved;
}

const clip = (value: string, limit = maxOutputCharacters) => (value.length > limit ? `${value.slice(0, limit)}\n[… gekürzt]` : value);

function* walkFiles(directory: string, context: NativeToolContext, limit = 20_000): Generator<string> {
  let count = 0;
  const pending = [directory];
  while (pending.length && count < limit) {
    const current = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (context.signal.aborted) return;
      if (ignoredDirectories.has(entry.name)) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.isFile()) {
        count++;
        yield fullPath;
      }
    }
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

export const nativeTools: NativeTool[] = [
  {
    name: "Read",
    description: "Liest eine Textdatei (mit Zeilennummern). Optional offset (ab Zeile, 1-basiert) und limit (Anzahl Zeilen).",
    risk: "read",
    inputSchema: { type: "object", properties: { file_path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["file_path"] },
    async run(input, context) {
      const filePath = resolveInside(context, input.file_path);
      const lines = fs.readFileSync(filePath, "utf8").split("\n");
      const start = Math.max(1, Number(input.offset) || 1);
      const count = Math.min(2000, Number(input.limit) || 2000);
      return clip(lines.slice(start - 1, start - 1 + count).map((line, index) => `${start + index}\t${line}`).join("\n"));
    },
  },
  {
    name: "Write",
    description: "Schreibt eine Datei komplett (legt Ordner an, überschreibt Vorhandenes).",
    risk: "edit",
    inputSchema: { type: "object", properties: { file_path: { type: "string" }, content: { type: "string" } }, required: ["file_path", "content"] },
    async run(input, context) {
      const filePath = resolveInside(context, input.file_path);
      const content = typeof input.content === "string" ? input.content : "";
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
      return `Geschrieben: ${path.relative(context.cwd, filePath) || filePath} (${content.split("\n").length} Zeilen)`;
    },
  },
  {
    name: "Edit",
    description: "Ersetzt old_string durch new_string in einer Datei. old_string muss eindeutig sein, sonst replace_all setzen.",
    risk: "edit",
    inputSchema: {
      type: "object",
      properties: { file_path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" } },
      required: ["file_path", "old_string", "new_string"],
    },
    async run(input, context) {
      const filePath = resolveInside(context, input.file_path);
      const oldString = text(input.old_string, "old_string");
      const newString = typeof input.new_string === "string" ? input.new_string : "";
      const original = fs.readFileSync(filePath, "utf8");
      const occurrences = original.split(oldString).length - 1;
      if (occurrences === 0) throw new Error("old_string kommt in der Datei nicht vor");
      if (occurrences > 1 && !input.replace_all) throw new Error(`old_string kommt ${occurrences}× vor – mehr Kontext angeben oder replace_all setzen`);
      fs.writeFileSync(filePath, input.replace_all ? original.split(oldString).join(newString) : original.replace(oldString, () => newString));
      return `Geändert: ${path.relative(context.cwd, filePath) || filePath} (${input.replace_all ? occurrences : 1} Stelle(n))`;
    },
  },
  {
    name: "Glob",
    description: "Findet Dateien per Muster (z. B. src/**/*.ts), relativ zum Projekt. Ignoriert node_modules, .git, dist.",
    risk: "read",
    inputSchema: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"] },
    async run(input, context) {
      const base = input.path ? resolveInside(context, input.path, "path") : context.cwd;
      const pattern = text(input.pattern, "pattern");
      const matches: string[] = [];
      for (const filePath of walkFiles(base, context)) {
        const relativePath = path.relative(base, filePath).split(path.sep).join("/");
        if (path.matchesGlob(relativePath, pattern) || path.matchesGlob(path.basename(filePath), pattern)) matches.push(path.relative(context.cwd, filePath));
        if (matches.length >= 300) break;
      }
      return matches.join("\n") || "Keine Treffer.";
    },
  },
  {
    name: "Grep",
    description: "Sucht einen regulären Ausdruck in Dateien (optional path, glob-Filter, case_insensitive). Ausgabe: datei:zeile:text.",
    risk: "read",
    inputSchema: {
      type: "object",
      properties: { pattern: { type: "string" }, path: { type: "string" }, glob: { type: "string" }, case_insensitive: { type: "boolean" } },
      required: ["pattern"],
    },
    async run(input, context) {
      const base = input.path ? resolveInside(context, input.path, "path") : context.cwd;
      const expression = new RegExp(text(input.pattern, "pattern"), input.case_insensitive ? "i" : "");
      const glob = typeof input.glob === "string" ? input.glob : null;
      const hits: string[] = [];
      const candidates = fs.existsSync(base) && fs.statSync(base).isFile() ? [base] : walkFiles(base, context);
      for (const filePath of candidates) {
        if (glob && !path.matchesGlob(path.basename(filePath), glob) && !path.matchesGlob(path.relative(base, filePath).split(path.sep).join("/"), glob)) continue;
        let content: string;
        try {
          if (fs.statSync(filePath).size > 1_000_000) continue;
          content = fs.readFileSync(filePath, "utf8");
        } catch {
          continue;
        }
        if (content.includes("\0")) continue;
        const lines = content.split("\n");
        for (let index = 0; index < lines.length; index++) {
          if (expression.test(lines[index])) hits.push(`${path.relative(context.cwd, filePath)}:${index + 1}:${lines[index].slice(0, 300)}`);
          if (hits.length >= 200) return `${hits.join("\n")}\n[… weitere Treffer ausgelassen]`;
        }
      }
      return hits.join("\n") || "Keine Treffer.";
    },
  },
  {
    name: "Bash",
    description: "Führt einen Shell-Befehl im Projektordner aus (stdout + stderr). Optional timeout_ms (Standard 120000).",
    risk: "execute",
    inputSchema: { type: "object", properties: { command: { type: "string" }, timeout_ms: { type: "number" } }, required: ["command"] },
    run: (input, context) =>
      new Promise<string>((resolve) => {
        const timeoutMs = Math.min(600_000, Number(input.timeout_ms) || 120_000);
        const child = spawn("/bin/sh", ["-c", text(input.command, "command")], { cwd: context.cwd, env: context.env, signal: context.signal });
        let output = "";
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs);
        const collect = (chunk: Buffer) => {
          output += chunk.toString();
          if (output.length > 200_000) output = output.slice(-100_000);
        };
        child.stdout.on("data", collect);
        child.stderr.on("data", collect);
        const finish = (suffix: string) => {
          clearTimeout(timer);
          resolve(clip(`${output}${suffix}`.trim() || "(keine Ausgabe)"));
        };
        child.on("error", (spawnError) => finish(`\n[Fehler: ${spawnError.message}]`));
        child.on("close", (exitCode) => finish(timedOut ? `\n[Zeitüberschreitung nach ${timeoutMs / 1000} s]` : exitCode ? `\n[Exit-Code ${exitCode}]` : ""));
      }),
  },
  {
    name: "WebFetch",
    description: "Lädt eine Webseite (http/https) und liefert den Text; HTML wird zu Klartext.",
    risk: "network",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    async run(input, context) {
      const url = new URL(text(input.url, "url"));
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Nur http/https");
      const response = await fetch(url, { signal: AbortSignal.any([context.signal, AbortSignal.timeout(30_000)]), headers: { "user-agent": "Harnold" } });
      const body = await response.text();
      const readable = /html/i.test(response.headers.get("content-type") ?? "") ? htmlToText(body) : body;
      return clip(`HTTP ${response.status}\n${readable}`, 40_000);
    },
  },
];

export const nativeToolByName = new Map(nativeTools.map((tool) => [tool.name, tool]));

/** The question tool is handled by the agent loop (it needs the permission channel), only its schema lives here. */
export const askUserQuestionDefinition: ToolDefinition = {
  name: "AskUserQuestion",
  description: "Stellt dem Nutzer 1–4 Fragen mit Antwortoptionen, wenn eine Entscheidung nötig ist, die du nicht selbst treffen solltest.",
  inputSchema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            question: { type: "string" },
            header: { type: "string" },
            multiSelect: { type: "boolean" },
            options: { type: "array", items: { type: "object", properties: { label: { type: "string" }, description: { type: "string" } }, required: ["label"] } },
          },
          required: ["question", "options"],
        },
      },
    },
    required: ["questions"],
  },
};
