import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ExternalLink, Maximize, MessageSquarePlus, Minus, Plus, Trash2 } from "lucide-react";
import { api } from "@/api";
import type { CanvasDocument, CanvasElement } from "@/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CanvasElementView } from "./canvas-element-view";
import { CanvasToolbar, canvasTools, type CanvasTool } from "./canvas-toolbar";
import { ImageGenerationPanel } from "./image-generation-panel";

type ProjectCanvasProps = {
  projectId: string;
  fileChangeCounter: number;
  lastChangedPaths: string[];
  onOpenFile: (filePath: string) => void;
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
  | { kind: "draw"; elementId: string; absolutePoints: [number, number][] };

const minZoom = 0.08;
const maxZoom = 4;
const artifactPathPattern = /^(design|assets)\/.+\.(html?|svg|png|jpe?g|webp|gif)$/i;
const clampZoom = (zoom: number) => Math.min(maxZoom, Math.max(minZoom, zoom));

function boundsOf(elements: CanvasElement[]) {
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
    if (!changedArtifactPaths.length) return;
    const knownPaths = new Set(elementsRef.current.flatMap((element) => (element.path ? [element.path] : [])));
    if (changedArtifactPaths.some((changedPath) => !knownPaths.has(changedPath))) void loadCanvas(false);
    setReloadKeysByPath((previous) => {
      const next = { ...previous };
      for (const changedPath of changedArtifactPaths) next[changedPath] = (next[changedPath] ?? 0) + 1;
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
        .filter((element) => element.id !== elementId)
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
    if (pointerEvent.button !== 0 && pointerEvent.button !== 1) return;
    setEditingElementId(null);
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
        setSelectedElementId(null);
        beginInteraction(
          { kind: "pan", startClientX: pointerEvent.clientX, startClientY: pointerEvent.clientY, startPanX: viewport.panX, startPanY: viewport.panY },
          pointerEvent,
        );
        return;
      case "frame":
      case "rect":
        setElements((previous) => {
          const newElement: CanvasElement = { id: newElementId, type: activeTool, x: startPoint.x, y: startPoint.y, width: 1, height: 1, ...(activeTool === "frame" ? { title: "Frame" } : {}) };
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
    if (activeTool !== "select" || panning || pointerEvent.button !== 0) return;
    pointerEvent.stopPropagation();
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

  const handlePointerUp = () => {
    const interaction = interactionRef.current;
    interactionRef.current = null;
    setInteractionKind(null);
    if (!interaction) return;

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

  const describeForAgent = (element: CanvasElement): string => {
    switch (element.type) {
      case "artifact":
        return `@${element.path} `;
      case "frame": {
        const childPaths = elements.filter((child) => child.frameId === element.id && child.path).map((child) => `@${child.path}`);
        return `Canvas-Frame „${element.title || "Frame"}“${childPaths.length ? ` (${childPaths.join(" ")})` : ""}: `;
      }
      case "note":
      case "text":
        return `Canvas-Notiz: „${element.text ?? ""}“ – `;
      default:
        return "Canvas-Element: ";
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

  const selectionToolbarPosition = selectedElement
    ? {
        left: Math.min(Math.max(8, selectedElement.x * viewport.zoom + viewport.panX), containerSize.width - 220),
        top: Math.max(8, (selectedElement.y - (selectedElement.type === "frame" ? 28 : 0)) * viewport.zoom + viewport.panY - 44),
      }
    : null;

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
    >
      <div
        className="absolute top-0 left-0 origin-top-left"
        style={{
          transform: `translate(${viewport.panX}px, ${viewport.panY}px) scale(${viewport.zoom})`,
          transition: viewportAnimating ? "transform 200ms ease-out" : undefined,
        }}
      >
        {[...elements]
          .sort((first, second) => Number(second.type === "frame") - Number(first.type === "frame"))
          .map((element) => (
            <CanvasElementView
              key={element.id}
              element={element}
              projectId={projectId}
              zoom={viewport.zoom}
              selected={element.id === selectedElementId}
              editing={element.id === editingElementId}
              reloadKey={element.path ? (reloadKeysByPath[element.path] ?? 0) : 0}
              onPointerDown={handleElementPointerDown}
              onResizePointerDown={handleResizePointerDown}
              onDoubleClick={(clickedElement) => {
                if (clickedElement.type === "artifact" && clickedElement.path) props.onOpenFile(clickedElement.path);
                else if (clickedElement.type === "note" || clickedElement.type === "text") setEditingElementId(clickedElement.id);
                else if (clickedElement.type === "frame") setEditingElementId(clickedElement.id);
              }}
              onTextChange={(changedElement, text) =>
                updateElement(changedElement.id, changedElement.type === "frame" ? { title: text } : { text })
              }
              onFinishEditing={() => setEditingElementId(null)}
            />
          ))}
      </div>

      {loaded && elements.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-8 text-center text-[13px] text-muted-foreground">
          Der Canvas ist leer. Entwürfe des Agents unter design/ erscheinen hier automatisch.
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
            <MessageSquarePlus className="size-3.5" /> An Agent
          </Button>
          {selectedElement.type === "artifact" && selectedElement.path && (
            <Button size="sm" variant="ghost" className="h-7 gap-1.5 px-2 text-[12px]" onClick={() => props.onOpenFile(selectedElement.path!)}>
              <ExternalLink className="size-3.5" /> Öffnen
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            className="size-7 text-muted-foreground hover:text-destructive"
            aria-label="Vom Canvas entfernen"
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

      <CanvasToolbar activeTool={activeTool} onToolChange={setActiveTool} imagePanelOpen={imagePanelOpen} onToggleImagePanel={() => setImagePanelOpen((open) => !open)} />

      <div
        className="absolute right-4 bottom-4 z-20 flex items-center gap-0.5 rounded-lg border bg-popover p-0.5 shadow-md"
        onPointerDown={(pointerEvent) => pointerEvent.stopPropagation()}
      >
        <Button size="icon" variant="ghost" className="size-7 text-muted-foreground" aria-label="Verkleinern" onClick={() => zoomAroundCenter(1 / 1.25)}>
          <Minus className="size-3.5" />
        </Button>
        <span className="w-11 text-center text-[11px] text-muted-foreground tabular-nums">{Math.round(viewport.zoom * 100)}%</span>
        <Button size="icon" variant="ghost" className="size-7 text-muted-foreground" aria-label="Vergrößern" onClick={() => zoomAroundCenter(1.25)}>
          <Plus className="size-3.5" />
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="icon" variant="ghost" className="size-7 text-muted-foreground" aria-label="Alles zeigen" onClick={() => fitToContent(elements, true)}>
              <Maximize className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">Alles zeigen</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
