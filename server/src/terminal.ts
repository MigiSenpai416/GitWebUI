import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

/**
 * The terminal panel's back end: run one command at a time through the user's
 * own shell and stream what it prints.
 *
 * This is a command runner, not a terminal session. A real terminal needs a
 * pseudo-terminal, which neither Node nor Bun provides without a native addon —
 * and a native addon can't be cross-compiled, which is what lets `build:exe`
 * emit both the Windows and Linux binaries from one machine. So each command
 * gets a fresh shell, and the two things a session would otherwise carry —
 * where you are, and what the command exited with — are carried explicitly:
 * the shell reports its final directory and status, and the client sends the
 * directory back with the next command.
 *
 * The consequence is that programs which need a terminal to talk to you (vim,
 * less, an ssh password prompt) have nothing to talk to. Shells are started
 * non-interactively so those fail fast instead of hanging.
 */

export type ShellKind = "bash" | "zsh" | "sh" | "powershell" | "pwsh";

export interface ShellInfo {
  /** Stable id the client sends back to pick this shell. */
  id: string;
  label: string;
  path: string;
  kind: ShellKind;
}

/** Windows: Git for Windows ships the bash the rest of this app already relies on. */
function gitBashCandidates(): string[] {
  const roots = [
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.ProgramW6432,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs") : undefined,
    "C:\\Program Files",
    "C:\\Program Files (x86)",
  ].filter((r): r is string => Boolean(r));
  return roots.map((root) => path.join(root, "Git", "bin", "bash.exe"));
}

/** The bash sitting next to the `git` on PATH, for non-standard install locations. */
function gitBashFromPath(): string | null {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    if (!/[\\/](Git)[\\/](cmd|bin|mingw64[\\/]bin)$/i.test(dir)) continue;
    // …/Git/cmd/git.exe and …/Git/bin/git.exe both sit one level under the root.
    const root = path.resolve(dir, /mingw64/i.test(dir) ? "../.." : "..");
    const bash = path.join(root, "bin", "bash.exe");
    if (existsSync(bash)) return bash;
  }
  return null;
}

function label(kind: ShellKind, file: string): string {
  switch (kind) {
    case "bash":
      return process.platform === "win32" ? "Git Bash" : "bash";
    case "zsh":
      return "zsh";
    case "powershell":
      return "PowerShell";
    case "pwsh":
      return "PowerShell 7";
    default:
      return file;
  }
}

function kindOf(file: string): ShellKind {
  const name = path.basename(file).toLowerCase().replace(/\.exe$/, "");
  if (name === "zsh") return "zsh";
  if (name === "bash") return "bash";
  if (name === "pwsh") return "pwsh";
  if (name === "powershell") return "powershell";
  return "sh";
}

function shell(file: string): ShellInfo {
  const kind = kindOf(file);
  return { id: kind, label: label(kind, path.basename(file)), path: file, kind };
}

/**
 * Shells this machine can offer, best first. On Windows that's Git Bash when
 * it's installed — it matches what the rest of the app shells out to — falling
 * back to PowerShell. Elsewhere it's the user's own $SHELL.
 */
export function detectShells(): ShellInfo[] {
  const found: ShellInfo[] = [];
  const add = (file: string | null | undefined) => {
    if (!file || !existsSync(file)) return;
    if (found.some((s) => s.path.toLowerCase() === file.toLowerCase())) return;
    found.push(shell(file));
  };

  if (process.platform === "win32") {
    add(gitBashFromPath());
    for (const c of gitBashCandidates()) add(c);
    const sysRoot = process.env.SystemRoot ?? "C:\\Windows";
    add(path.join(sysRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
    for (const root of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
      if (root) add(path.join(root, "PowerShell", "7", "pwsh.exe"));
    }
    return found;
  }

  add(process.env.SHELL);
  for (const c of ["/bin/zsh", "/bin/bash", "/usr/bin/bash", "/bin/sh"]) add(c);
  return found;
}

/** Resolve the shell a request asked for, else the best one available. */
export function pickShell(id: string | undefined, shells = detectShells()): ShellInfo {
  const chosen = id ? shells.find((s) => s.id === id) : undefined;
  if (chosen) return chosen;
  if (shells.length === 0) {
    const err = new Error("No usable shell was found on this machine") as Error & { status?: number };
    err.status = 500;
    throw err;
  }
  return shells[0];
}

/** Git Bash takes a Windows path happily, but only with forward slashes. */
function bashPath(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * The script wrapping the user's command. It moves to the working directory
 * first, then reports where it ended up — so `cd` sticks from one command to
 * the next even though each runs in its own shell. The report goes to a file
 * rather than the output stream, so nothing has to be filtered back out of
 * what the user actually ran.
 */
export function buildScript(kind: ShellKind, command: string): string {
  if (kind === "powershell" || kind === "pwsh") {
    return [
      "$ErrorActionPreference = 'Continue'",
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()",
      "$OutputEncoding = [System.Text.UTF8Encoding]::new()",
      "Set-Location -LiteralPath $env:GW_CWD",
      command,
      // $? has to be read on the very next line, before anything else can
      // overwrite it. A cmdlet reports failure there and leaves $LASTEXITCODE
      // untouched; a native program reports it the other way round, so both are
      // captured and $LASTEXITCODE wins when something actually set it.
      "$__gw_ok = $?",
      "$__gw_last = $LASTEXITCODE",
      "$__gw_code = if ($null -ne $__gw_last) { $__gw_last } elseif ($__gw_ok) { 0 } else { 1 }",
      "(Get-Location).Path | Out-File -FilePath $env:GW_OUT -Encoding utf8 -NoNewline",
      "exit $__gw_code",
    ].join("\n");
  }
  return [
    'cd "$GW_CWD" || exit 1',
    command,
    "__gw_code=$?",
    // `pwd -W` gives Git Bash's Windows-style path; it isn't a thing elsewhere.
    '{ pwd -W 2>/dev/null || pwd; } > "$GW_OUT"',
    "exit $__gw_code",
  ].join("\n");
}

function shellArgs(kind: ShellKind, script: string): string[] {
  if (kind === "powershell" || kind === "pwsh") {
    return ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script];
  }
  return [bashPath(script)];
}

/**
 * Environment for the command. Programs that check for a terminal will find
 * none, so the ones that can be told to keep their colours anyway are told to,
 * and the ones that would otherwise wait on a pager are pointed at `cat`.
 */
function commandEnv(cwd: string, out: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GW_CWD: cwd,
    GW_OUT: out,
    TERM: "xterm-256color",
    FORCE_COLOR: "1",
    CLICOLOR_FORCE: "1",
    PAGER: "cat",
    GIT_PAGER: "cat",
    // git only colours a tty unless told otherwise; this is git's own way in.
    GIT_CONFIG_PARAMETERS: "'color.ui=always'",
  };
}

export interface RunEvent {
  /** `out` for stdout, `err` for stderr, `exit` when it's over. */
  t: "out" | "err" | "exit";
  d?: string;
  code?: number | null;
  /** Where the shell ended up, so the next command can start there. */
  cwd?: string;
  /** Set when the command was cut short rather than ending on its own. */
  killed?: boolean;
}

export interface RunHandle {
  /** Resolves once the process has exited and the final event has been emitted. */
  done: Promise<void>;
  /** Stop the command; the stream ends with an exit event marked killed. */
  kill: () => void;
  /**
   * Stop the command without returning until the OS has been told to.
   *
   * Only for shutdown. `kill()` asks Windows to tear the tree down via a
   * `taskkill` it does not wait for, which is right when the process will still
   * be here a moment later — and wrong when it is exiting, because the caller
   * can be gone before `taskkill` has done anything, leaving the command
   * running with nobody left to stop it.
   */
  killSync: () => void;
}

/**
 * How long to keep reading after the process has exited. Normally both pipes
 * end within a tick and this never elapses, but a force-killed process tree on
 * Windows leaves its pipes hanging open — `exit` fires, `close` never does — and
 * without a deadline the command would look like it was still running forever.
 */
const DRAIN_GRACE_MS = 200;

/**
 * Run `command` and hand each chunk of its output to `onEvent` as it arrives.
 * Output is decoded incrementally so a multi-byte character split across two
 * reads isn't turned into replacement characters.
 */
/**
 * Every command currently running.
 *
 * A request that goes away takes its own command with it (`res.on("close")`),
 * which covers the ordinary case. What it doesn't cover is the server itself
 * going away: in the desktop app these are child processes of the process the
 * user just quit, and without this they would be left running with nothing
 * reading their output.
 */
const running = new Set<RunHandle>();

/**
 * Stop every command still running. Called when the host is shutting down, so
 * the kills are synchronous: the process may not be alive long enough to see an
 * asynchronous one through.
 */
export function killAllCommands(): void {
  for (const handle of running) handle.killSync();
  running.clear();
}

/** How many commands are in flight. Exposed for tests. */
export function runningCommandCount(): number {
  return running.size;
}

export function runCommand(
  opts: { command: string; cwd: string; shell: ShellInfo },
  onEvent: (e: RunEvent) => void,
): RunHandle {
  let child: ChildProcessWithoutNullStreams | null = null;
  let killed = false;
  let over = false;
  // Nothing follows the exit event, even if a pipe coughs up a last chunk after
  // the process is gone.
  const emit = (e: RunEvent) => {
    if (over) return;
    if (e.t === "exit") over = true;
    onEvent(e);
  };

  const done = (async () => {
    const dir = path.join(os.tmpdir(), `gitwebui-term-${randomBytes(6).toString("hex")}`);
    await fs.mkdir(dir, { recursive: true });
    const isPs = opts.shell.kind === "powershell" || opts.shell.kind === "pwsh";
    const scriptFile = path.join(dir, isPs ? "cmd.ps1" : "cmd.sh");
    const cwdFile = path.join(dir, "cwd.txt");
    // Windows PowerShell reads a .ps1 as the system codepage unless it starts
    // with a UTF-8 BOM, which would turn every non-ASCII character in the
    // command into mojibake before it ever ran.
    const bom = isPs ? "﻿" : "";
    await fs.writeFile(scriptFile, bom + buildScript(opts.shell.kind, opts.command), "utf8");

    try {
      const proc = spawn(opts.shell.path, shellArgs(opts.shell.kind, scriptFile), {
        cwd: opts.cwd,
        env: commandEnv(opts.cwd, isPs ? cwdFile : bashPath(cwdFile)),
        windowsHide: true,
        // POSIX only: make the shell a process-group leader so the whole tree
        // can be signalled at once. Killing the shell alone would leave
        // whatever it started — `sleep 30`, a build, an ssh — running with
        // nothing reading it. Windows has no process groups to speak of and
        // uses taskkill /T instead; passing detached there would spawn a
        // console window.
        detached: process.platform !== "win32",
      }) as ChildProcessWithoutNullStreams;
      child = proc;

      const code = await new Promise<number | null>((resolve) => {
        let exited = false;
        let open = 2;
        let settled = false;
        const finish = (c: number | null) => {
          if (settled) return;
          settled = true;
          resolve(c);
        };

        const pipe = (stream: NodeJS.ReadableStream, t: "out" | "err") => {
          const decoder = new StringDecoder("utf8");
          stream.on("data", (chunk: Buffer) => {
            const text = decoder.write(chunk);
            if (text) emit({ t, d: text });
          });
          stream.on("end", () => {
            const rest = decoder.end();
            if (rest) emit({ t, d: rest });
            open--;
            if (exited && open <= 0) finish(proc.exitCode);
          });
        };
        pipe(proc.stdout, "out");
        pipe(proc.stderr, "err");

        proc.on("error", (e) => {
          emit({ t: "err", d: `${(e as Error).message}\n` });
          finish(null);
        });
        proc.on("exit", (c) => {
          exited = true;
          if (open <= 0) finish(c);
          else setTimeout(() => finish(c), DRAIN_GRACE_MS).unref?.();
        });
      });
      proc.stdout.destroy();
      proc.stderr.destroy();

      const cwd = await fs.readFile(cwdFile, "utf8").then(
        (t) => t.replace(/^﻿/, "").trim(),
        () => "",
      );
      emit({ t: "exit", code, cwd: cwd || opts.cwd, killed });
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  })();

  /**
   * Tear down the shell and everything it started. `wait` decides whether the
   * Windows path blocks until `taskkill` has finished; the POSIX path signals
   * the process group directly and is synchronous either way.
   */
  const killTree = (wait: boolean): void => {
    if (!child || child.exitCode !== null) return;
    killed = true;
    // The shell is the process group's parent on Windows; taskkill takes the
    // tree with it, where SIGKILL on the shell alone would orphan the command.
    if (process.platform === "win32" && child.pid) {
      const args = ["/pid", String(child.pid), "/T", "/F"];
      if (wait) {
        try {
          execFileSync("taskkill", args, { windowsHide: true, stdio: "ignore" });
        } catch {
          /* already gone, or never started */
        }
      } else {
        spawn("taskkill", args, { windowsHide: true });
      }
      return;
    }
    if (child.pid) {
      try {
        // Negative pid means "the whole process group", which is the shell and
        // everything it started. It was made a group leader at spawn.
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The group is already gone, or this platform wouldn't take it —
        // fall back to the shell itself.
        child.kill("SIGKILL");
      }
      return;
    }
    child.kill("SIGKILL");
  };

  const handle: RunHandle = {
    done,
    kill: () => killTree(false),
    killSync: () => killTree(true),
  };

  running.add(handle);
  // Deregister however it ends — `done` never rejects, but a throw here would
  // leak the entry and, worse, leave `killAllCommands` trying to kill a
  // process that is already gone.
  void done.catch(() => {}).finally(() => running.delete(handle));

  return handle;
}
