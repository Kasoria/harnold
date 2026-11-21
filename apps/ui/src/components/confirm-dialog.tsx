import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export type ConfirmOptions = {
  title: string;
  /** What exactly is lost – only when the title does not say it. */
  description?: string;
  confirmLabel?: string;
  /** Defaults to true: red confirm button. */
  destructive?: boolean;
};

type PendingConfirmation = ConfirmOptions & { resolve: (confirmed: boolean) => void };

let showConfirmation: ((pendingConfirmation: PendingConfirmation) => void) | null = null;

/** Asks before a destructive action; resolves true on confirm. Needs <ConfirmDialogHost /> mounted once. */
export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    if (!showConfirmation) return resolve(window.confirm(options.title));
    showConfirmation({ ...options, resolve });
  });
}

export function ConfirmDialogHost() {
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | null>(null);

  useEffect(() => {
    showConfirmation = (nextConfirmation) =>
      setPendingConfirmation((previous) => {
        previous?.resolve(false);
        return nextConfirmation;
      });
    return () => {
      showConfirmation = null;
    };
  }, []);

  const confirmButtonRef = useRef<HTMLButtonElement>(null);

  const answer = (confirmed: boolean) => {
    pendingConfirmation?.resolve(confirmed);
    setPendingConfirmation(null);
  };

  return (
    <Dialog open={Boolean(pendingConfirmation)} onOpenChange={(open) => !open && answer(false)}>
      <DialogContent
        className="sm:max-w-sm"
        showCloseButton={false}
        // Focus lands on the action: Enter confirms, Esc cancels, ←/→ switch between the two buttons.
        onOpenAutoFocus={(focusEvent) => {
          focusEvent.preventDefault();
          confirmButtonRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-[15px]">{pendingConfirmation?.title}</DialogTitle>
          {pendingConfirmation?.description && <DialogDescription>{pendingConfirmation.description}</DialogDescription>}
        </DialogHeader>
        <DialogFooter
          className="grid grid-cols-2 sm:grid sm:justify-stretch"
          onKeyDown={(keyboardEvent) => {
            if (keyboardEvent.key !== "ArrowLeft" && keyboardEvent.key !== "ArrowRight") return;
            const footerButtons = [...keyboardEvent.currentTarget.querySelectorAll("button")];
            const nextButton = footerButtons[(footerButtons.indexOf(document.activeElement as HTMLButtonElement) + 1) % footerButtons.length];
            nextButton?.focus();
            keyboardEvent.preventDefault();
          }}
        >
          <Button ref={confirmButtonRef} variant={pendingConfirmation?.destructive === false ? "default" : "destructive"} onClick={() => answer(true)}>
            {pendingConfirmation?.confirmLabel ?? "Löschen"}
          </Button>
          <Button variant="outline" onClick={() => answer(false)}>
            Abbrechen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
