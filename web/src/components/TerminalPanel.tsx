import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { useStore } from "../state/store";
import { api, runTerminalCommand, type RunEvent, type ShellInfo } from "../api/client";
import { IconClose, IconTerminal } from "./icons";
import "@xterm/xterm/css/xterm.css";
import "./TerminalPanel.css";

/**
 * A dock for running commands in the repo, through the user's own shell.
 *
 * It is a command runner rather than a shell session: each command gets its own
 * shell, and the directory it ends in is carried into the next one. That's what
 * a terminal without a pseudo-terminal can honestly do — see server/terminal.ts
 * — so the prompt is a plain input rather than a pretence that the output pane
 * accepts keystrokes. What it can do, it does properly: output streams as it
 * arrives, colours survive, and a command can be stopped while it runs.
 */
export function TerminalPanel() {
  const open = useStore((s) => s.terminalOpen);
  const height = useStore((s) => s.terminalHeight);
  const toggle = useStore((s) => s.toggleTerminal);
  const setHeight = useStore((s) => s.setTerminalHeight);
  const repoRoot = useStore((s) => s.repo?.root ?? "");
  const refreshAll = useStore((s) => s.refreshAll);

  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const abort = useRef<AbortController | null>(null);

  /**
   * Once opened the dock stays in the DOM and hides with CSS. xterm holds the
   * element it was opened on, so unmounting the dock on close left the terminal
   * attached to a node that no longer existed: reopening rendered an empty pane
   * and every command's output went somewhere invisible. Keeping the node alive
   * also means the scrollback is still there when you come back.
   */
  const [mounted, setMounted] = useState(false);
  const [shells, setShells] = useState<ShellInfo[]>([]);
  const [shellId, setShellId] = useState("");
  const [cwd, setCwd] = useState("");
  const [command, setCommand] = useState("");
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [historyAt, setHistoryAt] = useState(-1);

  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);

  // Build xterm the first time the dock is opened, and keep it thereafter.
  useEffect(() => {
    if (!mounted || !host.current || term.current) return;
    const t = new Terminal({
      convertEol: true,
      cursorBlink: false,
      cursorStyle: "underline",
      disableStdin: true,
      // xterm measures the font itself on a canvas, where a `var(--font-mono)`
      // means nothing — handed one it silently falls back to Courier New. So
      // the token is resolved here and passed as the real stack.
      fontFamily: monoStack(),
      fontSize: 13,
      lineHeight: 1.25,
      letterSpacing: 0,
      fontWeightBold: "600",
      scrollback: 5000,
      theme: TERM_THEME,
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(host.current);
    f.fit();
    term.current = t;
    fit.current = f;
  }, [mounted]);

  useEffect(() => {
    return () => {
      abort.current?.abort();
      term.current?.dispose();
      term.current = null;
    };
  }, []);

  // Toasts land in the same corner the dock now covers; this is how they know
  // to sit above it.
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--term-h", open ? `${height}px` : "0px");
    return () => root.style.setProperty("--term-h", "0px");
  }, [open, height]);

  // The dock's size changes with the window and with the drag handle.
  useEffect(() => {
    if (!open) return;
    const refit = () => fit.current?.fit();
    refit();
    window.addEventListener("resize", refit);
    return () => window.removeEventListener("resize", refit);
  }, [open, height]);

  useEffect(() => {
    if (!open || shells.length > 0 || !repoRoot) return;
    api
      .terminalShells()
      .then((res) => {
        setShells(res.shells);
        setShellId((cur) => cur || res.shells[0]?.id || "");
        setCwd((cur) => cur || res.cwd);
      })
      .catch(() => {
        term.current?.writeln("\x1b[31mCouldn't find a shell to run commands with.\x1b[0m");
      });
  }, [open, shells.length, repoRoot]);

  // A repo switch moves the terminal with it, rather than leaving it pointed
  // at a directory belonging to another tab.
  useEffect(() => {
    if (repoRoot) setCwd(repoRoot);
  }, [repoRoot]);

  const write = useCallback((text: string) => term.current?.write(text), []);

  const stop = useCallback(() => abort.current?.abort(), []);

  const run = useCallback(async () => {
    const cmd = command.trim();
    if (!cmd || running) return;
    setHistory((h) => [cmd, ...h.filter((x) => x !== cmd)].slice(0, 100));
    setHistoryAt(-1);
    setCommand("");
    setRunning(true);

    write(`\x1b[38;5;110m${shortCwd(cwd, repoRoot)}\x1b[0m \x1b[38;5;108m$\x1b[0m ${cmd}\r\n`);

    const controller = new AbortController();
    abort.current = controller;
    let touchedRepo = false;
    try {
      await runTerminalCommand({ command: cmd, cwd, shell: shellId }, (e: RunEvent) => {
        if (e.t === "out" || e.t === "err") {
          write(e.d ?? "");
          return;
        }
        if (e.cwd) setCwd(e.cwd);
        if (e.killed) write("\r\n\x1b[33mStopped.\x1b[0m\r\n");
        else if (e.code) write(`\r\n\x1b[31mExited with ${e.code}.\x1b[0m\r\n`);
        else write("\r\n");
        touchedRepo = true;
      }, controller.signal);
    } catch (err) {
      if ((err as Error).name === "AbortError") write("\r\n\x1b[33mStopped.\x1b[0m\r\n");
      else write(`\r\n\x1b[31m${(err as Error).message}\x1b[0m\r\n`);
    } finally {
      abort.current = null;
      setRunning(false);
      // Almost anything worth typing here can move the repo underneath the app,
      // so re-read it rather than leaving a stale graph on screen.
      if (touchedRepo) refreshAll();
    }
  }, [command, running, cwd, shellId, repoRoot, write, refreshAll]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      run();
      return;
    }
    if (e.key === "ArrowUp" && history.length) {
      e.preventDefault();
      const next = Math.min(historyAt + 1, history.length - 1);
      setHistoryAt(next);
      setCommand(history[next]);
      return;
    }
    if (e.key === "ArrowDown" && historyAt >= 0) {
      e.preventDefault();
      const next = historyAt - 1;
      setHistoryAt(next);
      setCommand(next < 0 ? "" : history[next]);
      return;
    }
    // Ctrl+C with nothing selected is the usual way to ask a command to stop.
    if (e.key === "c" && e.ctrlKey && running && !window.getSelection()?.toString()) {
      e.preventDefault();
      stop();
    }
  };

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    const onMove = (m: MouseEvent) => setHeight(startH + (startY - m.clientY));
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const prompt = useMemo(() => shortCwd(cwd, repoRoot), [cwd, repoRoot]);

  if (!mounted) return null;

  return (
    <div className={"term-dock" + (open ? "" : " term-hidden")} style={{ height }} aria-hidden={!open}>
      <div className="term-resize" onMouseDown={startDrag} title="Drag to resize" />
      <div className="term-head">
        <IconTerminal width={14} height={14} className="term-head-icon" />
        <span className="term-head-label">Terminal</span>
        {shells.length > 1 && (
          <select
            className="term-shell"
            value={shellId}
            onChange={(e) => setShellId(e.target.value)}
            disabled={running}
            title="Shell to run commands with"
          >
            {shells.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        )}
        <span className="term-cwd" title={cwd}>
          {prompt}
        </span>
        <div className="spacer" />
        <button className="term-btn" onClick={() => term.current?.clear()} title="Clear output">
          Clear
        </button>
        <button className="icon-btn" onClick={toggle} title="Close terminal" aria-label="Close terminal">
          <IconClose />
        </button>
      </div>

      <div className="term-body" ref={host} />

      <div className="term-input-row">
        <span className="term-prompt" aria-hidden>
          $
        </span>
        <input
          className="term-input"
          value={command}
          placeholder={running ? "Running…" : "Type a command and press Enter"}
          aria-label="Command"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {running ? (
          <button className="term-btn danger" onClick={stop} title="Stop the running command">
            Stop
          </button>
        ) : (
          <button className="term-btn" onClick={run} disabled={!command.trim()}>
            Run
          </button>
        )}
      </div>
    </div>
  );
}

/** The app's own monospace stack, resolved to something xterm can measure. */
function monoStack(): string {
  const token = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim();
  return token || 'Consolas, "Liberation Mono", monospace';
}

/** Show the repo-relative directory, so the prompt stays short where it usually is. */
function shortCwd(cwd: string, root: string): string {
  if (!cwd) return "";
  const a = cwd.replace(/\\/g, "/").replace(/\/$/, "");
  const b = root.replace(/\\/g, "/").replace(/\/$/, "");
  if (!b) return a;
  if (a.toLowerCase() === b.toLowerCase()) return basename(b);
  if (a.toLowerCase().startsWith(b.toLowerCase() + "/")) {
    return basename(b) + a.slice(b.length);
  }
  return a;
}

function basename(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** Matched to the app's palette so the dock reads as part of the window. */
const TERM_THEME = {
  background: "#0c1218",
  foreground: "#d4dfeb",
  cursor: "#c9d4df",
  selectionBackground: "#16497e",
  black: "#0c1218",
  red: "#f85149",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#2f81f7",
  magenta: "#c678dd",
  cyan: "#22b2a6",
  white: "#c9d4df",
  brightBlack: "#61707e",
  brightRed: "#ff7b72",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#58a6ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#56d4dd",
  brightWhite: "#f0f6fc",
};
