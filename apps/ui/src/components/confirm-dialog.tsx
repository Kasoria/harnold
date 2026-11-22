import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";

export type ConfirmOptions = {
  title: string;
  /** What exactly is lost – only when the title does not say it. */
  description?: string;
  confirmLabel?: string;
  /** Defaults to true: red confirm button. */
  destructive?: boolean;
  /** Optional extra step as a checkbox – always unchecked by default (opt-in). */
  option?: { label: string; hint?: string };
};

export type ConfirmResult = { confirmed: boolean; optionChecked: boolean };
type PendingConfirmation = ConfirmOptions & { resolve: (result: ConfirmResult) => void };

let showConfirmation: ((pendingConfirmation: PendingConfirmation) => void) | null = null;

/** Asks before a destructive action; resolves true on confirm. Needs <ConfirmDialogHost /> mounted once. */
export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  return confirmWithOption(options).then((result) => result.confirmed);
}

/** Like confirmAction, plus whether the optional checkbox was ticked. */
export function confirmWithOption(options: ConfirmOptions): Promise<ConfirmResult> {
  return new Promise((resolve) => {
    if (!showConfirmation) return resolve({ confirmed: window.confirm(options.title), optionChecked: false });
    showConfirmation({ ...options, resolve });
  });
}

export function ConfirmDialogHost() {
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | null>(null);

  useEffect(() => {
    showConfirmation = (nextConfirmation) =>
      setPendingConfirmation((previous) => {
        previous?.resolve({ confirmed: false, optionChecked: false });
        return nextConfirmation;
      });
    return () => {
      showConfirmation = null;
    };
  }, []);

  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const [optionChecked, setOptionChecked] = useState(false);
  useEffect(() => setOptionChecked(false), [pendingConfirmation]);

  const answer = (confirmed: boolean) => {
    pendingConfirmation?.resolve({ confirmed, optionChecked: confirmed && optionChecked });
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
        {pendingConfirmation?.option && (
          <label className="flex cursor-default items-start gap-2.5 rounded-lg border px-3 py-2.5 text-[13px]">
            <input type="checkbox" className="mt-0.5 size-3.5" checked={optionChecked} onChange={(changeEvent) => setOptionChecked(changeEvent.target.checked)} />
            <span>
              {pendingConfirmation.option.label}
              {pendingConfirmation.option.hint && <span className="mt-0.5 block text-[12px] text-muted-foreground">{pendingConfirmation.option.hint}</span>}
            </span>
          </label>
        )}
        <DialogFooter
          onKeyDown={(keyboardEvent) => {
            if (keyboardEvent.key !== "ArrowLeft" && keyboardEvent.key !== "ArrowRight") return;
            const footerButtons = [...keyboardEvent.currentTarget.querySelectorAll("button")];
            const nextButton = footerButtons[(footerButtons.indexOf(document.activeElement as HTMLButtonElement) + 1) % footerButtons.length];
            nextButton?.focus();
            keyboardEvent.preventDefault();
          }}
        >
          <Button ref={confirmButtonRef} variant={pendingConfirmation?.destructive === false ? "default" : "destructive"} onClick={() => answer(true)}>
            {pendingConfirmation?.confirmLabel ?? t("Löschen")}
          </Button>
          <Button variant="ghost" onClick={() => answer(false)}>
            {t("Abbrechen")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
