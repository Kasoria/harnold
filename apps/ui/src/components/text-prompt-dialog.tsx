import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type TextPromptOptions = { title: string; initialValue?: string; placeholder?: string; confirmLabel?: string };
type PendingPrompt = TextPromptOptions & { resolve: (value: string | null) => void };

let showPrompt: ((pendingPrompt: PendingPrompt) => void) | null = null;

/** Asks for one line of text (e.g. a new name); resolves null on cancel. Needs <TextPromptDialogHost /> mounted once. */
export function askForText(options: TextPromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    if (!showPrompt) return resolve(window.prompt(options.title, options.initialValue ?? ""));
    showPrompt({ ...options, resolve });
  });
}

export function TextPromptDialogHost() {
  const [pendingPrompt, setPendingPrompt] = useState<PendingPrompt | null>(null);
  const [value, setValue] = useState("");

  useEffect(() => {
    showPrompt = (nextPrompt) =>
      setPendingPrompt((previous) => {
        previous?.resolve(null);
        setValue(nextPrompt.initialValue ?? "");
        return nextPrompt;
      });
    return () => {
      showPrompt = null;
    };
  }, []);

  const answer = (submitted: boolean) => {
    pendingPrompt?.resolve(submitted && value.trim() ? value.trim() : null);
    setPendingPrompt(null);
  };

  return (
    <Dialog open={Boolean(pendingPrompt)} onOpenChange={(open) => !open && answer(false)}>
      <DialogContent className="sm:max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="text-[15px]">{pendingPrompt?.title}</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(submitEvent) => {
            submitEvent.preventDefault();
            answer(true);
          }}
        >
          <Input autoFocus value={value} placeholder={pendingPrompt?.placeholder} onFocus={(focusEvent) => focusEvent.target.select()} onChange={(changeEvent) => setValue(changeEvent.target.value)} />
          <DialogFooter>
            <Button type="submit" disabled={!value.trim()}>
              {pendingPrompt?.confirmLabel ?? "Speichern"}
            </Button>
            <Button type="button" variant="ghost" onClick={() => answer(false)}>
              Abbrechen
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
