import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ExternalLink, Maximize, MessageSquarePlus, Minus, Monitor, MousePointerClick, Plus, Smartphone, Trash2 } from "lucide-react";
import { api } from "@/api";
import type { CanvasDocument, CanvasElement, DevServer, ProjectRoot } from "@/types";
import { useFileActivity, type FileActivity } from "@/lib/file-activity";
import { appViewports, cardDefaults, cardHeaderHeight, type ActivityState } from "./canvas-cards";
import { CanvasActivityPanel } from "./canvas-activity-panel";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CanvasElementView } from "./canvas-element-view";
import { CanvasToolbar, canvasTools, type CanvasTool } from "./canvas-toolbar";
import { ImageGenerationPanel } from "./image-generation-panel";
import { t } from "@/lib/i18n";

type ProjectCanvasProps = {
  projectId: string;
  fileChangeCounter: number;
  lastChangedPaths: string[];
  /** Absolute path of the project folder (file cards without root live there). */
  projectPath: string;
  roots: ProjectRoot[];
  /** Running dev servers, the project's own first (for app tiles). */
  devServers: DevServer[];
  onOpenFile: (filePath: string, root?: string) => void;
  /** Opens the file panel, from which files and folders are dragged onto the canvas. */
  onOpenFilePanel?: () => void;
  onSendToAgent: (referenceText: string) => void;
  onError: (unknownError: unknown) => void;
};

type Viewport = { panX: number; panY: number; zoom: number };
type WorldPoint = { x: number; y: number };

type Interaction =
  | { kind: "pan"; startClientX: number; startClientY: number; startPanX: number; startPanY: number }
  | { kind: "move"; elementId: string; startPoint: WorldPoint; originalPositions: Map<string, WorldPoint>; moved: boolean }
  | { kind: "resize"; elementId: string; startPoint: WorldPoint; startWidth: number; startHeight: number }
  | { kind: "create"; elementId: string; startPoint: WorldPoint }
  | { kind: "draw"; elementId: string; absolutePoints: [number, number][] }
  | { kind: "connect"; fromId: string };

/** What the file tree puts into a drag (and the "add to canvas" event carries). */
export const canvasDragType = "application/x-harnold-canvas";
export const canvasAddEvent = "harnold:canvas-add";
export type CanvasAddItem = { root: string; path: string; kind: "file" | "directory" };

type Rect = { x: number; y: number; width: number; height: number };

const minZoom = 0.08;
const maxZoom = 4;
const artifactPathPattern = /^(design|assets)\/.+\.(html?|svg|png|jpe?g|webp|gif)$/i;
/** Files the canvas shows as a picture/page (only inside the project folder, where /preview serves them). */
const visualFilePattern = /\.(html?|svg|png|jpe?g|webp|gif)$/i;
const placementGap = 40;
/** "Done" stays highlighted this long; "editing" counts as stale after a few minutes (turn aborted). */
const doneHighlightMs = 6000;
const editingStaleMs = 5 * 60_000;
const clampZoom = (zoom: number) => Math.min(maxZoom, Math.max(minZoom, zoom));

/** The point where the line from the rect's center towards a target leaves the rect. */
function edgePoint(rect: Rect, targetX: number, targetY: number) {
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  const deltaX = targetX - centerX;
  const deltaY = targetY - centerY;
  if (!deltaX && !deltaY) return { x: centerX, y: centerY };
  const scale = Math.min(Math.abs(deltaX) > 1e-6 ? rect.width / 2 / Math.abs(deltaX) : Infinity, Math.abs(deltaY) > 1e-6 ? rect.height / 2 / Math.abs(deltaY) : Infinity);
  return { x: centerX + deltaX * scale, y: centerY + deltaY * scale };
}

function connectorEnds(from: Rect, to: Rect) {
  const start = edgePoint(from, to.x + to.width / 2, to.y + to.height / 2);
  const end = edgePoint(to, from.x + from.width / 2, from.y + from.height / 2);
  return { start, end };
}

function boundsOf(allElements: CanvasElement[]) {
  const elements = allElements.filter((element) => element.type !== "connector");
  if (!elements.length) return null;
  const minX = Math.min(...elements.map((element) => element.x));
  const minY = Math.min(...elements.map((element) => element.y - (element.type === "frame" ? 28 : 0)));
  const maxX = Math.max(...elements.map((element) => element.x + element.width));
  const maxY = Math.max(...elements.map((element) => element.y + element.height + (element.type === "artifact" ? 20 : 0)));
  return { minX, minY, maxX, maxY };
}

function isTypingTarget(target: EventTarget | null) {
  return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

export function ProjectCanvas(props: ProjectCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [elements, setElements] = useState<CanvasElement[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [viewport, setViewport] = useState<Viewport>({ panX: 80, panY: 80, zoom: 0.6 });
  const [viewportAnimating, setViewportAnimating] = useState(false);
  const [activeTool, setActiveTool] = useState<CanvasTool>("select");
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [selectedElementId, setSelectedElementId] = useState<string | null>(null);
  const [editingElementId, setEditingElementId] = useState<string | null>(null);
  const [reloadKeysByPath, setReloadKeysByPath] = useState<Record<string, number>>({});
  const [interactionKind, setInteractionKind] = useState<Interaction["kind"] | null>(null);
  const [imagePanelOpen, setImagePanelOpen] = useState(false);
  const [interactiveElementId, setInteractiveElementId] = useState<string | null>(null);
  const [connectPreview, setConnectPreview] = useState<{ fromId: string; x: number; y: number } | null>(null);
  const [dropActive, setDropActive] = useState(false);

  const interactionRef = useRef<Interaction | null>(null);
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const elementsRef = useRef(elements);
  elementsRef.current = elements;
  const skipNextSaveRef = useRef(true);
  const saveTimerRef = useRef<number | undefined>(undefined);
  const pendingSaveRef = useRef<Promise<unknown>>(Promise.resolve());

  const { projectId, onError } = props;

  // --- Load / save ---
  const fitToContent = useCallback((targetElements: CanvasElement[], animated: boolean) => {
    const container = containerRef.current;
    const bounds = boundsOf(targetElements);
    if (!container || !bounds) return;
    const padding = 64;
    const zoom = clampZoom(
      Math.min(1, (container.clientWidth - padding * 2) / (bounds.maxX - bounds.minX || 1), (container.clientHeight - padding * 2) / (bounds.maxY - bounds.minY || 1)),
    );
    if (animated) {
      setViewportAnimating(true);
      window.setTimeout(() => setViewportAnimating(false), 220);
    }
    setViewport({
      zoom,
      panX: (container.clientWidth - (bounds.maxX - bounds.minX) * zoom) / 2 - bounds.minX * zoom,
      panY: (container.clientHeight - (bounds.maxY - bounds.minY) * zoom) / 2 - bounds.minY * zoom,
    });
  }, []);

  const loadCanvas = useCallback(
    async (fitAfterLoad: boolean) => {
      try {
        await pendingSaveRef.current;
        const canvasDocument = await api.readCanvas(projectId);
        skipNextSaveRef.current = true;
        setElements(canvasDocument.elements);
        setLoaded(true);
        if (fitAfterLoad) requestAnimationFrame(() => fitToContent(canvasDocument.elements, false));
      } catch (loadError) {
        onError(loadError);
      }
    },
    [projectId, onError, fitToContent],
  );

  useEffect(() => {
    void loadCanvas(true);
  }, [loadCanvas]);

  useEffect(() => {
    if (!loaded) return;
    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false;
      return;
    }
    window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      const canvasDocument: CanvasDocument = { version: 1, elements: elementsRef.current };
      pendingSaveRef.current = api.writeCanvas(projectId, canvasDocument).catch(onError);
    }, 350);
  }, [elements, loaded, projectId, onError]);

  // Agent created or changed artifacts → place new ones, reload changed thumbnails.
  useEffect(() => {
    if (props.fileChangeCounter === 0) return;
    const changedArtifactPaths = props.lastChangedPaths.filter((changedPath) => artifactPathPattern.test(changedPath));
    const knownPaths = new Set(elementsRef.current.flatMap((element) => (element.path && !element.root ? [element.path] : [])));
    if (changedArtifactPaths.some((changedPath) => !knownPaths.has(changedPath))) void loadCanvas(false);
    // Project-folder files and their folders (folder cards) reload; attached folders follow the agent activity.
    setReloadKeysByPath((previous) => {
      const next = { ...previous };
      const touchedPaths = new Set<string>();
      for (const changedPath of props.lastChangedPaths) {
        const segments = changedPath.split("/");
        for (let depth = 0; depth <= segments.length; depth++) touchedPaths.add(segments.slice(0, depth).join("/"));
      }
      for (const touchedPath of touchedPaths) next[touchedPath] = (next[touchedPath] ?? 0) + 1;
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.fileChangeCounter]);

  // --- Helpers ---
  const toWorldPoint = (clientX: number, clientY: number): WorldPoint => {
    const containerRect = containerRef.current!.getBoundingClientRect();
    const { panX, panY, zoom } = viewportRef.current;
    return { x: (clientX - containerRect.left - panX) / zoom, y: (clientY - containerRect.top - panY) / zoom };
  };

  const updateElement = (elementId: string, changes: Partial<CanvasElement>) =>
    setElements((previous) => previous.map((element) => (element.id === elementId ? { ...element, ...changes } : element)));

  const removeElement = (elementId: string) => {
    setElements((previous) =>
      previous
        .filter((element) => element.id !== elementId && element.fromId !== elementId && element.toId !== elementId)
        .map((element) => (element.frameId === elementId ? { ...element, frameId: null } : element)),
    );
    setSelectedElementId(null);
  };

  const zoomAround = (factor: number, screenX: number, screenY: number, animated = false) => {
    const { panX, panY, zoom } = viewportRef.current;
    const nextZoom = clampZoom(zoom * factor);
    const worldX = (screenX - panX) / zoom;
    const worldY = (screenY - panY) / zoom;
    if (animated) {
      setViewportAnimating(true);
      window.setTimeout(() => setViewportAnimating(false), 220);
    }
    setViewport({ zoom: nextZoom, panX: screenX - worldX * nextZoom, panY: screenY - worldY * nextZoom });
  };

  const zoomAroundCenter = (factor: number) => {
    const container = containerRef.current;
    if (container) zoomAround(factor, container.clientWidth / 2, container.clientHeight / 2, true);
  };

  // --- Placement, lookup, live activity ---
  /** Topmost element under a world point; content wins over the frame around it. */
  const elementAt = (point: WorldPoint): CanvasElement | undefined =>
    elementsRef.current
      .filter(
        (element) =>
          element.type !== "connector" && point.x >= element.x && point.x <= element.x + element.width && point.y >= element.y && point.y <= element.y + element.height,
      )
      .sort((first, second) => Number(first.type === "frame") - Number(second.type === "frame") || first.width * first.height - second.width * second.height)[0];

  /** Where an element is drawn; connectors span between their two ends. */
  function displayRectOf(element: CanvasElement): Rect | null {
    if (element.type !== "connector") return element;
    const fromElement = elements.find((candidate) => candidate.id === element.fromId);
    const toElement = elements.find((candidate) => candidate.id === element.toId);
    if (!fromElement || !toElement) return null;
    const { start, end } = connectorEnds(fromElement, toElement);
    return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
  }

  const viewportCenter = (): WorldPoint => {
    const { panX, panY, zoom } = viewportRef.current;
    const container = containerRef.current;
    return { x: ((container?.clientWidth ?? 800) / 2 - panX) / zoom, y: ((container?.clientHeight ?? 600) / 2 - panY) / zoom };
  };

  /** Free spot near a point (row by row to the right and below), so new cards never land on top of others. */
  const findFreeSpot = (width: number, height: number, near: WorldPoint): WorldPoint => {
    const obstacles = elementsRef.current.filter((element) => element.type !== "frame" && element.type !== "connector");
    const startX = Math.round(near.x - width / 2);
    const startY = Math.round(near.y - height / 2);
    const isFree = (candidateX: number, candidateY: number) =>
      !obstacles.some(
        (obstacle) =>
          candidateX < obstacle.x + obstacle.width + placementGap &&
          candidateX + width + placementGap > obstacle.x &&
          candidateY < obstacle.y + obstacle.height + placementGap &&
          candidateY + height + placementGap > obstacle.y,
      );
    for (let row = 0; row < 12; row++) {
      for (let column = 0; column < 8; column++) {
        const candidateX = startX + column * (width + placementGap);
        const candidateY = startY + row * (height + placementGap);
        if (isFree(candidateX, candidateY)) return { x: candidateX, y: candidateY };
      }
    }
    return { x: startX, y: startY };
  };

  /** Selects an element and moves the view to it. */
  const locateElement = (element: CanvasElement) => {
    const container = containerRef.current;
    if (!container) return;
    setSelectedElementId(element.id);
    const zoom = clampZoom(Math.min(1, (container.clientWidth * 0.6) / Math.max(element.width, 1), (container.clientHeight * 0.6) / Math.max(element.height, 1)));
    setViewportAnimating(true);
    window.setTimeout(() => setViewportAnimating(false), 220);
    setViewport({
      zoom,
      panX: container.clientWidth / 2 - (element.x + element.width / 2) * zoom,
      panY: container.clientHeight / 2 - (element.y + element.height / 2) * zoom,
    });
  };

  const rootOf = (element: CanvasElement) => element.root ?? props.projectPath;
  const findPlaced = (root: string, filePath: string) =>
    elementsRef.current.find((element) => ["artifact", "file", "folder"].includes(element.type) && element.path === filePath && rootOf(element) === root);

  /** A file or folder onto the canvas (dropped at a point, or at a free spot in view). Already there → show it. */
  const placeItem = (item: CanvasAddItem, dropPoint?: WorldPoint) => {
    const existingElement = findPlaced(item.root, item.path);
    if (existingElement) return locateElement(existingElement);
    const inProjectFolder = item.root === props.projectPath;
    const isVisual = item.kind === "file" && inProjectFolder && visualFilePattern.test(item.path);
    const isHtml = /\.html?$/i.test(item.path);
    const size = isVisual ? (isHtml ? { width: 320, height: 200 } : { width: 220, height: 220 }) : item.kind === "directory" ? cardDefaults.folder : cardDefaults.file;
    const position = dropPoint ? { x: Math.round(dropPoint.x - size.width / 2), y: Math.round(dropPoint.y - cardHeaderHeight / 2) } : findFreeSpot(size.width, size.height, viewportCenter());
    const newElement: CanvasElement = {
      id: crypto.randomUUID(),
      type: isVisual ? "artifact" : item.kind === "directory" ? "folder" : "file",
      path: item.path,
      ...(inProjectFolder ? {} : { root: item.root }),
      ...(isVisual && isHtml ? { viewportWidth: 1280, viewportHeight: 800 } : {}),
      ...position,
      ...size,
    };
    setElements((previous) => [...previous, newElement]);
    setSelectedElementId(newElement.id);
  };

  const addAppTile = () => {
    const size = cardDefaults.app;
    const newElement: CanvasElement = { id: crypto.randomUUID(), type: "app", route: "/", ...findFreeSpot(size.width, size.height, viewportCenter()), ...size };
    setElements((previous) => [...previous, newElement]);
    setSelectedElementId(newElement.id);
  };

  const setAppViewport = (element: CanvasElement, device: keyof typeof appViewports) => {
    const preset = appViewports[device];
    updateElement(element.id, {
      viewportWidth: preset.viewportWidth,
      viewportHeight: preset.viewportHeight,
      width: preset.width,
      height: Math.round((preset.width * preset.viewportHeight) / preset.viewportWidth) + cardHeaderHeight,
    });
  };

  // The file tree's "add to canvas" button.
  const placeItemRef = useRef(placeItem);
  placeItemRef.current = placeItem;
  useEffect(() => {
    const handleAdd = (addEvent: Event) => placeItemRef.current((addEvent as CustomEvent<CanvasAddItem>).detail);
    window.addEventListener(canvasAddEvent, handleAdd);
    return () => window.removeEventListener(canvasAddEvent, handleAdd);
  }, []);

  const handleDragOver = (dragEvent: React.DragEvent) => {
    if (!dragEvent.dataTransfer.types.includes(canvasDragType)) return;
    dragEvent.preventDefault();
    dragEvent.dataTransfer.dropEffect = "copy";
    setDropActive(true);
  };
  const handleDrop = (dragEvent: React.DragEvent) => {
    setDropActive(false);
    const payload = dragEvent.dataTransfer.getData(canvasDragType);
    if (!payload) return;
    dragEvent.preventDefault();
    try {
      placeItem(JSON.parse(payload) as CanvasAddItem, toWorldPoint(dragEvent.clientX, dragEvent.clientY));
    } catch {
      // foreign drag data
    }
  };

  // Live activity of this project: rings on cards, list in the panel.
  const allActivities = useFileActivity();
  const projectActivities = allActivities.filter((activity) => activity.projectId === projectId);
  const [activityClock, setActivityClock] = useState(Date.now());
  useEffect(() => {
    // Re-render once the "done" highlight should fade.
    const fadeTimer = window.setTimeout(() => setActivityClock(Date.now()), doneHighlightMs + 100);
    return () => window.clearTimeout(fadeTimer);
  }, [allActivities]);
  const activityStateOf = (element: CanvasElement): ActivityState => {
    if (!element.path && element.type !== "folder") return null;
    const elementRoot = rootOf(element);
    const elementPath = element.path ?? "";
    const matching = projectActivities.filter(
      (activity) =>
        activity.root === elementRoot && (element.type === "folder" ? elementPath === "" || activity.path.startsWith(elementPath + "/") : activity.path === elementPath),
    );
    if (matching.some((activity) => activity.phase === "editing" && activityClock - activity.at < editingStaleMs)) return "editing";
    if (matching.some((activity) => activity.phase === "done" && Date.now() - activity.at < doneHighlightMs)) return "done";
    return null;
  };
  const latestActivityAt = (element: CanvasElement) => {
    const elementRoot = rootOf(element);
    const elementPath = element.path ?? "";
    return projectActivities
      .filter((activity) => activity.root === elementRoot && activity.phase === "done" && (activity.path === elementPath || elementPath === "" || activity.path.startsWith(elementPath + "/")))
      .reduce((latest, activity) => Math.max(latest, activity.at), 0);
  };
  const editingPathsByRoot = new Map<string, Set<string>>();
  for (const activity of projectActivities) {
    if (activity.phase !== "editing") continue;
    if (!editingPathsByRoot.has(activity.root)) editingPathsByRoot.set(activity.root, new Set());
    editingPathsByRoot.get(activity.root)!.add(activity.path);
  }
  const emptyPathSet = new Set<string>();
  const rootLabelOf = (root: string | undefined) => (root && root !== props.projectPath ? (props.roots.find((projectRoot) => projectRoot.path === root)?.label ?? root.split("/").pop()) : undefined);

  // --- Wheel (needs non-passive listener) ---
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handleWheel = (wheelEvent: WheelEvent) => {
      if (isTypingTarget(wheelEvent.target)) return;
      wheelEvent.preventDefault();
      const containerRect = container.getBoundingClientRect();
      if (wheelEvent.ctrlKey || wheelEvent.metaKey) {
        zoomAround(Math.exp(-wheelEvent.deltaY * 0.01), wheelEvent.clientX - containerRect.left, wheelEvent.clientY - containerRect.top);
      } else {
        setViewport((previous) => ({ ...previous, panX: previous.panX - wheelEvent.deltaX, panY: previous.panY - wheelEvent.deltaY }));
      }
    };
    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => container.removeEventListener("wheel", handleWheel);
  }, []);

  // --- Pinch zoom: two fingers zoom and pan (touch); trackpad pinch in WebKit arrives as gesture events ---
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    type Pinch = { startDistance: number; startZoom: number; worldX: number; worldY: number };
    let activePinch: Pinch | null = null;
    let gestureStartZoom: number | null = null;

    const touchMidpoint = (touches: TouchList) => {
      const containerRect = container.getBoundingClientRect();
      return {
        x: (touches[0].clientX + touches[1].clientX) / 2 - containerRect.left,
        y: (touches[0].clientY + touches[1].clientY) / 2 - containerRect.top,
      };
    };
    const touchDistance = (touches: TouchList) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);

    /** The first finger may already have started something (pan, move, drawing, new shape): undo it, the gesture is a pinch. */
    const cancelSingleFingerInteraction = () => {
      setConnectPreview(null);
      const interaction = interactionRef.current;
      interactionRef.current = null;
      setInteractionKind(null);
      if (!interaction) return;
      if (interaction.kind === "create" || interaction.kind === "draw") {
        setElements((previous) => previous.filter((element) => element.id !== interaction.elementId));
        setSelectedElementId(null);
      } else if (interaction.kind === "move") {
        setElements((previous) =>
          previous.map((element) => {
            const originalPosition = interaction.originalPositions.get(element.id);
            return originalPosition ? { ...element, ...originalPosition } : element;
          }),
        );
      }
    };

    const handleTouchStart = (touchEvent: TouchEvent) => {
      if (touchEvent.touches.length !== 2) return;
      touchEvent.preventDefault();
      cancelSingleFingerInteraction();
      const { panX, panY, zoom } = viewportRef.current;
      const midpoint = touchMidpoint(touchEvent.touches);
      activePinch = { startDistance: Math.max(1, touchDistance(touchEvent.touches)), startZoom: zoom, worldX: (midpoint.x - panX) / zoom, worldY: (midpoint.y - panY) / zoom };
    };
    const handleTouchMove = (touchEvent: TouchEvent) => {
      if (!activePinch || touchEvent.touches.length < 2) return;
      touchEvent.preventDefault();
      // Pointer moves of both fingers must not pan on top of the pinch.
      interactionRef.current = null;
      const nextZoom = clampZoom((activePinch.startZoom * touchDistance(touchEvent.touches)) / activePinch.startDistance);
      const midpoint = touchMidpoint(touchEvent.touches);
      // The world point that started under the fingers stays under them (zoom + two-finger pan in one).
      setViewport({ zoom: nextZoom, panX: midpoint.x - activePinch.worldX * nextZoom, panY: midpoint.y - activePinch.worldY * nextZoom });
    };
    const handleTouchEnd = (touchEvent: TouchEvent) => {
      if (activePinch && touchEvent.touches.length < 2) {
        activePinch = null;
        interactionRef.current = null;
        setInteractionKind(null);
      }
    };

    type GestureEvent = UIEvent & { scale: number; clientX: number; clientY: number };
    const handleGestureStart = (gestureEvent: Event) => {
      gestureEvent.preventDefault();
      gestureStartZoom = activePinch ? null : viewportRef.current.zoom;
    };
    const handleGestureChange = (gestureEvent: Event) => {
      gestureEvent.preventDefault();
      if (gestureStartZoom === null || activePinch) return;
      const { scale, clientX, clientY } = gestureEvent as GestureEvent;
      const containerRect = container.getBoundingClientRect();
      zoomAround(clampZoom(gestureStartZoom * scale) / viewportRef.current.zoom, clientX - containerRect.left, clientY - containerRect.top);
    };
    const handleGestureEnd = (gestureEvent: Event) => {
      gestureEvent.preventDefault();
      gestureStartZoom = null;
    };

    container.addEventListener("touchstart", handleTouchStart, { passive: false, capture: true });
    container.addEventListener("touchmove", handleTouchMove, { passive: false, capture: true });
    container.addEventListener("touchend", handleTouchEnd, { capture: true });
    container.addEventListener("touchcancel", handleTouchEnd, { capture: true });
    container.addEventListener("gesturestart", handleGestureStart);
    container.addEventListener("gesturechange", handleGestureChange);
    container.addEventListener("gestureend", handleGestureEnd);
    return () => {
      container.removeEventListener("touchstart", handleTouchStart, { capture: true });
      container.removeEventListener("touchmove", handleTouchMove, { capture: true });
      container.removeEventListener("touchend", handleTouchEnd, { capture: true });
      container.removeEventListener("touchcancel", handleTouchEnd, { capture: true });
      container.removeEventListener("gesturestart", handleGestureStart);
      container.removeEventListener("gesturechange", handleGestureChange);
      container.removeEventListener("gestureend", handleGestureEnd);
    };
  }, []);

  // --- Keyboard ---
  useEffect(() => {
    const handleKeyDown = (keyboardEvent: KeyboardEvent) => {
      if (isTypingTarget(keyboardEvent.target) || keyboardEvent.metaKey || keyboardEvent.ctrlKey || keyboardEvent.altKey) return;
      if (!containerRef.current?.isConnected || containerRef.current.offsetParent === null) return;
      if (keyboardEvent.key === " ") {
        keyboardEvent.preventDefault();
        setSpaceHeld(true);
        return;
      }
      if ((keyboardEvent.key === "Backspace" || keyboardEvent.key === "Delete") && selectedElementId) {
        removeElement(selectedElementId);
        return;
      }
      if (keyboardEvent.key === "Escape") {
        setInteractiveElementId(null);
        setSelectedElementId(null);
        setActiveTool("select");
        return;
      }
      if (keyboardEvent.key.toLowerCase() === "g") {
        keyboardEvent.preventDefault();
        setImagePanelOpen((open) => !open);
        return;
      }
      const matchingTool = canvasTools.find((entry) => entry.shortcut.toLowerCase() === keyboardEvent.key.toLowerCase());
      if (matchingTool) setActiveTool(matchingTool.tool);
    };
    const handleKeyUp = (keyboardEvent: KeyboardEvent) => {
      if (keyboardEvent.key === " ") setSpaceHeld(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedElementId]);

  // --- Pointer handling ---
  const beginInteraction = (interaction: Interaction, pointerEvent: React.PointerEvent) => {
    interactionRef.current = interaction;
    setInteractionKind(interaction.kind);
    containerRef.current?.setPointerCapture(pointerEvent.pointerId);
  };

  const panning = activeTool === "hand" || spaceHeld;

  const handleBackgroundPointerDown = (pointerEvent: React.PointerEvent) => {
    // A second finger is a pinch (handled by the touch listeners), not a new interaction.
    if (!pointerEvent.isPrimary) return;
    if (pointerEvent.button !== 0 && pointerEvent.button !== 1) return;
    setEditingElementId(null);
    setInteractiveElementId(null);
    if (panning || pointerEvent.button === 1) {
      beginInteraction(
        { kind: "pan", startClientX: pointerEvent.clientX, startClientY: pointerEvent.clientY, startPanX: viewport.panX, startPanY: viewport.panY },
        pointerEvent,
      );
      return;
    }
    const startPoint = toWorldPoint(pointerEvent.clientX, pointerEvent.clientY);
    const newElementId = crypto.randomUUID();

    switch (activeTool) {
      case "select":
      case "connector":
        setSelectedElementId(null);
        beginInteraction(
          { kind: "pan", startClientX: pointerEvent.clientX, startClientY: pointerEvent.clientY, startPanX: viewport.panX, startPanY: viewport.panY },
          pointerEvent,
        );
        return;
      case "frame":
      case "rect":
        setElements((previous) => {
          const newElement: CanvasElement = { id: newElementId, type: activeTool, x: startPoint.x, y: startPoint.y, width: 1, height: 1, ...(activeTool === "frame" ? { title: t("Frame") } : {}) };
          // Frames go first so they render behind content.
          return activeTool === "frame" ? [newElement, ...previous] : [...previous, newElement];
        });
        setSelectedElementId(newElementId);
        beginInteraction({ kind: "create", elementId: newElementId, startPoint }, pointerEvent);
        return;
      case "text":
      case "note": {
        const size = activeTool === "note" ? { width: 200, height: 160 } : { width: 240, height: 40 };
        setElements((previous) => [...previous, { id: newElementId, type: activeTool, x: startPoint.x, y: startPoint.y, ...size, text: "" }]);
        setSelectedElementId(newElementId);
        setEditingElementId(newElementId);
        setActiveTool("select");
        return;
      }
      case "pen":
        setElements((previous) => [...previous, { id: newElementId, type: "drawing", x: startPoint.x, y: startPoint.y, width: 1, height: 1, points: [[0, 0]] }]);
        beginInteraction({ kind: "draw", elementId: newElementId, absolutePoints: [[startPoint.x, startPoint.y]] }, pointerEvent);
        return;
    }
  };

  const handleElementPointerDown = (pointerEvent: React.PointerEvent, element: CanvasElement) => {
    if (activeTool === "connector" && !panning && pointerEvent.button === 0 && pointerEvent.isPrimary) {
      pointerEvent.stopPropagation();
      const startPoint = toWorldPoint(pointerEvent.clientX, pointerEvent.clientY);
      setConnectPreview({ fromId: element.id, ...startPoint });
      beginInteraction({ kind: "connect", fromId: element.id }, pointerEvent);
      return;
    }
    if (activeTool !== "select" || panning || pointerEvent.button !== 0 || !pointerEvent.isPrimary) return;
    pointerEvent.stopPropagation();
    if (interactiveElementId && interactiveElementId !== element.id) setInteractiveElementId(null);
    if (editingElementId === element.id) return;
    setEditingElementId(null);
    setSelectedElementId(element.id);
    const movingIds = new Set([element.id]);
    if (element.type === "frame") for (const child of elementsRef.current) if (child.frameId === element.id) movingIds.add(child.id);
    const originalPositions = new Map(
      elementsRef.current.filter((candidate) => movingIds.has(candidate.id)).map((candidate) => [candidate.id, { x: candidate.x, y: candidate.y }]),
    );
    beginInteraction(
      { kind: "move", elementId: element.id, startPoint: toWorldPoint(pointerEvent.clientX, pointerEvent.clientY), originalPositions, moved: false },
      pointerEvent,
    );
  };

  const handleResizePointerDown = (pointerEvent: React.PointerEvent, element: CanvasElement) => {
    pointerEvent.stopPropagation();
    if (!pointerEvent.isPrimary) return;
    beginInteraction(
      { kind: "resize", elementId: element.id, startPoint: toWorldPoint(pointerEvent.clientX, pointerEvent.clientY), startWidth: element.width, startHeight: element.height },
      pointerEvent,
    );
  };

  const handlePointerMove = (pointerEvent: React.PointerEvent) => {
    const interaction = interactionRef.current;
    if (!interaction) return;
    if (interaction.kind === "pan") {
      setViewport((previous) => ({
        ...previous,
        panX: interaction.startPanX + pointerEvent.clientX - interaction.startClientX,
        panY: interaction.startPanY + pointerEvent.clientY - interaction.startClientY,
      }));
      return;
    }
    const currentPoint = toWorldPoint(pointerEvent.clientX, pointerEvent.clientY);
    switch (interaction.kind) {
      case "connect":
        setConnectPreview({ fromId: interaction.fromId, ...currentPoint });
        return;
      case "move": {
        const deltaX = currentPoint.x - interaction.startPoint.x;
        const deltaY = currentPoint.y - interaction.startPoint.y;
        if (Math.abs(deltaX) + Math.abs(deltaY) > 0.5) interaction.moved = true;
        setElements((previous) =>
          previous.map((element) => {
            const originalPosition = interaction.originalPositions.get(element.id);
            return originalPosition ? { ...element, x: originalPosition.x + deltaX, y: originalPosition.y + deltaY } : element;
          }),
        );
        return;
      }
      case "resize":
        updateElement(interaction.elementId, {
          width: Math.max(24, interaction.startWidth + currentPoint.x - interaction.startPoint.x),
          height: Math.max(24, interaction.startHeight + currentPoint.y - interaction.startPoint.y),
        });
        return;
      case "create":
        updateElement(interaction.elementId, {
          x: Math.min(interaction.startPoint.x, currentPoint.x),
          y: Math.min(interaction.startPoint.y, currentPoint.y),
          width: Math.abs(currentPoint.x - interaction.startPoint.x),
          height: Math.abs(currentPoint.y - interaction.startPoint.y),
        });
        return;
      case "draw": {
        interaction.absolutePoints.push([currentPoint.x, currentPoint.y]);
        const originX = Math.min(...interaction.absolutePoints.map(([pointX]) => pointX));
        const originY = Math.min(...interaction.absolutePoints.map(([, pointY]) => pointY));
        updateElement(interaction.elementId, {
          x: originX,
          y: originY,
          width: Math.max(...interaction.absolutePoints.map(([pointX]) => pointX)) - originX,
          height: Math.max(...interaction.absolutePoints.map(([, pointY]) => pointY)) - originY,
          points: interaction.absolutePoints.map(([pointX, pointY]) => [pointX - originX, pointY - originY]),
        });
        return;
      }
    }
  };

  const handlePointerUp = (pointerEvent: React.PointerEvent) => {
    const interaction = interactionRef.current;
    interactionRef.current = null;
    setInteractionKind(null);
    if (!interaction) return;

    if (interaction.kind === "connect") {
      setConnectPreview(null);
      const target = elementAt(toWorldPoint(pointerEvent.clientX, pointerEvent.clientY));
      const alreadyConnected = elementsRef.current.some(
        (element) => element.type === "connector" && ((element.fromId === interaction.fromId && element.toId === target?.id) || (element.toId === interaction.fromId && element.fromId === target?.id)),
      );
      if (target && target.id !== interaction.fromId && !alreadyConnected) {
        const connectorId = crypto.randomUUID();
        setElements((previous) => [...previous, { id: connectorId, type: "connector", x: 0, y: 0, width: 0, height: 0, fromId: interaction.fromId, toId: target.id }]);
        setSelectedElementId(connectorId);
      }
      setActiveTool("select");
      return;
    }

    if (interaction.kind === "create") {
      setElements((previous) =>
        previous.map((element) => {
          if (element.id !== interaction.elementId || (element.width >= 8 && element.height >= 8)) return element;
          const defaultSize = element.type === "frame" ? { width: 480, height: 320 } : { width: 160, height: 100 };
          return { ...element, ...defaultSize };
        }),
      );
      setActiveTool("select");
    }

    // After moving a non-frame element, assign it to the smallest frame containing its center.
    if (interaction.kind === "move" && interaction.moved) {
      setElements((previous) => {
        const movedElement = previous.find((element) => element.id === interaction.elementId);
        if (!movedElement || movedElement.type === "frame") return previous;
        const centerX = movedElement.x + movedElement.width / 2;
        const centerY = movedElement.y + movedElement.height / 2;
        const containingFrame = previous
          .filter((element) => element.type === "frame" && centerX >= element.x && centerX <= element.x + element.width && centerY >= element.y && centerY <= element.y + element.height)
          .sort((first, second) => first.width * first.height - second.width * second.height)[0];
        return previous.map((element) => (element.id === movedElement.id ? { ...element, frameId: containingFrame?.id ?? null } : element));
      });
    }
  };

  // --- Selection actions ---
  const selectedElement = elements.find((element) => element.id === selectedElementId) ?? null;

  const labelOf = (element: CanvasElement | undefined): string =>
    !element ? "?" : element.title || element.path?.split("/").pop() || element.text?.slice(0, 40) || (element.type === "app" ? t("App") : element.type);

  const describeForAgent = (element: CanvasElement): string => {
    switch (element.type) {
      case "artifact":
        return `@${element.path} `;
      case "file":
      case "folder":
        return `@${element.root ? `${element.root}/` : ""}${element.path} `;
      case "app": {
        const shownPort = props.devServers.find((devServer) => devServer.port === element.port)?.port ?? props.devServers[0]?.port;
        return t("Live-App (Route {0}{1}): ", element.route || "/", shownPort ? `, Port ${shownPort}` : "");
      }
      case "connector": {
        const describeEnd = (endId: string | undefined) => {
          const endElement = elements.find((candidate) => candidate.id === endId);
          return endElement?.path ? `@${endElement.root ? `${endElement.root}/` : ""}${endElement.path}` : `„${labelOf(endElement)}“`;
        };
        return t("Verbindung {0} → {1}{2}: ", describeEnd(element.fromId), describeEnd(element.toId), element.text ? ` („${element.text}“)` : "");
      }
      case "frame": {
        const childPaths = elements.filter((child) => child.frameId === element.id && child.path).map((child) => `@${child.path}`);
        return t("Canvas-Frame „{0}“{1}: ", element.title || t("Frame"), childPaths.length ? ` (${childPaths.join(" ")})` : "");
      }
      case "note":
      case "text":
        return t("Canvas-Notiz: „{0}“ – ", element.text ?? "");
      default:
        return t("Canvas-Element: ");
    }
  };

  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const resizeObserver = new ResizeObserver(() => setContainerSize({ width: container.clientWidth, height: container.clientHeight }));
    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, []);

  const selectedRect = selectedElement ? displayRectOf(selectedElement) : null;
  const selectionToolbarPosition =
    selectedElement && selectedRect
      ? {
          left: Math.min(Math.max(8, selectedRect.x * viewport.zoom + viewport.panX), containerSize.width - 320),
          top: Math.max(8, (selectedRect.y - (selectedElement.type === "frame" ? 28 : 0)) * viewport.zoom + viewport.panY - 44),
        }
      : null;

  const renderElement = (element: CanvasElement) => {
    const projectReloadKey = !element.root && element.path !== undefined ? (reloadKeysByPath[element.path] ?? 0) : 0;
    return (
      <CanvasElementView
        key={element.id}
        element={element}
        projectId={projectId}
        zoom={viewport.zoom}
        selected={element.id === selectedElementId}
        editing={element.id === editingElementId}
        reloadKey={element.type === "app" ? 0 : projectReloadKey + latestActivityAt(element)}
        devServers={props.devServers}
        interactive={element.id === interactiveElementId}
        rootLabel={rootLabelOf(element.root)}
        activityState={activityStateOf(element)}
        activePaths={element.type === "folder" ? (editingPathsByRoot.get(rootOf(element)) ?? emptyPathSet) : emptyPathSet}
        onOpenEntry={(filePath, root) => props.onOpenFile(filePath, root)}
        onPointerDown={handleElementPointerDown}
        onResizePointerDown={handleResizePointerDown}
        onDoubleClick={(clickedElement) => {
          if ((clickedElement.type === "artifact" || clickedElement.type === "file") && clickedElement.path) props.onOpenFile(clickedElement.path, clickedElement.root);
          else if (clickedElement.type === "app") setInteractiveElementId(clickedElement.id);
          else if (clickedElement.type === "note" || clickedElement.type === "text") setEditingElementId(clickedElement.id);
          else if (clickedElement.type === "frame") setEditingElementId(clickedElement.id);
        }}
        onTextChange={(changedElement, text) => updateElement(changedElement.id, changedElement.type === "frame" ? { title: text } : { text })}
        onFinishEditing={() => setEditingElementId(null)}
      />
    );
  };

  const cursorClassName =
    interactionKind === "pan" ? "cursor-grabbing" : panning ? "cursor-grab" : activeTool === "select" ? "cursor-default" : "cursor-crosshair";

  const dotSpacing = 24 * viewport.zoom;

  return (
    <div
      ref={containerRef}
      className={cn("relative size-full touch-none overflow-hidden bg-canvas outline-none select-none", cursorClassName)}
      style={{
        backgroundImage: "radial-gradient(color-mix(in oklch, var(--foreground) 14%, transparent) 1px, transparent 1px)",
        backgroundSize: `${dotSpacing}px ${dotSpacing}px`,
        backgroundPosition: `${viewport.panX}px ${viewport.panY}px`,
        transition: viewportAnimating ? "background-size 200ms ease-out, background-position 200ms ease-out" : undefined,
      }}
      onPointerDown={handleBackgroundPointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onDragOver={handleDragOver}
      onDragLeave={() => setDropActive(false)}
      onDrop={handleDrop}
    >
      <div
        className="absolute top-0 left-0 origin-top-left"
        style={{
          transform: `translate(${viewport.panX}px, ${viewport.panY}px) scale(${viewport.zoom})`,
          transition: viewportAnimating ? "transform 200ms ease-out" : undefined,
        }}
      >
        {elements.filter((element) => element.type === "frame").map((element) => renderElement(element))}
        <svg className="pointer-events-none absolute top-0 left-0 overflow-visible" width={1} height={1} aria-hidden>
          <defs>
            <marker id="canvas-arrow-head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="context-stroke" />
            </marker>
          </defs>
          {elements
            .filter((element) => element.type === "connector")
            .map((connector) => {
              const fromElement = elements.find((candidate) => candidate.id === connector.fromId);
              const toElement = elements.find((candidate) => candidate.id === connector.toId);
              if (!fromElement || !toElement) return null;
              const { start, end } = connectorEnds(fromElement, toElement);
              const isSelected = connector.id === selectedElementId;
              const strokeWidth = 2 / Math.min(viewport.zoom, 1);
              return (
                <g key={connector.id}>
                  <line
                    x1={start.x}
                    y1={start.y}
                    x2={end.x}
                    y2={end.y}
                    stroke="transparent"
                    strokeWidth={14 / viewport.zoom}
                    style={{ pointerEvents: "stroke", cursor: "pointer" }}
                    onPointerDown={(pointerEvent) => {
                      if (activeTool !== "select" || pointerEvent.button !== 0) return;
                      pointerEvent.stopPropagation();
                      setSelectedElementId(connector.id);
                    }}
                  />
                  <line
                    x1={start.x}
                    y1={start.y}
                    x2={end.x}
                    y2={end.y}
                    stroke={isSelected ? "rgb(14 165 233)" : "color-mix(in oklch, var(--foreground) 55%, transparent)"}
                    strokeWidth={strokeWidth}
                    strokeLinecap="round"
                    markerEnd="url(#canvas-arrow-head)"
                  />
                  {connector.text && (
                    <text
                      x={(start.x + end.x) / 2}
                      y={(start.y + end.y) / 2 - 6 / viewport.zoom}
                      textAnchor="middle"
                      fontSize={12 / Math.min(viewport.zoom, 1)}
                      className="fill-muted-foreground"
                      style={{ paintOrder: "stroke", stroke: "var(--canvas, var(--background))", strokeWidth: 4 / Math.min(viewport.zoom, 1) }}
                    >
                      {connector.text}
                    </text>
                  )}
                </g>
              );
            })}
          {connectPreview &&
            (() => {
              const fromElement = elements.find((candidate) => candidate.id === connectPreview.fromId);
              if (!fromElement) return null;
              const start = edgePoint(fromElement, connectPreview.x, connectPreview.y);
              return (
                <line
                  x1={start.x}
                  y1={start.y}
                  x2={connectPreview.x}
                  y2={connectPreview.y}
                  stroke="rgb(14 165 233)"
                  strokeWidth={2 / Math.min(viewport.zoom, 1)}
                  strokeDasharray={`${6 / viewport.zoom} ${4 / viewport.zoom}`}
                  markerEnd="url(#canvas-arrow-head)"
                />
              );
            })()}
        </svg>
        {elements.filter((element) => element.type !== "frame" && element.type !== "connector").map((element) => renderElement(element))}
      </div>

      {loaded && elements.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-8 text-center text-[13px] text-muted-foreground">
          {t("Der Canvas ist leer. Entwürfe unter design/ erscheinen automatisch – Dateien und Ordner aus dem Dateibaum hierher ziehen, die laufende App über die Leiste unten hinzufügen.")}
        </div>
      )}

      {selectedElement && selectionToolbarPosition && !interactionKind && (
        <div
          key={selectedElement.id}
          className="absolute z-20 flex animate-in items-center gap-0.5 rounded-lg border bg-popover p-0.5 shadow-md fade-in slide-in-from-bottom-1 duration-150"
          style={selectionToolbarPosition}
          onPointerDown={(pointerEvent) => pointerEvent.stopPropagation()}
        >
          <Button size="sm" variant="ghost" className="h-7 gap-1.5 px-2 text-[12px]" onClick={() => props.onSendToAgent(describeForAgent(selectedElement))}>
            <MessageSquarePlus className="size-3.5" /> {t("An Agent")}
          </Button>
          {(selectedElement.type === "artifact" || selectedElement.type === "file") && selectedElement.path && (
            <Button size="sm" variant="ghost" className="h-7 gap-1.5 px-2 text-[12px]" onClick={() => props.onOpenFile(selectedElement.path!, selectedElement.root)}>
              <ExternalLink className="size-3.5" /> {t("Öffnen")}
            </Button>
          )}
          {selectedElement.type === "app" && (
            <>
              <ToolbarInput
                key={`route-${selectedElement.id}`}
                initialValue={selectedElement.route || "/"}
                placeholder="/"
                label={t("Route")}
                className="w-28 font-mono"
                onCommit={(route) => updateElement(selectedElement.id, { route: route.trim() || "/" })}
              />
              {props.devServers.length > 1 && (
                <select
                  className="h-7 rounded-md bg-transparent px-1 text-[12px] text-muted-foreground outline-none hover:bg-foreground/5"
                  aria-label={t("Server")}
                  value={selectedElement.port ?? ""}
                  onChange={(changeEvent) => updateElement(selectedElement.id, { port: changeEvent.target.value ? Number(changeEvent.target.value) : undefined })}
                >
                  <option value="">{t("Automatisch")}</option>
                  {props.devServers.map((devServer) => (
                    <option key={devServer.port} value={devServer.port}>
                      :{devServer.port}
                    </option>
                  ))}
                </select>
              )}
              <IconButton label={t("Desktop")} active={(selectedElement.viewportWidth ?? 1280) > 600} onClick={() => setAppViewport(selectedElement, "desktop")}>
                <Monitor className="size-3.5" />
              </IconButton>
              <IconButton label={t("Mobil")} active={(selectedElement.viewportWidth ?? 1280) <= 600} onClick={() => setAppViewport(selectedElement, "mobile")}>
                <Smartphone className="size-3.5" />
              </IconButton>
              <IconButton label={t("Bedienen (Doppelklick, Esc beendet)")} active={interactiveElementId === selectedElement.id} onClick={() => setInteractiveElementId((current) => (current === selectedElement.id ? null : selectedElement.id))}>
                <MousePointerClick className="size-3.5" />
              </IconButton>
            </>
          )}
          {selectedElement.type === "connector" && (
            <ToolbarInput
              key={`label-${selectedElement.id}`}
              initialValue={selectedElement.text ?? ""}
              placeholder={t("Beschriftung")}
              label={t("Beschriftung")}
              className="w-36"
              onCommit={(text) => updateElement(selectedElement.id, { text: text.trim() || undefined })}
            />
          )}
          <Button
            size="icon"
            variant="ghost"
            className="size-7 text-muted-foreground hover:text-destructive"
            aria-label={t("Vom Canvas entfernen")}
            onClick={() => removeElement(selectedElement.id)}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      )}

      {imagePanelOpen && (
        <ImageGenerationPanel
          projectId={projectId}
          selectedImagePath={
            selectedElement?.type === "artifact" && selectedElement.path && /\.(png|jpe?g|webp)$/i.test(selectedElement.path) ? selectedElement.path : null
          }
          anchorFor={(imageCount) => {
            const { panX, panY, zoom } = viewportRef.current;
            const imageWidth = 260;
            const rowWidth = imageCount * imageWidth + (imageCount - 1) * 32;
            return {
              x: Math.round((containerSize.width / 2 - panX) / zoom - rowWidth / 2),
              y: Math.round((containerSize.height / 2 - panY) / zoom - imageWidth / 2),
            };
          }}
          onGenerated={() => void loadCanvas(false)}
          onClose={() => setImagePanelOpen(false)}
          onError={onError}
        />
      )}

      <CanvasActivityPanel
        activities={projectActivities}
        isOnCanvas={(activity: FileActivity) => Boolean(findPlaced(activity.root, activity.path))}
        rootLabel={(root) => rootLabelOf(root)}
        onPlace={(activity) => placeItem({ root: activity.root, path: activity.path, kind: "file" })}
        onLocate={(activity) => {
          const placedElement = findPlaced(activity.root, activity.path);
          if (placedElement) locateElement(placedElement);
        }}
      />

      {dropActive && <div className="pointer-events-none absolute inset-2 z-10 rounded-xl border-2 border-dashed border-sky-500/60 bg-sky-500/5" />}

      <CanvasToolbar
        activeTool={activeTool}
        onToolChange={setActiveTool}
        imagePanelOpen={imagePanelOpen}
        onToggleImagePanel={() => setImagePanelOpen((open) => !open)}
        onAddApp={addAppTile}
        onAddFiles={props.onOpenFilePanel}
      />

      <div
        className="absolute right-4 bottom-4 z-20 flex items-center gap-0.5 rounded-lg border bg-popover p-0.5 shadow-md"
        onPointerDown={(pointerEvent) => pointerEvent.stopPropagation()}
      >
        <Button size="icon" variant="ghost" className="size-7 text-muted-foreground" aria-label={t("Verkleinern")} onClick={() => zoomAroundCenter(1 / 1.25)}>
          <Minus className="size-3.5" />
        </Button>
        <span className="w-11 text-center text-[11px] text-muted-foreground tabular-nums">{Math.round(viewport.zoom * 100)}%</span>
        <Button size="icon" variant="ghost" className="size-7 text-muted-foreground" aria-label={t("Vergrößern")} onClick={() => zoomAroundCenter(1.25)}>
          <Plus className="size-3.5" />
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="icon" variant="ghost" className="size-7 text-muted-foreground" aria-label={t("Alles zeigen")} onClick={() => fitToContent(elements, true)}>
              <Maximize className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">{t("Alles zeigen")}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

function IconButton(props: { label: string; active?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button size="icon" variant="ghost" className={cn("size-7 text-muted-foreground", props.active && "bg-foreground/10 text-foreground")} aria-label={props.label} aria-pressed={props.active} onClick={props.onClick}>
          {props.children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{props.label}</TooltipContent>
    </Tooltip>
  );
}

/** Small text field in the selection toolbar; commits on Enter and on leaving the field. */
function ToolbarInput(props: { initialValue: string; placeholder: string; label: string; className?: string; onCommit: (value: string) => void }) {
  const [value, setValue] = useState(props.initialValue);
  return (
    <input
      className={cn("h-7 rounded-md border bg-background px-2 text-[12px] outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring", props.className)}
      value={value}
      placeholder={props.placeholder}
      aria-label={props.label}
      title={props.label}
      onChange={(changeEvent) => setValue(changeEvent.target.value)}
      onKeyDown={(keyboardEvent) => {
        keyboardEvent.stopPropagation();
        if (keyboardEvent.key === "Enter") keyboardEvent.currentTarget.blur();
        if (keyboardEvent.key === "Escape") {
          setValue(props.initialValue);
          keyboardEvent.currentTarget.blur();
        }
      }}
      onBlur={() => value !== props.initialValue && props.onCommit(value)}
    />
  );
}
