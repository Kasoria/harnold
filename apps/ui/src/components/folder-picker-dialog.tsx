import { useEffect, useState } from "react";
import { ChevronUp, Folder, Home, Loader2 } from "lucide-react";
import { api } from "@/api";
import type { FolderBrowseResult } from "@/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { t } from "@/lib/i18n";

type PendingPick = { title: string; resolve: (folderPath: string | null) => void };

let showPicker: ((pendingPick: PendingPick) => void) | null = null;

/** Lets the user browse the server's folders and choose one; resolves null on cancel. Needs <FolderPickerDialogHost /> mounted once. */
export function browseForFolder(title: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (!showPicker) return resolve(null);
    showPicker({ title, resolve });
  });
}

export const folderPickerAvailable = () => showPicker !== null;

export function FolderPickerDialogHost() {
  const [pendingPick, setPendingPick] = useState<PendingPick | null>(null);
  const [listing, setListing] = useState<FolderBrowseResult | null>(null);
  const [pathInput, setPathInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const open = (folderPath?: string) => {
    setLoading(true);
    setLoadError(null);
    api
      .browseFolders(folderPath)
      .then((result) => {
        setListing(result);
        setPathInput(result.path);
      })
      .catch((browseError) => setLoadError(browseError instanceof Error ? browseError.message : String(browseError)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    showPicker = (nextPick) => {
      setPendingPick((previous) => {
        previous?.resolve(null);
        return nextPick;
      });
      setListing(null);
      open();
    };
    return () => {
      showPicker = null;
    };
  }, []);

  const finish = (folderPath: string | null) => {
    pendingPick?.resolve(folderPath);
    setPendingPick(null);
  };

  return (
    <Dialog open={Boolean(pendingPick)} onOpenChange={(isOpen) => !isOpen && finish(null)}>
      <DialogContent className="sm:max-w-lg" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="text-[15px]">{pendingPick?.title}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          {listing && listing.shortcuts.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {listing.shortcuts.map((shortcut) => (
                <Button key={shortcut.path} size="sm" variant="outline" className="h-6 gap-1 px-2 text-[12px]" onClick={() => open(shortcut.path)}>
                  {shortcut.label === t("Home") && <Home className="size-3" />}
                  {shortcut.label}
                </Button>
              ))}
            </div>
          )}
          <form
            className="flex gap-1.5"
            onSubmit={(submitEvent) => {
              submitEvent.preventDefault();
              open(pathInput);
            }}
          >
            <Input value={pathInput} className="h-8 font-mono text-[12px]" onChange={(changeEvent) => setPathInput(changeEvent.target.value)} aria-label={t("Pfad")} />
            <Button type="submit" size="sm" variant="outline" className="h-8">
              {t("Öffnen")}
            </Button>
          </form>
          <div className="h-72 overflow-y-auto rounded-md border">
            {loading && !listing ? (
              <div className="flex h-full items-center justify-center text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
              </div>
            ) : (
              <ul className="p-1">
                {listing?.parent && (
                  <li>
                    <button type="button" className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[13px] text-muted-foreground hover:bg-foreground/5" onClick={() => open(listing.parent!)}>
                      <ChevronUp className="size-3.5" /> {t("Eine Ebene höher")}
                    </button>
                  </li>
                )}
                {listing?.folders.map((folder) => (
                  <li key={folder.path}>
                    <button type="button" className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[13px] hover:bg-foreground/5" onClick={() => open(folder.path)}>
                      <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{folder.name}</span>
                    </button>
                  </li>
                ))}
                {listing && !listing.folders.length && <li className="px-2 py-3 text-[12px] text-muted-foreground">{t("Keine Unterordner")}</li>}
                {loadError && <li className="px-2 py-3 text-[12px] text-destructive">{loadError}</li>}
              </ul>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button disabled={!listing} onClick={() => listing && finish(listing.path)}>
            {t("Diesen Ordner wählen")}
          </Button>
          <Button type="button" variant="ghost" onClick={() => finish(null)}>
            {t("Abbrechen")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
