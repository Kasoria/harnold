import { useSyncExternalStore } from "react";
import type { AgentBackendId, AgentBackendsView, BackendStatus } from "@/types";

// Which agent programs exist and what each can do – shared by every component that hides features a backend lacks.
let currentView: AgentBackendsView | null = null;
const listeners = new Set<() => void>();

export function setAgentBackendsView(view: AgentBackendsView | null): void {
  currentView = view;
  listeners.forEach((listener) => listener());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Backend a conversation runs on: the one it started with, else the active one. */
export function useSessionBackend(sessionBackendId: AgentBackendId | null | undefined): BackendStatus | null {
  const view = useSyncExternalStore(subscribe, () => currentView);
  if (!view) return null;
  const backendId = sessionBackendId ?? view.activeId;
  return view.backends.find((backend) => backend.id === backendId) ?? null;
}
