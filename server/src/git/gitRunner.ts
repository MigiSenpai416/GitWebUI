import { execFile, spawn } from "node:child_process";
import { gitPath } from "./gitPath.js";

const MAX_BUFFER = 256 * 1024 * 1024; // 256 MiB — large diffs / full-file (-U1000000) output

export class GitError extends Error {
  constructor(
    message: string,
    public readonly code: number | null,
    public readonly stderr: string,
    public readonly args: string[],
  ) {
    super(message);
    this.name = "GitError";
  }
}

export interface GitResult {
  stdout: string;
  stderr: string;
}

export interface GitOptions {
  /** Extra environment variables merged over the parent process env. */
  env?: NodeJS.ProcessEnv;
  /** Optional stdin for commands such as `git update-ref --stdin`. */
  input?: string | Buffer;
}

/**
 * Run `git` against a working directory. Arguments are passed as an argv array
 * (never a shell string), so repo paths / filenames with spaces or shell
 * metacharacters are safe and cannot be used for command injection.
 *
 * `encoding: "buffer"` is used and decoded as UTF-8 so we never lose bytes on
 * binary-ish output; callers that need raw bytes should use runGitBuffer.
 *
 * The executable comes from `gitPath()` rather than a literal `"git"`: a
 * desktop app launched from the Dock or Explorer may not have git on its PATH
 * even though the user does. It resolves to `"git"` unless something pinned it.
 */
export function runGit(cwd: string, args: string[], opts: GitOptions = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      gitPath(),
      args,
      {
        cwd,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        encoding: "buffer",
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
      },
      (err, stdout, stderr) => {
        const out = stdout.toString("utf8");
        const errOut = stderr.toString("utf8");
        if (err) {
          const code = typeof (err as NodeJS.ErrnoException).code === "number"
            ? ((err as unknown as { code: number }).code)
            : null;
          reject(
            new GitError(
              errOut.trim() || err.message,
              code,
              errOut,
              args,
            ),
          );
          return;
        }
        resolve({ stdout: out, stderr: errOut });
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

/** Run a `-z` Git command without buffering its cumulative output. */
export function runGitNullRecords(
  cwd: string,
  args: string[],
  opts: GitOptions = {},
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(gitPath(), args, {
      cwd,
      windowsHide: true,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const records = new Set<string>();
    const stderr: Buffer[] = [];
    let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let failure: GitError | null = null;
    let settled = false;

    child.stdout.on("data", (chunk: Buffer) => {
      if (failure) return;
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let separator: number;
      while ((separator = pending.indexOf(0)) >= 0) {
        const record = pending.subarray(0, separator);
        pending = pending.subarray(separator + 1);
        if (!record.length) continue;
        try {
          records.add(decoder.decode(record));
        } catch {
          failure = new GitError(
            "Git history contains a filename that is not valid UTF-8; GitWebUI cannot safely select it for deletion",
            null,
            "",
            args,
          );
          child.kill();
          return;
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(new GitError(error.message, null, "", args));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (failure) {
        reject(failure);
        return;
      }
      const errOut = Buffer.concat(stderr).toString("utf8");
      if (code !== 0) {
        reject(new GitError(errOut.trim() || `Git exited with code ${code}`, code, errOut, args));
        return;
      }
      if (pending.length) {
        reject(new GitError("Git returned an incomplete NUL-delimited record", code, errOut, args));
        return;
      }
      resolve([...records]);
    });
    child.stdin.end(opts.input);
  });
}

/** Convenience: run git and return only trimmed stdout. */
export async function gitOut(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await runGit(cwd, args);
  return stdout;
}
