import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.ts";
import { database, projectStore, sessionStore } from "./db.ts";
import { eventHub } from "./events.ts";
import { settingsStore } from "./settings.ts";

/**
 * Design systems are standalone (workspace-wide) and can be linked to any number of projects and sessions.
 * Each lives in `<data>/design-systems/<id>/`:
 * - tokens.json (DTCG-like: groups, leaves as value or { $value, $type }, optional `$modes.dark` overrides)
 * - tokens.css  (generated from tokens.json)
 * - components/ (reference components, e.g. HTML snippets linking ../tokens.css)
 * A session link wins over a project link. Projects see a linked system virtually under `_harnold/design-systems/<id>/` (preview).
 */

export type TokenType = "color" | "dimension" | "fontFamily" | "fontWeight" | "number" | "shadow" | "duration" | "other";
export type FlatToken = { path: string; cssVariable: string; value: string; resolvedValue: string; type: TokenType };
export type TokenTree = Record<string, unknown>;
export type DesignSystemView = {
  exists: boolean;
  tokens: TokenTree;
  flatTokens: FlatToken[];
  /** Overrides per mode (e.g. dark), already flattened. */
  modeTokens: Record<string, FlatToken[]>;
  components: { name: string; path: string }[];
  error?: string;
};

const designSystemDirectory = "design-system";
const tokensFile = `${designSystemDirectory}/tokens.json`;
const cssFile = `${designSystemDirectory}/tokens.css`;
const componentsDirectory = `${designSystemDirectory}/components`;

const colorPattern = /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|oklch\(|oklab\(|lab\(|lch\(|color\()/i;
const referencePattern = /\{([^{}]+)\}/g;

function inferTokenType(tokenPath: string[], value: unknown, declaredType: string | undefined): TokenType {
  if (declaredType) {
    const normalizedType = declaredType === "fontFamilies" ? "fontFamily" : declaredType;
    return (["color", "dimension", "fontFamily", "fontWeight", "number", "shadow", "duration"].includes(normalizedType) ? normalizedType : "other") as TokenType;
  }
  const groupName = tokenPath[0]?.toLowerCase() ?? "";
  const stringValue = String(value);
  if (colorPattern.test(stringValue) || /^colou?rs?$/.test(groupName)) return "color";
  if (/shadow/.test(groupName)) return "shadow";
  if (/^(font|fonts|fontfamily|font-family)$/.test(groupName) || tokenPath.some((segment) => /family/i.test(segment))) return "fontFamily";
  if (tokenPath.some((segment) => /weight/i.test(segment))) return "fontWeight";
  if (/duration|motion/.test(groupName)) return "duration";
  if (/^-?\d*\.?\d+(px|rem|em|%|vh|vw)$/.test(stringValue)) return "dimension";
  if (/^-?\d*\.?\d+$/.test(stringValue)) return "number";
  return "other";
}

const toCssVariable = (tokenPath: string) =>
  `--${tokenPath.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/[^A-Za-z0-9.-]/g, "-").replace(/\./g, "-").toLowerCase()}`;

const stringifyValue = (value: unknown) => (typeof value === "string" || typeof value === "number" ? String(value) : JSON.stringify(value));

/** Flattens a token tree; `$`-prefixed keys are metadata. Composite `$value` objects become one token per field. */
export function flattenTokens(tokenTree: TokenTree, parentPath: string[] = [], inheritedType?: string): FlatToken[] {
  const flatTokens: FlatToken[] = [];
  const groupType = typeof tokenTree.$type === "string" ? tokenTree.$type : inheritedType;
  for (const [key, node] of Object.entries(tokenTree)) {
    if (key.startsWith("$")) continue;
    const tokenPath = [...parentPath, key];
    if (node && typeof node === "object" && !Array.isArray(node)) {
      const nodeObject = node as TokenTree;
      if ("$value" in nodeObject) {
        const leafType = typeof nodeObject.$type === "string" ? nodeObject.$type : groupType;
        const leafValue = nodeObject.$value;
        if (leafValue && typeof leafValue === "object" && !Array.isArray(leafValue)) {
          for (const [fieldName, fieldValue] of Object.entries(leafValue)) {
            const fieldPath = [...tokenPath, fieldName];
            flatTokens.push(makeToken(fieldPath, fieldValue, inferTokenType(fieldPath, fieldValue, undefined)));
          }
        } else {
          flatTokens.push(makeToken(tokenPath, Array.isArray(leafValue) ? leafValue.join(", ") : leafValue, inferTokenType(tokenPath, leafValue, leafType)));
        }
      } else {
        flatTokens.push(...flattenTokens(nodeObject, tokenPath, groupType));
      }
    } else if (node !== null && node !== undefined) {
      const leafValue = Array.isArray(node) ? node.join(", ") : node;
      flatTokens.push(makeToken(tokenPath, leafValue, inferTokenType(tokenPath, leafValue, groupType)));
    }
  }
  return flatTokens;
}

function makeToken(tokenPath: string[], value: unknown, type: TokenType): FlatToken {
  const joinedPath = tokenPath.join(".");
  return { path: joinedPath, cssVariable: toCssVariable(joinedPath), value: stringifyValue(value), resolvedValue: stringifyValue(value), type };
}

/** Resolves `{group.token}` references (for display) – up to a few levels deep. */
function resolveReferences(flatTokens: FlatToken[], fallbackTokens: FlatToken[] = []): FlatToken[] {
  const valuesByPath = new Map([...fallbackTokens, ...flatTokens].map((flatToken) => [flatToken.path, flatToken.value]));
  const resolveValue = (value: string, depth: number): string =>
    depth > 6 ? value : value.replace(referencePattern, (match, referencedPath: string) => (valuesByPath.has(referencedPath) ? resolveValue(valuesByPath.get(referencedPath)!, depth + 1) : match));
  return flatTokens.map((flatToken) => ({ ...flatToken, resolvedValue: resolveValue(flatToken.value, 0) }));
}

const toCssValue = (value: string) => value.replace(referencePattern, (_match, referencedPath: string) => `var(${toCssVariable(referencedPath)})`);

export function generateTokensCss(tokenTree: TokenTree): string {
  const declarationsOf = (flatTokens: FlatToken[]) => flatTokens.map((flatToken) => `  ${flatToken.cssVariable}: ${toCssValue(flatToken.value)};`).join("\n");
  const cssBlocks = [`/* Automatisch aus tokens.json erzeugt – nicht direkt bearbeiten. */\n:root {\n${declarationsOf(flattenTokens(tokenTree))}\n}`];
  const modes = (tokenTree.$modes ?? {}) as Record<string, TokenTree>;
  for (const [modeName, modeTree] of Object.entries(modes)) {
    const modeDeclarations = declarationsOf(flattenTokens(modeTree));
    if (!modeDeclarations) continue;
    cssBlocks.push(`[data-theme="${modeName}"] {\n${modeDeclarations}\n}`);
    if (modeName === "dark") cssBlocks.push(`@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) {\n${modeDeclarations.replace(/^/gm, "  ")}\n  }\n}`);
  }
  return `${cssBlocks.join("\n\n")}\n`;
}

database.exec(`
  CREATE TABLE IF NOT EXISTS design_systems (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS design_system_links (
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    design_system_id TEXT NOT NULL REFERENCES design_systems(id) ON DELETE CASCADE,
    PRIMARY KEY (target_type, target_id)
  );
`);

export type DesignSystemLinkTarget = { targetType: "project" | "session"; targetId: string };
export type DesignSystemSummary = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  tokenCount: number;
  swatches: string[];
  links: DesignSystemLinkTarget[];
};
export type DesignSystemDetail = DesignSystemView & { id: string; name: string; directory: string; links: DesignSystemLinkTarget[] };

export const designSystemsDirectory = path.join(config.dataDirectory, "design-systems");
fs.mkdirSync(designSystemsDirectory, { recursive: true });

/** Virtual folder inside every project (served by the preview) that maps to the linked systems. */
export const virtualDesignSystemsPrefix = "_harnold/design-systems/";

type DesignSystemRow = { id: string; name: string; createdAt: number; updatedAt: number };
const mapRow = (row: Record<string, unknown>): DesignSystemRow => ({
  id: String(row.id),
  name: String(row.name),
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
});

const directoryOf = (designSystemId: string) => path.join(designSystemsDirectory, designSystemId);

function requireRow(designSystemId: string): DesignSystemRow {
  const row = database.prepare("SELECT * FROM design_systems WHERE id = ?").get(designSystemId);
  if (!row) throw new Error("Design System nicht gefunden");
  return mapRow(row);
}

function linksOf(designSystemId: string): DesignSystemLinkTarget[] {
  return database
    .prepare("SELECT target_type, target_id FROM design_system_links WHERE design_system_id = ? ORDER BY target_type, target_id")
    .all(designSystemId)
    .map((row) => ({ targetType: String(row.target_type) as DesignSystemLinkTarget["targetType"], targetId: String(row.target_id) }))
    .filter((link) => (link.targetType === "project" ? projectStore.get(link.targetId) : sessionStore.get(link.targetId)));
}

function readTokenTree(directory: string): TokenTree | null {
  const tokensPath = path.join(directory, "tokens.json");
  if (!fs.existsSync(tokensPath)) return null;
  const parsedTokens = JSON.parse(fs.readFileSync(tokensPath, "utf8")) as unknown;
  if (!parsedTokens || typeof parsedTokens !== "object" || Array.isArray(parsedTokens)) throw new Error("tokens.json muss ein Objekt sein");
  return parsedTokens as TokenTree;
}

/** Writes tokens.css only when its content changes (avoids watcher loops). */
export function regenerateTokensCss(directory: string): void {
  const tokenTree = readTokenTree(directory);
  if (!tokenTree) return;
  const cssPath = path.join(directory, "tokens.css");
  const generatedCss = generateTokensCss(tokenTree);
  const existingCss = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, "utf8") : null;
  if (existingCss !== generatedCss) fs.writeFileSync(cssPath, generatedCss);
}

function listComponents(directory: string): { name: string; path: string }[] {
  try {
    return fs
      .readdirSync(path.join(directory, "components"), { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
      .map((entry) => ({ name: entry.name.replace(/\.[^.]+$/, ""), path: `components/${entry.name}` }))
      .sort((first, second) => first.name.localeCompare(second.name));
  } catch {
    return [];
  }
}

function readView(directory: string): DesignSystemView {
  const components = listComponents(directory);
  let tokenTree: TokenTree | null;
  try {
    tokenTree = readTokenTree(directory);
  } catch (readError) {
    return { exists: true, tokens: {}, flatTokens: [], modeTokens: {}, components, error: `tokens.json: ${readError instanceof Error ? readError.message : String(readError)}` };
  }
  if (!tokenTree) return { exists: components.length > 0, tokens: {}, flatTokens: [], modeTokens: {}, components };
  const flatTokens = resolveReferences(flattenTokens(tokenTree));
  const modes = (tokenTree.$modes ?? {}) as Record<string, TokenTree>;
  const modeTokens = Object.fromEntries(Object.entries(modes).map(([modeName, modeTree]) => [modeName, resolveReferences(flattenTokens(modeTree), flatTokens)]));
  return { exists: true, tokens: tokenTree, flatTokens, modeTokens, components };
}

function touch(designSystemId: string): void {
  database.prepare("UPDATE design_systems SET updated_at = ? WHERE id = ?").run(Date.now(), designSystemId);
  eventHub.publish({ type: "design_systems_changed" });
}

function writeStarterFiles(directory: string): void {
  fs.mkdirSync(path.join(directory, "components"), { recursive: true });
  for (const [fileName, fileContent] of Object.entries(starterComponents)) fs.writeFileSync(path.join(directory, "components", fileName), fileContent);
  fs.writeFileSync(path.join(directory, "README.md"), starterReadme);
  fs.writeFileSync(path.join(directory, "tokens.json"), `${JSON.stringify(starterTokens, null, 2)}\n`);
  regenerateTokensCss(directory);
}

export const designSystemStore = {
  list(): DesignSystemSummary[] {
    return database
      .prepare("SELECT * FROM design_systems ORDER BY updated_at DESC")
      .all()
      .map(mapRow)
      .map((row) => {
        const view = readView(directoryOf(row.id));
        const swatches = view.flatTokens.filter((flatToken) => flatToken.type === "color").slice(0, 6).map((flatToken) => flatToken.resolvedValue);
        return { ...row, tokenCount: view.flatTokens.length, swatches, links: linksOf(row.id) };
      });
  },

  get(designSystemId: string): DesignSystemDetail {
    const row = requireRow(designSystemId);
    const directory = directoryOf(row.id);
    return { ...readView(directory), id: row.id, name: row.name, directory, links: linksOf(row.id) };
  },

  /** `starter` = tokens + example components, `empty` = only an empty tokens.json (e.g. for the agent to fill). */
  create(name: string, template: "starter" | "empty"): DesignSystemDetail {
    const now = Date.now();
    const designSystemId = randomUUID();
    const directory = directoryOf(designSystemId);
    fs.mkdirSync(directory, { recursive: true });
    if (template === "starter") writeStarterFiles(directory);
    else {
      fs.mkdirSync(path.join(directory, "components"), { recursive: true });
      fs.writeFileSync(path.join(directory, "tokens.json"), "{}\n");
      regenerateTokensCss(directory);
    }
    database.prepare("INSERT INTO design_systems (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(designSystemId, name, now, now);
    eventHub.publish({ type: "design_systems_changed" });
    return designSystemStore.get(designSystemId);
  },

  rename(designSystemId: string, name: string): DesignSystemDetail {
    requireRow(designSystemId);
    database.prepare("UPDATE design_systems SET name = ? WHERE id = ?").run(name, designSystemId);
    touch(designSystemId);
    return designSystemStore.get(designSystemId);
  },

  remove(designSystemId: string): void {
    requireRow(designSystemId);
    database.prepare("DELETE FROM design_system_links WHERE design_system_id = ?").run(designSystemId);
    database.prepare("DELETE FROM design_systems WHERE id = ?").run(designSystemId);
    fs.rmSync(directoryOf(designSystemId), { recursive: true, force: true });
    eventHub.publish({ type: "design_systems_changed" });
  },

  writeTokens(designSystemId: string, tokenTree: TokenTree): DesignSystemDetail {
    requireRow(designSystemId);
    const directory = directoryOf(designSystemId);
    fs.writeFileSync(path.join(directory, "tokens.json"), `${JSON.stringify(tokenTree, null, 2)}\n`);
    regenerateTokensCss(directory);
    touch(designSystemId);
    return designSystemStore.get(designSystemId);
  },

  /** Replaces all links of this system. A target linked to another system moves over (one system per target). */
  setLinks(designSystemId: string, links: DesignSystemLinkTarget[]): DesignSystemDetail {
    requireRow(designSystemId);
    database.prepare("DELETE FROM design_system_links WHERE design_system_id = ?").run(designSystemId);
    const insertLink = database.prepare(
      "INSERT INTO design_system_links (target_type, target_id, design_system_id) VALUES (?, ?, ?) ON CONFLICT(target_type, target_id) DO UPDATE SET design_system_id = excluded.design_system_id",
    );
    for (const link of links) insertLink.run(link.targetType, link.targetId, designSystemId);
    touch(designSystemId);
    return designSystemStore.get(designSystemId);
  },

  /** The system that applies: session link first, then project link. */
  resolveFor(projectId: string, sessionId: string | null): DesignSystemDetail | null {
    const findLinked = (targetType: string, targetId: string) =>
      database.prepare("SELECT design_system_id FROM design_system_links WHERE target_type = ? AND target_id = ?").get(targetType, targetId);
    const linkRow = (sessionId ? findLinked("session", sessionId) : undefined) ?? findLinked("project", projectId);
    if (!linkRow) return null;
    try {
      return designSystemStore.get(String(linkRow.design_system_id));
    } catch {
      return null;
    }
  },

  /** Absolute path of a file inside a system (guards against traversal). */
  resolveFile(designSystemId: string, relativePath: string): string {
    requireRow(designSystemId);
    const directory = directoryOf(designSystemId);
    const absolutePath = path.resolve(directory, relativePath);
    if (absolutePath !== directory && !absolutePath.startsWith(directory + path.sep)) throw new Error("Pfad außerhalb des Design Systems");
    return absolutePath;
  },

  /** Compact summary for the agent's system prompt (empty when nothing is linked). */
  contextFor(projectId: string, sessionId: string | null): string {
    const linkedSystem = designSystemStore.resolveFor(projectId, sessionId);
    if (!linkedSystem) return "";
    const tokenLines = linkedSystem.flatTokens.slice(0, 80).map((flatToken) => `${flatToken.cssVariable}: ${flatToken.value}`);
    const omittedCount = Math.max(0, linkedSystem.flatTokens.length - tokenLines.length);
    const virtualPath = `${virtualDesignSystemsPrefix}${linkedSystem.id}`;
    return [
      `## Design System „${linkedSystem.name}“`,
      `Verbindlich für alle Entwürfe und UI-Code. Liegt außerhalb des Projekts unter ${linkedSystem.directory} (tokens.json, components/). Tokens dort in tokens.json pflegen – tokens.css wird automatisch erzeugt (nicht direkt bearbeiten).`,
      `Artifacts binden die Tokens über den virtuellen Projektpfad ${virtualPath}/tokens.css relativ ein, z. B. in design/x.html: <link rel="stylesheet" href="../${virtualPath}/tokens.css">, und nutzen var(--…) statt fester Werte. Im App-Code dieselben Tokens verwenden (bei Bedarf tokens.css ins Projekt kopieren oder als Theme abbilden).`,
      linkedSystem.modeTokens.dark ? 'Dark Mode: $modes.dark in tokens.json; aktiv über data-theme="dark" oder System.' : "",
      linkedSystem.error ? `Achtung: ${linkedSystem.error}` : "",
      tokenLines.length ? `Tokens:\n${tokenLines.join("\n")}${omittedCount ? `\n… ${omittedCount} weitere` : ""}` : "",
      linkedSystem.components.length ? `Referenz-Komponenten: ${linkedSystem.components.map((component) => component.path).join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  },
};

/** Keeps tokens.css in sync with hand or agent edits and tells clients about changes. */
export function watchDesignSystems(): void {
  const pendingTimers = new Map<string, NodeJS.Timeout>();
  fs.watch(designSystemsDirectory, { recursive: true }, (_eventType, fileName) => {
    if (!fileName) return;
    const [designSystemId, ...restSegments] = fileName.split(path.sep);
    if (!designSystemId || restSegments.join("/") === "tokens.css") return;
    clearTimeout(pendingTimers.get(designSystemId));
    pendingTimers.set(
      designSystemId,
      setTimeout(() => {
        pendingTimers.delete(designSystemId);
        try {
          regenerateTokensCss(directoryOf(designSystemId));
        } catch (regenerateError) {
          console.warn("[design-system] tokens.css nicht erzeugt:", regenerateError instanceof Error ? regenerateError.message : regenerateError);
        }
        eventHub.publish({ type: "design_systems_changed" });
      }, 200),
    );
  });
}

/** One-time import of project-local `design-system/` folders from earlier versions (linked to their project). */
export function importLegacyProjectDesignSystems(): void {
  const importedProjectIds = settingsStore.read<string[]>("designSystems.importedProjects", []);
  for (const project of projectStore.list()) {
    if (importedProjectIds.includes(project.id)) continue;
    const legacyDirectory = path.join(project.path, "design-system");
    if (!fs.existsSync(path.join(legacyDirectory, "tokens.json"))) continue;
    const importedSystem = designSystemStore.create(project.name, "empty");
    fs.cpSync(legacyDirectory, importedSystem.directory, { recursive: true });
    regenerateTokensCss(importedSystem.directory);
    designSystemStore.setLinks(importedSystem.id, [{ targetType: "project", targetId: project.id }]);
    importedProjectIds.push(project.id);
    settingsStore.write("designSystems.importedProjects", importedProjectIds);
    console.log(`[design-system] ${project.name}: design-system/ importiert`);
  }
}

// ---------------------------------------------------------------- Starter

const starterTokens: TokenTree = {
  color: {
    $type: "color",
    background: "#ffffff",
    surface: "#f6f6f7",
    foreground: "#18181b",
    muted: "#71717a",
    border: "#e4e4e7",
    primary: "#18181b",
    "primary-foreground": "#fafafa",
    accent: "#2563eb",
    success: "#16a34a",
    danger: "#dc2626",
  },
  font: {
    sans: { $value: "Inter, ui-sans-serif, system-ui, sans-serif", $type: "fontFamily" },
    mono: { $value: "ui-monospace, SFMono-Regular, Menlo, monospace", $type: "fontFamily" },
  },
  "font-size": { $type: "dimension", xs: "12px", sm: "14px", base: "16px", lg: "18px", xl: "24px", "2xl": "32px", "3xl": "48px" },
  "font-weight": { $type: "fontWeight", regular: 400, medium: 500, semibold: 600, bold: 700 },
  space: { $type: "dimension", "1": "4px", "2": "8px", "3": "12px", "4": "16px", "6": "24px", "8": "32px", "12": "48px", "16": "64px" },
  radius: { $type: "dimension", sm: "6px", md: "10px", lg: "16px", full: "9999px" },
  shadow: {
    $type: "shadow",
    sm: "0 1px 2px rgb(0 0 0 / 0.06)",
    md: "0 4px 12px rgb(0 0 0 / 0.08)",
    lg: "0 12px 32px rgb(0 0 0 / 0.12)",
  },
  $modes: {
    dark: {
      color: {
        background: "#0b0b0c",
        surface: "#161618",
        foreground: "#fafafa",
        muted: "#a1a1aa",
        border: "#2a2a2e",
        primary: "#fafafa",
        "primary-foreground": "#18181b",
      },
    },
  },
};

const starterBaseStyles = `
    body { margin: 0; padding: var(--space-8); font-family: var(--font-sans); background: var(--color-background); color: var(--color-foreground); display: flex; gap: var(--space-4); flex-wrap: wrap; align-items: flex-start; }`;

const starterComponents: Record<string, string> = {
  "button.html": `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="../tokens.css">
  <style>${starterBaseStyles}
    .button { font: var(--font-weight-medium) var(--font-size-sm) / 1 var(--font-sans); padding: var(--space-3) var(--space-4); border-radius: var(--radius-md); border: 1px solid transparent; cursor: pointer; }
    .button--primary { background: var(--color-primary); color: var(--color-primary-foreground); }
    .button--secondary { background: var(--color-surface); color: var(--color-foreground); border-color: var(--color-border); }
    .button--ghost { background: transparent; color: var(--color-foreground); }
  </style>
</head>
<body>
  <button class="button button--primary">Primär</button>
  <button class="button button--secondary">Sekundär</button>
  <button class="button button--ghost">Ghost</button>
</body>
</html>
`,
  "card.html": `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="../tokens.css">
  <style>${starterBaseStyles}
    .card { width: 280px; padding: var(--space-6); border-radius: var(--radius-lg); background: var(--color-background); border: 1px solid var(--color-border); box-shadow: var(--shadow-md); }
    .card h3 { margin: 0 0 var(--space-2); font-size: var(--font-size-lg); font-weight: var(--font-weight-semibold); }
    .card p { margin: 0; font-size: var(--font-size-sm); color: var(--color-muted); line-height: 1.5; }
  </style>
</head>
<body>
  <article class="card">
    <h3>Karte</h3>
    <p>Ruhige Fläche mit feinem Rahmen und weichem Schatten.</p>
  </article>
</body>
</html>
`,
};

const starterReadme = `# Design System

- \`tokens.json\` – Tokens (Farben, Schrift, Abstände, Radien, Schatten). \`$modes.dark\` überschreibt Werte im Dark Mode.
- \`tokens.css\` – wird automatisch aus tokens.json erzeugt.
- \`components/\` – Referenz-Komponenten.
`;
