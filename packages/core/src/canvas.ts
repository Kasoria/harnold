import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Project } from "./db.ts";
import { resolveInsideProject } from "./files.ts";
import { resolveInsideProjectRoot } from "./project-roots.ts";

/** Canvas lives inside the project (design/canvas.json) so the agent can read and arrange it too. */
export const canvasRelativePath = "design/canvas.json";

const canvasElementSchema = z.object({
  id: z.string(),
  type: z.enum(["frame", "artifact", "note", "text", "rect", "drawing", "file", "folder", "app", "connector"]),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  frameId: z.string().nullable().optional(),
  title: z.string().optional(),
  path: z.string().optional(),
  text: z.string().optional(),
  points: z.array(z.tuple([z.number(), z.number()])).optional(),
  viewportWidth: z.number().optional(),
  viewportHeight: z.number().optional(),
  /** file/folder: absolute path of the project root the path is relative to; absent = project folder. */
  root: z.string().optional(),
  /** app: route of the dev server shown, and the preferred port (absent = the project's first server). */
  route: z.string().optional(),
  port: z.number().optional(),
  /** connector: the two connected elements. */
  fromId: z.string().optional(),
  toId: z.string().optional(),
});

export const canvasDocumentSchema = z.object({
  version: z.literal(1),
  elements: z.array(canvasElementSchema),
  /** Set once the project overview (app, key files, main folders) has been laid out; the user's edits are never overwritten afterwards. */
  overviewSeeded: z.boolean().optional(),
});

export type CanvasElement = z.infer<typeof canvasElementSchema>;
export type CanvasDocument = z.infer<typeof canvasDocumentSchema>;

const artifactExtensions = /\.(html?|svg|png|jpe?g|webp|gif)$/i;
const htmlExtensions = /\.html?$/i;
/** Folders whose HTML files and images appear on the canvas on their own (typical places for drafts, references and static assets). */
const artifactFolders = ["design", "design-reference", "assets", "public"];
const autoFrameTitle = "Entwürfe";
const framePadding = 40;
const gridGap = 32;
const gridColumns = 4;
const htmlThumbnail = { width: 320, height: 200, viewportWidth: 1280, viewportHeight: 800 };
const imageThumbnail = { width: 220, height: 220 };

function listArtifactPaths(project: Project): string[] {
  const collected: string[] = [];
  const walk = (relativeDirectory: string) => {
    const absoluteDirectory = resolveInsideProject(project, relativeDirectory);
    if (!fs.existsSync(absoluteDirectory)) return;
    for (const entry of fs.readdirSync(absoluteDirectory, { withFileTypes: true })) {
      const entryPath = path.posix.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) walk(entryPath);
      else if (artifactExtensions.test(entry.name)) collected.push(entryPath);
    }
  };
  for (const artifactFolder of artifactFolders) walk(artifactFolder);
  return collected.sort();
}

function readCanvasFile(project: Project): CanvasDocument {
  const absolutePath = resolveInsideProject(project, canvasRelativePath);
  if (!fs.existsSync(absolutePath)) return { version: 1, elements: [] };
  try {
    return canvasDocumentSchema.parse(JSON.parse(fs.readFileSync(absolutePath, "utf8")));
  } catch {
    return { version: 1, elements: [] };
  }
}

export function writeCanvas(project: Project, canvasDocument: CanvasDocument): void {
  const absolutePath = resolveInsideProject(project, canvasRelativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  // The UI doesn't know the flag; keep it so a saved canvas doesn't get the overview laid out again.
  const overviewSeeded = canvasDocument.overviewSeeded ?? readCanvasFile(project).overviewSeeded;
  fs.writeFileSync(absolutePath, JSON.stringify({ ...canvasDocument, ...(overviewSeeded ? { overviewSeeded } : {}) }, null, 2));
}

const overviewFrameTitle = "Projekt";
const overviewKeyFiles = ["README.md", "AGENTS.md", "CLAUDE.md"];
/** Top-level folders left out of the overview: generated, hidden, or already shown through their images and drafts. */
const overviewSkippedFolders = new Set(["node_modules", "dist", "build", "out", "target", "coverage", "attachments", "memory", "design", "design-reference", "assets", "public", "__pycache__"]);
const overviewMaxFolders = 8;
const overviewRowWidth = 1280;
const overviewCardSizes = {
  app: { width: 480, height: 328 },
  file: { width: 360, height: 280 },
  folder: { width: 260, height: 300 },
};

function hasDevServerScript(projectFolder: string): boolean {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(projectFolder, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    return Boolean(manifest.scripts?.dev ?? manifest.scripts?.start);
  } catch {
    return false;
  }
}

function folderHasFiles(absoluteFolder: string): boolean {
  try {
    return fs.readdirSync(absoluteFolder).some((name) => !name.startsWith("."));
  } catch {
    return false;
  }
}

/**
 * A tidy picture of the project at the top level: the running app, the key documents and the main folders
 * (not every file). Laid out once; afterwards the canvas belongs to the user.
 */
function seedProjectOverview(project: Project, elements: CanvasElement[]): boolean {
  const projectFolder = resolveInsideProject(project, ".");
  if (!fs.existsSync(projectFolder)) return false;
  const topLevelEntries = fs.readdirSync(projectFolder, { withFileTypes: true }).filter((entry) => !entry.name.startsWith("."));

  const cards: Array<Pick<CanvasElement, "type" | "path" | "route"> & { size: { width: number; height: number } }> = [];
  if (hasDevServerScript(projectFolder)) cards.push({ type: "app", route: "/", size: overviewCardSizes.app });
  for (const fileName of overviewKeyFiles) {
    if (topLevelEntries.some((entry) => entry.isFile() && entry.name === fileName)) cards.push({ type: "file", path: fileName, size: overviewCardSizes.file });
  }
  const folderNames = topLevelEntries
    .filter((entry) => entry.isDirectory() && !overviewSkippedFolders.has(entry.name) && folderHasFiles(path.join(projectFolder, entry.name)))
    .map((entry) => entry.name)
    .sort((first, second) => first.localeCompare(second))
    .slice(0, overviewMaxFolders);
  for (const folderName of folderNames) cards.push({ type: "folder", path: folderName, size: overviewCardSizes.folder });
  if (!cards.length) return false;

  const lowestBottom = elements.reduce((bottom, element) => Math.max(bottom, element.y + element.height), -gridGap * 2);
  const overviewFrame: CanvasElement = { id: randomUUID(), type: "frame", title: overviewFrameTitle, x: 0, y: lowestBottom + gridGap * 2, width: 0, height: 0 };
  const originX = overviewFrame.x + framePadding;
  let cursorX = originX;
  let cursorY = overviewFrame.y + framePadding;
  let rowHeight = 0;
  const placed: CanvasElement[] = [];
  for (const card of cards) {
    if (cursorX > originX && cursorX + card.size.width > originX + overviewRowWidth) {
      cursorX = originX;
      cursorY += rowHeight + gridGap;
      rowHeight = 0;
    }
    placed.push({
      id: randomUUID(),
      type: card.type,
      ...(card.path ? { path: card.path } : {}),
      ...(card.route ? { route: card.route } : {}),
      frameId: overviewFrame.id,
      x: cursorX,
      y: cursorY,
      ...card.size,
    });
    cursorX += card.size.width + gridGap;
    rowHeight = Math.max(rowHeight, card.size.height);
  }
  overviewFrame.width = Math.max(...placed.map((card) => card.x + card.width)) - overviewFrame.x + framePadding;
  overviewFrame.height = cursorY + rowHeight - overviewFrame.y + framePadding;
  elements.push(overviewFrame, ...placed);
  return true;
}

/** Whether the file/folder an element shows still exists; an unresolvable root (folder detached) counts as gone. */
function elementTargetExists(project: Project, element: CanvasElement): boolean {
  if (!element.path) return false;
  try {
    const absolutePath = element.type === "artifact" ? resolveInsideProject(project, element.path) : resolveInsideProjectRoot(project, element.root, element.path);
    return fs.existsSync(absolutePath);
  } catch {
    return false;
  }
}

/** Reads the canvas and places artifact files that are not on it yet; drops elements whose file is gone and dangling connectors. */
export function readCanvas(project: Project): CanvasDocument {
  const canvasDocument = readCanvasFile(project);
  const artifactPaths = listArtifactPaths(project);

  const elementsWithTargets = canvasDocument.elements.filter(
    (element) => !["artifact", "file", "folder"].includes(element.type) || elementTargetExists(project, element),
  );
  const remainingIds = new Set(elementsWithTargets.map((element) => element.id));
  const keptElements = elementsWithTargets.filter(
    (element) => element.type !== "connector" || (remainingIds.has(element.fromId ?? "") && remainingIds.has(element.toId ?? "")),
  );
  const placedPaths = new Set(keptElements.flatMap((element) => (element.type === "artifact" && element.path ? [element.path] : [])));
  const missingPaths = artifactPaths.filter((artifactPath) => !placedPaths.has(artifactPath));

  let changed = keptElements.length !== canvasDocument.elements.length;
  const elements = keptElements;
  let overviewSeeded = canvasDocument.overviewSeeded;
  if (!overviewSeeded && seedProjectOverview(project, elements)) {
    overviewSeeded = true;
    changed = true;
  }

  if (missingPaths.length) {
    changed = true;
    let autoFrame = elements.find((element) => element.type === "frame" && element.title === autoFrameTitle);
    if (!autoFrame) {
      const lowestBottom = elements.reduce((bottom, element) => Math.max(bottom, element.y + element.height), -gridGap * 2);
      autoFrame = { id: randomUUID(), type: "frame", title: autoFrameTitle, x: 0, y: lowestBottom + gridGap * 2, width: 0, height: 0 };
      elements.push(autoFrame);
    }
    const frameChildrenCount = elements.filter((element) => element.frameId === autoFrame!.id).length;
    missingPaths.forEach((artifactPath, missingIndex) => {
      const slotIndex = frameChildrenCount + missingIndex;
      const column = slotIndex % gridColumns;
      const row = Math.floor(slotIndex / gridColumns);
      const isHtml = htmlExtensions.test(artifactPath);
      const size = isHtml ? htmlThumbnail : imageThumbnail;
      elements.push({
        id: randomUUID(),
        type: "artifact",
        path: artifactPath,
        frameId: autoFrame!.id,
        x: autoFrame!.x + framePadding + column * (htmlThumbnail.width + gridGap),
        y: autoFrame!.y + framePadding + row * (htmlThumbnail.height + gridGap),
        width: size.width,
        height: size.height,
        ...(isHtml ? { viewportWidth: htmlThumbnail.viewportWidth, viewportHeight: htmlThumbnail.viewportHeight } : {}),
      });
    });
    // Grow the auto frame around its children.
    const children = elements.filter((element) => element.frameId === autoFrame!.id);
    autoFrame.width = Math.max(...children.map((child) => child.x + child.width)) - autoFrame.x + framePadding;
    autoFrame.height = Math.max(...children.map((child) => child.y + child.height)) - autoFrame.y + framePadding;
  }

  const result: CanvasDocument = { version: 1, elements, ...(overviewSeeded ? { overviewSeeded } : {}) };
  if (changed) writeCanvas(project, result);
  return result;
}

const generatedFrameTitle = "Generiert";
const generatedImageWidth = 260;

export type CanvasImagePlacement = { path: string; width: number; height: number; title?: string };

/**
 * Places generated images on the canvas. With an anchor they go in a row at that point;
 * otherwise into the "Generiert" frame (grid, grows with its children).
 */
export function placeImagesOnCanvas(project: Project, images: CanvasImagePlacement[], anchor: { x: number; y: number } | null): void {
  const canvasDocument = readCanvasFile(project);
  const elements = canvasDocument.elements;
  const scaledSize = (image: CanvasImagePlacement) => {
    const aspectRatio = image.width > 0 && image.height > 0 ? image.height / image.width : 1;
    return { width: generatedImageWidth, height: Math.round(generatedImageWidth * aspectRatio) };
  };

  if (anchor) {
    let cursorX = anchor.x;
    for (const image of images) {
      const size = scaledSize(image);
      elements.push({ id: randomUUID(), type: "artifact", path: image.path, title: image.title, frameId: null, x: cursorX, y: anchor.y, ...size });
      cursorX += size.width + gridGap;
    }
  } else {
    let generatedFrame = elements.find((element) => element.type === "frame" && element.title === generatedFrameTitle);
    if (!generatedFrame) {
      const lowestBottom = elements.reduce((bottom, element) => Math.max(bottom, element.y + element.height), -gridGap * 2);
      generatedFrame = { id: randomUUID(), type: "frame", title: generatedFrameTitle, x: 0, y: lowestBottom + gridGap * 2, width: 0, height: 0 };
      elements.push(generatedFrame);
    }
    const frameId = generatedFrame.id;
    const existingChildren = elements.filter((element) => element.frameId === frameId).length;
    // Masonry: each image goes below the lowest element of its column.
    images.forEach((image, imageIndex) => {
      const columnX = generatedFrame!.x + framePadding + ((existingChildren + imageIndex) % gridColumns) * (generatedImageWidth + gridGap);
      const columnBottom = elements
        .filter((element) => element.frameId === frameId && element.x === columnX)
        .reduce((bottom, element) => Math.max(bottom, element.y + element.height + gridGap), generatedFrame!.y + framePadding);
      elements.push({ id: randomUUID(), type: "artifact", path: image.path, title: image.title, frameId, x: columnX, y: columnBottom, ...scaledSize(image) });
    });
    const children = elements.filter((element) => element.frameId === frameId);
    generatedFrame.width = Math.max(...children.map((child) => child.x + child.width)) - generatedFrame.x + framePadding;
    generatedFrame.height = Math.max(...children.map((child) => child.y + child.height)) - generatedFrame.y + framePadding;
  }
  writeCanvas(project, { ...canvasDocument, elements });
}
