import { useEffect, useRef, useState } from "react";
import { ImagePlus, Loader2, Sparkles, X } from "lucide-react";
import { api } from "@/api";
import type { ImageAspectRatio, ImageSettingsView } from "@/types";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/segmented-control";

type ImageGenerationPanelProps = {
  projectId: string;
  /** Image currently selected on the canvas (offered as reference). */
  selectedImagePath: string | null;
  /** Canvas point where results should appear, computed at submit time. */
  anchorFor: (imageCount: number) => { x: number; y: number };
  onGenerated: () => void;
  onClose: () => void;
  onError: (unknownError: unknown) => void;
};

const aspectRatioOptions: { value: ImageAspectRatio; label: string }[] = [
  { value: "1:1", label: "1:1" },
  { value: "16:9", label: "16:9" },
  { value: "9:16", label: "9:16" },
  { value: "4:3", label: "4:3" },
  { value: "3:4", label: "3:4" },
];

const countOptions = ["1", "2", "3", "4"].map((countValue) => ({ value: countValue, label: countValue }));

export function ImageGenerationPanel(props: ImageGenerationPanelProps) {
  const [imageSettings, setImageSettings] = useState<ImageSettingsView | null>(null);
  const [prompt, setPrompt] = useState("");
  const [aspectRatio, setAspectRatio] = useState<ImageAspectRatio>("1:1");
  const [imageCount, setImageCount] = useState("1");
  const [referencePaths, setReferencePaths] = useState<string[]>([]);
  const [generating, setGenerating] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    api.readImageSettings().then(setImageSettings).catch(props.onError);
    textareaRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const canAddSelected = Boolean(props.selectedImagePath) && !referencePaths.includes(props.selectedImagePath!) && referencePaths.length < 4;

  const generate = async () => {
    if (!prompt.trim() || generating) return;
    setGenerating(true);
    try {
      const count = Number(imageCount);
      await api.generateImages(props.projectId, { prompt: prompt.trim(), referencePaths, aspectRatio, count, anchor: props.anchorFor(count) });
      props.onGenerated();
      setPrompt("");
      setReferencePaths([]);
    } catch (generateError) {
      props.onError(generateError);
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div
      className="absolute bottom-[68px] left-1/2 z-30 w-[min(440px,calc(100%-32px))] -translate-x-1/2 animate-in rounded-xl border bg-popover p-3 shadow-lg fade-in slide-in-from-bottom-2 duration-200"
      onPointerDown={(pointerEvent) => pointerEvent.stopPropagation()}
      onKeyDown={(keyboardEvent) => {
        if (keyboardEvent.key === "Escape") props.onClose();
        if (keyboardEvent.key === "Enter" && (keyboardEvent.metaKey || keyboardEvent.ctrlKey)) void generate();
      }}
    >
      <div className="mb-2 flex items-center gap-2">
        <Sparkles className="size-3.5 text-muted-foreground" />
        <span className="text-[13px] font-medium">Bild generieren</span>
        <Button variant="ghost" size="icon" className="ml-auto size-6 text-muted-foreground" onClick={props.onClose} aria-label="Schließen">
          <X className="size-3.5" />
        </Button>
      </div>

      {imageSettings && !imageSettings.ready ? (
        <p className="py-3 text-[12.5px] text-muted-foreground">Zuerst in Einstellungen → Bilder einen Anbieter und API-Key eintragen.</p>
      ) : (
        <>
          <textarea
            ref={textareaRef}
            rows={3}
            value={prompt}
            disabled={generating}
            placeholder="Was soll entstehen? Motiv, Stil, Licht, Stimmung …"
            onChange={(changeEvent) => setPrompt(changeEvent.target.value)}
            className="w-full resize-none rounded-lg border bg-background px-2.5 py-2 text-[13px] outline-none transition-shadow duration-150 placeholder:text-muted-foreground focus:ring-1 focus:ring-ring/40"
          />

          {(referencePaths.length > 0 || canAddSelected) && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {referencePaths.map((referencePath) => (
                <span key={referencePath} className="inline-flex animate-in items-center gap-1.5 rounded-md border bg-background py-0.5 pr-1 pl-0.5 fade-in duration-150">
                  <img src={api.previewUrl(props.projectId, referencePath)} alt="" className="size-6 rounded object-cover" />
                  <span className="max-w-32 truncate font-mono text-[11px]">{referencePath.split("/").pop()}</span>
                  <button
                    className="rounded text-muted-foreground transition-colors hover:text-foreground"
                    onClick={() => setReferencePaths((previous) => previous.filter((path) => path !== referencePath))}
                    aria-label="Vorlage entfernen"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
              {canAddSelected && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-1.5 px-2 text-[12px] text-muted-foreground"
                  onClick={() => setReferencePaths((previous) => [...previous, props.selectedImagePath!])}
                >
                  <ImagePlus className="size-3.5" /> Auswahl als Vorlage
                </Button>
              )}
            </div>
          )}

          <div className="mt-2.5 flex items-center gap-2">
            <SegmentedControl className="w-56" options={aspectRatioOptions} value={aspectRatio} onValueChange={setAspectRatio} />
            <SegmentedControl className="w-28" options={countOptions} value={imageCount} onValueChange={setImageCount} />
            <Button size="sm" className="ml-auto gap-1.5" disabled={!prompt.trim() || generating} onClick={() => void generate()}>
              {generating ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
              {generating ? "Erzeuge …" : "Erzeugen"}
            </Button>
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">⌘↵ erzeugen</p>
        </>
      )}
    </div>
  );
}
