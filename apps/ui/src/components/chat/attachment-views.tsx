import { useState } from "react";
import { ExternalLink, FileSpreadsheet, FileText, File as FileIcon, Loader2, X } from "lucide-react";
import { api } from "@/api";
import type { Attachment } from "@/types";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

const imagePathPattern = /\.(png|jpe?g|gif|webp|avif|svg)$/i;
export const isImagePath = (filePath: string) => imagePathPattern.test(filePath);

/** Project-relative image paths mentioned in a text (e.g. `assets/generated/katze.jpg`). */
export function imagePathsIn(text: string): string[] {
  const candidates = text.match(/[\w./@-]+\.(?:png|jpe?g|gif|webp|avif)\b/gi) ?? [];
  return [...new Set(candidates.map((candidate) => candidate.replace(/^\.\//, "")).filter((candidate) => !/^(https?:|\/)/.test(candidate) && candidate.includes("/")))];
}

function fileIconFor(mimeType: string, fileName: string) {
  if (mimeType === "application/pdf" || /\.(pdf|docx?|txt|md|rtf)$/i.test(fileName)) return FileText;
  if (/sheet|excel|csv/.test(mimeType) || /\.(xlsx?|csv|tsv)$/i.test(fileName)) return FileSpreadsheet;
  return FileIcon;
}

function formatFileSize(byteCount: number) {
  return byteCount < 1024 * 1024 ? `${Math.max(1, Math.round(byteCount / 1024))} KB` : `${(byteCount / 1024 / 1024).toFixed(1)} MB`;
}

/** Thumbnails; a click opens the image large (lightbox). Broken paths (file not there) hide themselves. */
export function ImageGallery({ projectId, imagePaths, className }: { projectId: string; imagePaths: string[]; className?: string }) {
  const [openedPath, setOpenedPath] = useState<string | null>(null);
  const [missingPaths, setMissingPaths] = useState<Set<string>>(new Set());
  const visiblePaths = imagePaths.filter((imagePath) => !missingPaths.has(imagePath));
  if (!visiblePaths.length) return null;
  return (
    <>
      <div className={cn("flex flex-wrap gap-2", className)}>
        {visiblePaths.map((imagePath) => (
          <button
            key={imagePath}
            type="button"
            title={imagePath}
            onClick={() => setOpenedPath(imagePath)}
            className="overflow-hidden rounded-lg border bg-muted transition-opacity duration-150 hover:opacity-90"
          >
            <img
              src={api.previewUrl(projectId, imagePath)}
              alt={imagePath.split("/").pop()}
              loading="lazy"
              className="max-h-64 max-w-full object-contain"
              onError={() => setMissingPaths((previous) => new Set(previous).add(imagePath))}
            />
          </button>
        ))}
      </div>
      <Dialog open={openedPath !== null} onOpenChange={(open) => !open && setOpenedPath(null)}>
        <DialogContent className="max-w-[min(92vw,1200px)] gap-2 p-3 sm:max-w-[min(92vw,1200px)]">
          <DialogTitle className="flex items-center gap-2 pr-8 font-mono text-[12px] font-normal text-muted-foreground">
            <span className="truncate">{openedPath}</span>
            {openedPath && (
              <a href={api.previewUrl(projectId, openedPath)} target="_blank" rel="noreferrer" className="shrink-0 hover:text-foreground" aria-label="In neuem Tab öffnen">
                <ExternalLink className="size-3.5" />
              </a>
            )}
          </DialogTitle>
          {openedPath && <img src={api.previewUrl(projectId, openedPath)} alt={openedPath} className="max-h-[80vh] w-full rounded-md object-contain" />}
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Attached files of a sent message: images as thumbnails, everything else as a chip that opens the file. */
export function SentAttachments({ projectId, attachments }: { projectId: string; attachments: Attachment[] }) {
  const imageAttachments = attachments.filter((attachment) => attachment.mimeType.startsWith("image/"));
  const otherAttachments = attachments.filter((attachment) => !attachment.mimeType.startsWith("image/"));
  return (
    <div className="flex flex-col items-end gap-1.5">
      {imageAttachments.length > 0 && <ImageGallery projectId={projectId} imagePaths={imageAttachments.map((attachment) => attachment.path)} className="justify-end" />}
      {otherAttachments.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1.5">
          {otherAttachments.map((attachment) => (
            <a key={attachment.path} href={api.previewUrl(projectId, attachment.path)} target="_blank" rel="noreferrer">
              <AttachmentChip name={attachment.name} mimeType={attachment.mimeType} size={attachment.size} />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

export function AttachmentChip(props: { name: string; mimeType: string; size?: number; previewUrl?: string; uploading?: boolean; failed?: boolean; onRemove?: () => void }) {
  const TypeIcon = fileIconFor(props.mimeType, props.name);
  return (
    <span
      className={cn(
        "group/chip relative flex h-10 max-w-56 items-center gap-2 rounded-lg border bg-background pr-2.5 pl-1.5 text-[12px] transition-colors duration-150 hover:bg-foreground/[0.03]",
        props.failed && "border-destructive/50 text-destructive",
      )}
    >
      {props.previewUrl ? (
        <img src={props.previewUrl} alt="" className="size-7 shrink-0 rounded object-cover" />
      ) : (
        <span className="flex size-7 shrink-0 items-center justify-center rounded bg-muted">
          {props.uploading ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : <TypeIcon className="size-3.5 text-muted-foreground" />}
        </span>
      )}
      <span className="min-w-0">
        <span className="block truncate font-medium">{props.name}</span>
        <span className="block text-[10.5px] text-muted-foreground">{props.failed ? "Fehlgeschlagen" : props.uploading ? "Lädt hoch …" : props.size ? formatFileSize(props.size) : ""}</span>
      </span>
      {props.onRemove && (
        <button
          type="button"
          aria-label={`${props.name} entfernen`}
          onClick={props.onRemove}
          className="absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center rounded-full bg-foreground text-background opacity-0 transition-opacity duration-150 group-hover/chip:opacity-100 focus-visible:opacity-100"
        >
          <X className="size-2.5" />
        </button>
      )}
    </span>
  );
}
