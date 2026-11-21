import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...classValues: ClassValue[]) {
  return twMerge(clsx(classValues));
}

/**
 * Enter that should act (submit/commit) – false while an IME (Japanese, Chinese, …) is still composing.
 * keyCode 229 catches WebKit/Tauri, where `isComposing` is already reset on the confirming Enter.
 */
export function isActionEnter(keyboardEvent: { key: string; keyCode: number; nativeEvent: KeyboardEvent }) {
  return keyboardEvent.key === "Enter" && !keyboardEvent.nativeEvent.isComposing && keyboardEvent.keyCode !== 229;
}
