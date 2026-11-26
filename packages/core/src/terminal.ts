import fs from "node:fs";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import type { IPty } from "node-pty";
import { environmentStore } from "./environments.ts";
import { t } from "./i18n.ts";

/**
 * Terminals in the project folder (Workspace → Terminal). They live in the Core, not in the browser:
 * closing the tab or losing the connection keeps them running, reconnecting replays the recent output.
 * Same environment as the agent (accounts, git identity).
 */

export type TerminalInfo = { id: string; projectId: string; title: string; createdAt: number; exited: boolean };

type TerminalSession = TerminalInfo & {
  pty: IPty;
  /** Recent output for reconnects, trimmed to scrollbackLimit characters. */
  scrollback: string;
  listeners: Set<(message: TerminalServerMessage) => void>;
};

export type TerminalServerMessage = { type: "output"; data: string } | { type: "exit"; exitCode: number };
export type TerminalClientMessage = { type: "input"; data: string } | { type: "resize"; cols: number; rows: number };

const scrollbackLimit = 256 * 1024;
const maxTerminalsPerProject = 8;
const terminalsById = new Map<string, TerminalSession>();

/** Loaded on first use: a missing native build must not take the Core down. */
let ptyModule: typeof import("node-pty") | null | undefined;
function loadPty(): typeof import("node-pty") | null {
  if (ptyModule === undefined) {
    try {
      const requireFromCore = createRequire(import.meta.url);
      ensureSpawnHelperExecutable(path.dirname(requireFromCore.resolve("node-pty/package.json")));
      ptyModule = requireFromCore("node-pty") as typeof import("node-pty");
    } catch (loadError) {
      console.error("[terminal] node-pty nicht verfügbar:", loadError instanceof Error ? loadError.message : loadError);
      ptyModule = null;
    }
  }
  return ptyModule;
}

/** node-pty's macOS prebuilds ship spawn-helper without the executable bit ("posix_spawnp failed"). */
function ensureSpawnHelperExecutable(packageDirectory: string) {
  for (const helperPath of [path.join(packageDirectory, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"), path.join(packageDirectory, "build/Release/spawn-helper")]) {
    try {
      if (fs.existsSync(helperPath) && !(fs.statSync(helperPath).mode & 0o111)) fs.chmodSync(helperPath, 0o755);
    } catch {
      // read-only bundle: prepared at build time
    }
  }
}

function defaultShell(): string {
  if (process.platform === "win32") return process.env.COMSPEC ?? "powershell.exe";
  const candidates = [process.env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"].filter((shellPath): shellPath is string => Boolean(shellPath));
  return candidates.find((shellPath) => fs.existsSync(shellPath)) ?? "/bin/sh";
}

function publicInfo(session: TerminalSession): TerminalInfo {
  return { id: session.id, projectId: session.projectId, title: session.title, createdAt: session.createdAt, exited: session.exited };
}

export function listTerminals(projectId: string): TerminalInfo[] {
  return [...terminalsById.values()].filter((session) => session.projectId === projectId).map(publicInfo);
}

export function createTerminal(project: { id: string; path: string }, size: { cols: number; rows: number }): TerminalInfo {
  const pty = loadPty();
  if (!pty) throw new Error(t("Das Terminal ist auf diesem Rechner nicht verfügbar (node-pty fehlt)."));
  const projectTerminals = listTerminals(project.id);
  if (projectTerminals.length >= maxTerminalsPerProject) throw new Error(t("Höchstens {0} Terminals je Projekt.", String(maxTerminalsPerProject)));
  const shellPath = defaultShell();
  const workingDirectory = fs.existsSync(project.path) ? project.path : os.homedir();
  const ptyProcess = pty.spawn(shellPath, process.platform === "win32" ? [] : ["-l"], {
    name: "xterm-256color",
    cols: Math.max(2, Math.floor(size.cols)),
    rows: Math.max(2, Math.floor(size.rows)),
    cwd: workingDirectory,
    env: {
      ...process.env,
      ...environmentStore.variablesForProject(project.id),
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      TERM_PROGRAM: "Harnold",
      // The Core's own settings are not meant for programs started in the terminal.
      HARNOLD_TOKEN: "",
      HARNOLD_EXIT_WITH_PARENT: "",
    } as Record<string, string>,
  });
  const session: TerminalSession = {
    id: randomUUID(),
    projectId: project.id,
    title: shellPath.split("/").pop() ?? "shell",
    createdAt: Date.now(),
    exited: false,
    pty: ptyProcess,
    scrollback: "",
    listeners: new Set(),
  };
  ptyProcess.onData((data) => {
    session.scrollback = (session.scrollback + data).slice(-scrollbackLimit);
    for (const listener of session.listeners) listener({ type: "output", data });
  });
  ptyProcess.onExit(({ exitCode }) => {
    session.exited = true;
    for (const listener of session.listeners) listener({ type: "exit", exitCode });
  });
  terminalsById.set(session.id, session);
  return publicInfo(session);
}

/** Connects a client: replays the scrollback, then streams. Returns the input handler and a detach function. */
export function attachTerminal(terminalId: string, send: (message: TerminalServerMessage) => void) {
  const session = terminalsById.get(terminalId);
  if (!session) return null;
  if (session.scrollback) send({ type: "output", data: session.scrollback });
  if (session.exited) send({ type: "exit", exitCode: 0 });
  session.listeners.add(send);
  return {
    receive(message: TerminalClientMessage) {
      if (session.exited) return;
      if (message.type === "input") session.pty.write(message.data);
      else if (message.type === "resize" && message.cols > 1 && message.rows > 1) session.pty.resize(Math.floor(message.cols), Math.floor(message.rows));
    },
    detach() {
      session.listeners.delete(send);
    },
  };
}

export function closeTerminal(terminalId: string): boolean {
  const session = terminalsById.get(terminalId);
  if (!session) return false;
  if (!session.exited) {
    try {
      session.pty.kill();
    } catch {
      // already gone
    }
  }
  terminalsById.delete(terminalId);
  return true;
}

/** Project deleted: its terminals end with it. */
export function closeProjectTerminals(projectId: string) {
  for (const session of [...terminalsById.values()]) if (session.projectId === projectId) closeTerminal(session.id);
}

export function terminalAvailable(): boolean {
  return loadPty() !== null;
}
