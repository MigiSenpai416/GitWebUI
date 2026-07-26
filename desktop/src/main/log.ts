import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { app } from "electron";

/**
 * A log file for the main process.
 *
 * A packaged Windows app is a GUI-subsystem binary with no console attached, so
 * `console.error` in the main process goes nowhere at all — the failure mode is
 * an app that exits silently with nothing to show for it. On macOS and Linux
 * the output exists but only if the app was started from a terminal, which
 * nobody does. So anything worth knowing after the fact is written to a file
 * the user can be asked for.
 *
 * Deliberately synchronous: this is used from crash handlers, where the process
 * may not survive long enough to flush an async write.
 */

const MAX_BYTES = 512 * 1024;
let logFile: string | null = null;
let broken = false;

function target(): string | null {
  if (broken) return null;
  if (logFile) return logFile;
  try {
    const dir = app.getPath("userData");
    mkdirSync(dir, { recursive: true });
    logFile = path.join(dir, "main.log");
    // One rotation is plenty: the previous run is nearly always the
    // interesting one, and an unbounded log on a long-lived desktop app is its
    // own bug.
    try {
      if (statSync(logFile).size > MAX_BYTES) renameSync(logFile, `${logFile}.1`);
    } catch {
      /* no existing log, or it can't be rotated — neither is worth failing on */
    }
    return logFile;
  } catch {
    broken = true;
    return null;
  }
}

function write(level: string, parts: unknown[]): void {
  const text = parts
    .map((p) => {
      if (p instanceof Error) return p.stack ?? `${p.name}: ${p.message}`;
      if (typeof p === "string") return p;
      try {
        return JSON.stringify(p);
      } catch {
        return String(p);
      }
    })
    .join(" ");

  const line = `${new Date().toISOString()} [${level}] ${text}\n`;
  // Still emit to the console: in development that is where it is read.
  if (level === "ERROR") console.error(line.trimEnd());
  else console.log(line.trimEnd());

  const file = target();
  if (!file) return;
  try {
    appendFileSync(file, line, "utf8");
  } catch {
    broken = true;
  }
}

export const log = {
  info: (...parts: unknown[]): void => write("INFO", parts),
  error: (...parts: unknown[]): void => write("ERROR", parts),
  /** Where the log lives, for an error dialog that wants to point at it. */
  path: (): string | null => target(),
};
