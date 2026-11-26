import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, SquareTerminal, X } from "lucide-react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { api, terminalSocketUrl } from "@/api";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import type { Project, TerminalInfo } from "@/types";

const terminalThemes: Record<"light" | "dark", ITheme> = {
  light: {
    background: "#ffffff",
    foreground: "#1f2328",
    cursor: "#1f2328",
    selectionBackground: "#0f4bf733",
    black: "#24292f", red: "#cf222e", green: "#116329", yellow: "#4d2d00", blue: "#0969da", magenta: "#8250df", cyan: "#1b7c83", white: "#6e7781",
    brightBlack: "#57606a", brightRed: "#a40e26", brightGreen: "#1a7f37", brightYellow: "#633c01", brightBlue: "#218bff", brightMagenta: "#a475f9", brightCyan: "#3192aa", brightWhite: "#8c959f",
  },
  dark: {
    background: "#161618",
    foreground: "#e6e6e6",
    cursor: "#e6e6e6",
    selectionBackground: "#5b8cff44",
    black: "#484f58", red: "#ff7b72", green: "#3fb950", yellow: "#d29922", blue: "#58a6ff", magenta: "#bc8cff", cyan: "#39c5cf", white: "#b1bac4",
    brightBlack: "#6e7681", brightRed: "#ffa198", brightGreen: "#56d364", brightYellow: "#e3b341", brightBlue: "#79c0ff", brightMagenta: "#d2a8ff", brightCyan: "#56d4dd", brightWhite: "#f0f6fc",
  },
};

type ServerMessage = { type: "output"; data: string } | { type: "exit"; exitCode: number };

/** One xterm bound to a terminal in the Core; reconnects on its own and gets the recent output replayed. */
function TerminalScreen(props: { terminalId: string; theme: "light" | "dark"; active: boolean; onExited: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const onExitedRef = useRef(props.onExited);
  onExitedRef.current = props.onExited;

  const sendSize = useCallback(() => {
    const terminal = terminalRef.current;
    const socket = socketRef.current;
    if (terminal && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
  }, []);

  useEffect(() => {
    const terminal = new Terminal({
      fontFamily: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 12.5,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: false,
      theme: terminalThemes[props.theme],
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new WebLinksAddon((_mouseEvent, url) => window.open(url, "_blank", "noreferrer")));
    terminal.open(containerRef.current!);
    terminalRef.current = terminal;
    fitRef.current = fitAddon;
    try {
      fitAddon.fit();
    } catch {
      // not laid out yet
    }

    let disposed = false;
    let reconnectTimer: number | undefined;
    const connect = () => {
      const socket = new WebSocket(terminalSocketUrl(props.terminalId));
      socketRef.current = socket;
      socket.onopen = () => {
        terminal.reset(); // the Core replays the scrollback
        sendSize();
      };
      socket.onmessage = (messageEvent) => {
        const message = JSON.parse(String(messageEvent.data)) as ServerMessage;
        if (message.type === "output") terminal.write(message.data);
        else {
          terminal.write(`\r\n\x1b[2m${t("[Prozess beendet]")}\x1b[0m\r\n`);
          onExitedRef.current();
        }
      };
      socket.onclose = (closeEvent) => {
        if (disposed || closeEvent.code === 4404) return;
        reconnectTimer = window.setTimeout(connect, 1500);
      };
    };
    connect();
    const inputSubscription = terminal.onData((data) => {
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "input", data }));
    });
    const resizeSubscription = terminal.onResize(sendSize);
    const resizeObserver = new ResizeObserver(() => {
      if (!containerRef.current?.offsetWidth) return;
      try {
        fitAddon.fit();
      } catch {
        // hidden
      }
    });
    resizeObserver.observe(containerRef.current!);
    return () => {
      disposed = true;
      window.clearTimeout(reconnectTimer);
      resizeObserver.disconnect();
      inputSubscription.dispose();
      resizeSubscription.dispose();
      socketRef.current?.close();
      terminal.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.terminalId]);

  useEffect(() => {
    if (terminalRef.current) terminalRef.current.options.theme = terminalThemes[props.theme];
  }, [props.theme]);

  useEffect(() => {
    if (!props.active) return;
    try {
      fitRef.current?.fit();
    } catch {
      // hidden
    }
    terminalRef.current?.focus();
  }, [props.active]);

  return <div ref={containerRef} className={cn("absolute inset-0 px-2 pt-1", !props.active && "invisible")} style={{ background: terminalThemes[props.theme].background }} />;
}

/** Terminal panel below the workspace: tabs of shells in the project folder that keep running in the Core. */
export function TerminalPanel(props: { project: Project; /** Folder new shells start in (where the code lives). */ startRoot: string; theme: "light" | "dark"; onClose: () => void }) {
  const { project, startRoot } = props;
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const creatingRef = useRef(false);

  const createTerminal = useCallback(async () => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    try {
      const createdTerminal = await api.createTerminal(project.id, { cols: 100, rows: 24, root: startRoot });
      setTerminals((previous) => [...previous, createdTerminal]);
      setActiveTerminalId(createdTerminal.id);
    } catch (createError) {
      toast.error(createError instanceof Error ? createError.message : String(createError));
    } finally {
      creatingRef.current = false;
    }
  }, [project.id, startRoot]);

  // Running terminals of the project come back; without one, a new one opens.
  useEffect(() => {
    let cancelled = false;
    api
      .listTerminals(project.id)
      .then(({ available, terminals: runningTerminals }) => {
        if (cancelled) return;
        setUnavailable(!available);
        setTerminals(runningTerminals);
        setActiveTerminalId(runningTerminals.at(-1)?.id ?? null);
        if (available && !runningTerminals.length) void createTerminal();
      })
      .catch((listError) => toast.error(String(listError instanceof Error ? listError.message : listError)));
    return () => {
      cancelled = true;
    };
    // Only when the panel opens; a later change of the start folder applies to new shells.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  const closeTerminal = (terminalId: string) => {
    void api.closeTerminal(terminalId).catch(() => undefined);
    const remainingTerminals = terminals.filter((terminal) => terminal.id !== terminalId);
    setTerminals(remainingTerminals);
    if (activeTerminalId === terminalId) setActiveTerminalId(remainingTerminals.at(-1)?.id ?? null);
    if (!remainingTerminals.length) props.onClose();
  };

  return (
    <section className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex h-8 shrink-0 items-center gap-0.5 border-b px-1.5">
        <SquareTerminal className="mx-1 size-3.5 text-muted-foreground" />
        <div className="flex min-w-0 items-center gap-0.5 overflow-x-auto">
          {terminals.map((terminal, terminalIndex) => (
            <div
              key={terminal.id}
              className={cn(
                "group flex h-6 shrink-0 items-center gap-1 rounded-md pr-0.5 pl-2 text-[12px]",
                terminal.id === activeTerminalId ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60",
              )}
            >
              <button type="button" onClick={() => setActiveTerminalId(terminal.id)} className={cn(terminal.exited && "line-through opacity-70")} title={terminal.workingDirectory}>
                {terminal.title} {terminals.length > 1 ? terminalIndex + 1 : ""}
              </button>
              <button type="button" className="rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-background" title={t("Terminal schließen")} aria-label={t("Terminal schließen")} onClick={() => closeTerminal(terminal.id)}>
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
        <button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" title={t("Neues Terminal")} aria-label={t("Neues Terminal")} disabled={unavailable} onClick={() => void createTerminal()}>
          <Plus className="size-3.5" />
        </button>
        <button type="button" className="ml-auto rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" title={t("Panel ausblenden (Terminals laufen weiter)")} aria-label={t("Panel ausblenden (Terminals laufen weiter)")} onClick={props.onClose}>
          <X className="size-3.5" />
        </button>
      </header>
      <div className="relative min-h-0 flex-1">
        {unavailable ? (
          <p className="p-4 text-[13px] text-muted-foreground">{t("Das Terminal ist auf diesem Rechner nicht verfügbar (node-pty fehlt).")}</p>
        ) : (
          terminals.map((terminal) => (
            <TerminalScreen
              key={terminal.id}
              terminalId={terminal.id}
              theme={props.theme}
              active={terminal.id === activeTerminalId}
              onExited={() => setTerminals((previous) => previous.map((candidate) => (candidate.id === terminal.id ? { ...candidate, exited: true } : candidate)))}
            />
          ))
        )}
      </div>
    </section>
  );
}
