/**
 * Small global feedback channel: every screen can report success/errors without prop drilling.
 * Rendered by <Toaster /> (App.tsx). Inline feedback (green check at the button) is preferred for saves;
 * toasts are for actions whose result is not visible right where they happened.
 */
export type ToastTone = "success" | "error" | "info";
export type ToastAction = { label: string; run: () => void };
export type ToastItem = { id: number; message: string; tone: ToastTone; action?: ToastAction };

const maxVisible = 3;
let nextId = 0;
let toasts: ToastItem[] = [];
const listeners = new Set<() => void>();

const publish = () => {
  for (const listener of listeners) listener();
};

export function subscribeToasts(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const toastList = () => toasts;

export function dismissToast(toastId: number) {
  toasts = toasts.filter((toastItem) => toastItem.id !== toastId);
  publish();
}

function show(message: string, tone: ToastTone, action?: ToastAction, durationMs = 4000) {
  const trimmedMessage = message.trim();
  if (!trimmedMessage) return;
  const toastItem: ToastItem = { id: ++nextId, message: trimmedMessage, tone, action };
  // The same message twice in a row is one toast, not two.
  toasts = [...toasts.filter((existing) => existing.message !== trimmedMessage), toastItem].slice(-maxVisible);
  publish();
  window.setTimeout(() => dismissToast(toastItem.id), durationMs);
}

const messageOf = (unknownError: unknown) => (unknownError instanceof Error ? unknownError.message : String(unknownError));

export const toast = {
  success: (message: string, action?: ToastAction) => show(message, "success", action),
  info: (message: string, action?: ToastAction) => show(message, "info", action, action ? 7000 : 4000),
  error: (unknownError: unknown) => show(messageOf(unknownError), "error", undefined, 7000),
  dismiss: dismissToast,
};
