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
  fs.writeFileSync(absolutePath, JSON.stringify(canvasDocument, null, 2));
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

  const result: CanvasDocument = { version: 1, elements };
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
  writeCanvas(project, { version: 1, elements });
}
