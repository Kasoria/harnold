import { useSyncExternalStore } from "react";

/** A file the agent is editing or edited (from its tool calls); root = project folder the path is relative to. */
export type FileActivity = { projectId: string; sessionId: string; root: string; path: string; phase: "editing" | "done" | "failed"; at: number };

const maximumEntries = 40;
let activities: FileActivity[] = [];
const listeners = new Set<() => void>();

/** Newest first, one entry per file (its latest state). */
export function recordFileActivity(activity: FileActivity): void {
  activities = [activity, ...activities.filter((entry) => entry.root !== activity.root || entry.path !== activity.path)].slice(0, maximumEntries);
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useFileActivity(): FileActivity[] {
  return useSyncExternalStore(subscribe, () => activities);
}

export const fileActivityKey = (root: string, filePath: string) => `${root}\u0000${filePath}`;
