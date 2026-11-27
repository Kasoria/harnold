import { useEffect, useRef } from "react";
import { api } from "@/api";
import type { CanvasElement, DevServer } from "@/types";
import { ActivityRing, AppTile, FileCard, FolderCard, type ActivityState } from "./canvas-cards";
import { cn, isActionEnter } from "@/lib/utils";
import { t } from "@/lib/i18n";

type CanvasElementViewProps = {
  element: CanvasElement;
  projectId: string;
  selected: boolean;
  editing: boolean;
  reloadKey: number;
  zoom: number;
  onPointerDown: (pointerEvent: React.PointerEvent, element: CanvasElement) => void;
  onResizePointerDown: (pointerEvent: React.PointerEvent, element: CanvasElement) => void;
  onDoubleClick: (element: CanvasElement) => void;
  onTextChange: (element: CanvasElement, text: string) => void;
  onFinishEditing: () => void;
  /** app tiles: the dev servers to show (project's first). */
  devServers: DevServer[];
  interactive: boolean;
  /** file/folder cards from an attached folder: its name. */
  rootLabel?: string;
  activityState: ActivityState;
  /** folder cards: paths (relative to the root) the agent is working on. */
  activePaths: Set<string>;
  onOpenEntry: (filePath: string, root?: string) => void;
};

const htmlExtensions = /\.html?$/i;

function EditableText(props: { value: string; className: string; onChange: (text: string) => void; onDone: () => void }) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    textareaRef.current?.focus();
    textareaRef.current?.select();
  }, []);
  return (
    <textarea
      ref={textareaRef}
      value={props.value}
      onChange={(changeEvent) => props.onChange(changeEvent.target.value)}
      onBlur={props.onDone}
      onKeyDown={(keyboardEvent) => {
        keyboardEvent.stopPropagation();
        if (keyboardEvent.key === "Escape") props.onDone();
      }}
      onPointerDown={(pointerEvent) => pointerEvent.stopPropagation()}
      className={cn("size-full resize-none bg-transparent outline-none", props.className)}
    />
  );
}

export function CanvasElementView(props: CanvasElementViewProps) {
  const { element } = props;
  const inverseZoom = 1 / props.zoom;

  const body = (() => {
    switch (element.type) {
      case "frame":
        return <div className="size-full rounded-xl bg-black/[0.045] dark:bg-white/[0.045]" />;
      case "artifact": {
        if (!element.path) return null;
        const fileName = element.path.split("/").pop();
        const isHtml = htmlExtensions.test(element.path);
        const viewportWidth = element.viewportWidth ?? 1280;
        const viewportHeight = element.viewportHeight ?? 800;
        const thumbnailScale = element.width / viewportWidth;
        return (
          <>
            <div className="size-full overflow-hidden rounded-md border bg-white shadow-xs">
              {isHtml ? (
                <iframe
                  key={props.reloadKey}
                  title={fileName}
                  src={api.previewUrl(props.projectId, element.path)}
                  sandbox="allow-scripts"
                  loading="lazy"
                  tabIndex={-1}
                  className="pointer-events-none origin-top-left border-0"
                  style={{ width: viewportWidth, height: viewportHeight, transform: `scale(${thumbnailScale})` }}
                />
              ) : (
                <img
                  key={props.reloadKey}
                  src={api.previewUrl(props.projectId, element.path)}
                  alt={fileName}
                  draggable={false}
                  className="size-full object-cover"
                />
              )}
            </div>
            <div
              className="absolute top-full left-0 mt-1 w-full origin-top-left truncate text-[11px] text-muted-foreground"
              style={{ transform: `scale(${Math.min(inverseZoom, 3)})`, width: `${100 / Math.min(inverseZoom, 3)}%` }}
            >
              {fileName}
            </div>
          </>
        );
      }
      case "file":
        return <FileCard element={element} projectId={props.projectId} rootLabel={props.rootLabel} reloadKey={props.reloadKey} />;
      case "folder":
        return (
          <FolderCard
            element={element}
            projectId={props.projectId}
            rootLabel={props.rootLabel}
            reloadKey={props.reloadKey}
            activePaths={props.activePaths}
            onOpenEntry={(filePath) => props.onOpenEntry(filePath, element.root)}
          />
        );
      case "app":
        return <AppTile element={element} devServers={props.devServers} interactive={props.interactive} reloadKey={props.reloadKey} />;
      case "connector":
        return null;
      case "note":
        return (
          <div className="size-full rounded-md bg-amber-100 p-3 text-[13px] leading-snug text-amber-950 shadow-sm dark:bg-amber-200">
            {props.editing ? (
              <EditableText value={element.text ?? ""} className="text-[13px] leading-snug" onChange={(text) => props.onTextChange(element, text)} onDone={props.onFinishEditing} />
            ) : (
              <p className="whitespace-pre-wrap">{element.text || t("Notiz")}</p>
            )}
          </div>
        );
      case "text":
        return props.editing ? (
          <EditableText value={element.text ?? ""} className="text-[18px] font-medium" onChange={(text) => props.onTextChange(element, text)} onDone={props.onFinishEditing} />
        ) : (
          <p className="text-[18px] font-medium whitespace-pre-wrap">{element.text || t("Text")}</p>
        );
      case "rect":
        return <div className="size-full rounded-sm border-2 border-foreground/70" />;
      case "drawing":
        return (
          <svg className="size-full overflow-visible" viewBox={`0 0 ${Math.max(element.width, 1)} ${Math.max(element.height, 1)}`}>
            <polyline
              points={(element.points ?? []).map(([pointX, pointY]) => `${pointX},${pointY}`).join(" ")}
              fill="none"
              stroke="currentColor"
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        );
    }
  })();

  return (
    <div
      data-canvas-element
      className={cn("absolute", element.type === "drawing" && "text-foreground")}
      style={{ left: element.x, top: element.y, width: element.width, height: element.height }}
      onPointerDown={(pointerEvent) => props.onPointerDown(pointerEvent, element)}
      onDoubleClick={() => props.onDoubleClick(element)}
    >
      {element.type === "frame" && (
        <div
          className="absolute bottom-full left-0 mb-1.5 origin-bottom-left truncate text-[13px] font-semibold"
          style={{ transform: `scale(${Math.min(inverseZoom, 3)})`, maxWidth: element.width * props.zoom }}
        >
          {props.editing ? (
            <input
              autoFocus
              defaultValue={element.title || t("Frame")}
              onPointerDown={(pointerEvent) => pointerEvent.stopPropagation()}
              onKeyDown={(keyboardEvent) => {
                keyboardEvent.stopPropagation();
                if (isActionEnter(keyboardEvent) || keyboardEvent.key === "Escape") keyboardEvent.currentTarget.blur();
              }}
              onBlur={(blurEvent) => {
                props.onTextChange(element, blurEvent.currentTarget.value.trim() || "Frame");
                props.onFinishEditing();
              }}
              className="rounded bg-background px-1 font-semibold outline-none ring-1 ring-sky-500"
            />
          ) : (
            element.title || t("Frame")
          )}
        </div>
      )}
      {body}
      <ActivityRing state={props.activityState} inverseZoom={inverseZoom} />
      <div
        className={cn(
          "pointer-events-none absolute inset-0 rounded-md transition-opacity duration-150",
          props.selected ? "opacity-100" : "opacity-0",
        )}
        style={{ boxShadow: `0 0 0 ${1.5 * inverseZoom}px rgb(14 165 233)` }}
      />
      {props.selected && element.type !== "drawing" && (
        <div
          className="absolute -right-1.5 -bottom-1.5 cursor-nwse-resize rounded-sm border-2 border-sky-500 bg-white"
          style={{ width: 10 * inverseZoom, height: 10 * inverseZoom, borderWidth: 1.5 * inverseZoom }}
          onPointerDown={(pointerEvent) => props.onResizePointerDown(pointerEvent, element)}
        />
      )}
    </div>
  );
}
