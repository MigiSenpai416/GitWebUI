import { execFile } from "node:child_process";
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
    execFile(
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
  });
}

/** Convenience: run git and return only trimmed stdout. */
export async function gitOut(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await runGit(cwd, args);
  return stdout;
}
