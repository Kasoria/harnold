import fs from "node:fs";
import path from "node:path";
import type { Project } from "./db.ts";

/**
 * Design system = `design-system/` in the project:
 * - tokens.json (DTCG-like: groups, leaves as value or { $value, $type }, optional `$modes.dark` overrides)
 * - tokens.css  (generated from tokens.json – link it from artifacts and code)
 * - components/ (reference components, e.g. HTML snippets)
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

function readTokenTree(project: Project): TokenTree | null {
  const tokensPath = path.join(project.path, tokensFile);
  if (!fs.existsSync(tokensPath)) return null;
  const parsedTokens = JSON.parse(fs.readFileSync(tokensPath, "utf8")) as unknown;
  if (!parsedTokens || typeof parsedTokens !== "object" || Array.isArray(parsedTokens)) throw new Error("tokens.json muss ein Objekt sein");
  return parsedTokens as TokenTree;
}

/** Writes tokens.css only when its content changes (avoids watcher loops). */
export function regenerateTokensCss(project: Project): void {
  const tokenTree = readTokenTree(project);
  if (!tokenTree) return;
  const cssPath = path.join(project.path, cssFile);
  const generatedCss = generateTokensCss(tokenTree);
  const existingCss = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, "utf8") : null;
  if (existingCss !== generatedCss) fs.writeFileSync(cssPath, generatedCss);
}

function listComponents(project: Project): { name: string; path: string }[] {
  const componentsPath = path.join(project.path, componentsDirectory);
  try {
    return fs
      .readdirSync(componentsPath, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
      .map((entry) => ({ name: entry.name.replace(/\.[^.]+$/, ""), path: `${componentsDirectory}/${entry.name}` }))
      .sort((first, second) => first.name.localeCompare(second.name));
  } catch {
    return [];
  }
}

export const designSystem = {
  read(project: Project): DesignSystemView {
    const components = listComponents(project);
    let tokenTree: TokenTree | null;
    try {
      tokenTree = readTokenTree(project);
    } catch (readError) {
      return { exists: true, tokens: {}, flatTokens: [], modeTokens: {}, components, error: `tokens.json: ${readError instanceof Error ? readError.message : String(readError)}` };
    }
    if (!tokenTree) return { exists: components.length > 0, tokens: {}, flatTokens: [], modeTokens: {}, components };
    const flatTokens = resolveReferences(flattenTokens(tokenTree));
    const modes = (tokenTree.$modes ?? {}) as Record<string, TokenTree>;
    const modeTokens = Object.fromEntries(Object.entries(modes).map(([modeName, modeTree]) => [modeName, resolveReferences(flattenTokens(modeTree), flatTokens)]));
    return { exists: true, tokens: tokenTree, flatTokens, modeTokens, components };
  },

  writeTokens(project: Project, tokenTree: TokenTree): DesignSystemView {
    fs.mkdirSync(path.join(project.path, designSystemDirectory), { recursive: true });
    fs.writeFileSync(path.join(project.path, tokensFile), `${JSON.stringify(tokenTree, null, 2)}\n`);
    regenerateTokensCss(project);
    return designSystem.read(project);
  },

  initialize(project: Project): DesignSystemView {
    if (fs.existsSync(path.join(project.path, tokensFile))) throw new Error("Design System existiert bereits");
    const componentsPath = path.join(project.path, componentsDirectory);
    fs.mkdirSync(componentsPath, { recursive: true });
    for (const [fileName, fileContent] of Object.entries(starterComponents)) {
      const componentPath = path.join(componentsPath, fileName);
      if (!fs.existsSync(componentPath)) fs.writeFileSync(componentPath, fileContent);
    }
    const readmePath = path.join(project.path, designSystemDirectory, "README.md");
    if (!fs.existsSync(readmePath)) fs.writeFileSync(readmePath, starterReadme);
    return designSystem.writeTokens(project, starterTokens);
  },

  /** Compact summary for the agent's system prompt (empty when there is no design system). */
  contextFor(project: Project): string {
    const view = designSystem.read(project);
    if (!view.exists) return "";
    const tokenLines = view.flatTokens.slice(0, 80).map((flatToken) => `${flatToken.cssVariable}: ${flatToken.value}`);
    const omittedCount = Math.max(0, view.flatTokens.length - tokenLines.length);
    return [
      "## Design System (design-system/)",
      "Verbindlich für alle Entwürfe und UI-Code. Tokens in design-system/tokens.json pflegen – tokens.css wird daraus automatisch erzeugt (nicht direkt bearbeiten).",
      'Artifacts binden die Tokens relativ ein, z. B. in design/x.html: <link rel="stylesheet" href="../design-system/tokens.css">, und nutzen var(--…) statt fester Werte. Im App-Code dieselben Tokens verwenden (CSS-Variablen oder Theme-Mapping).',
      view.modeTokens.dark ? 'Dark Mode: $modes.dark in tokens.json; aktiv über data-theme="dark" oder System.' : "",
      view.error ? `Achtung: ${view.error}` : "",
      tokenLines.length ? `Tokens:\n${tokenLines.join("\n")}${omittedCount ? `\n… ${omittedCount} weitere` : ""}` : "",
      view.components.length ? `Referenz-Komponenten: ${view.components.map((component) => component.path).join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  },
};

/** Called for every project file change; keeps tokens.css in sync with hand or agent edits. */
export function handleDesignSystemFilesChanged(project: Project, changedPaths: string[]): void {
  if (!changedPaths.includes(tokensFile)) return;
  try {
    regenerateTokensCss(project);
  } catch (regenerateError) {
    console.warn(`[design-system] tokens.css nicht erzeugt (${project.name}):`, regenerateError instanceof Error ? regenerateError.message : regenerateError);
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
- \`tokens.css\` – wird automatisch aus tokens.json erzeugt. In Entwürfen einbinden: \`<link rel="stylesheet" href="../design-system/tokens.css">\`.
- \`components/\` – Referenz-Komponenten.
`;
