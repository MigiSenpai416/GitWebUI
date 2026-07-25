import path from "node:path";
import { runGit } from "./gitRunner.js";
import { currentBranch, createLocalRepo, openRepo, type RepoInfo } from "./repo.js";
import { getToken, createRepo, type CreatedRepo } from "../github.js";

export interface Remote {
  name: string;
  url: string;
}

/** Parse `git remote -v` output into a de-duplicated list (fetch URLs). */
export function parseRemotes(stdout: string): Remote[] {
  const byName = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // "name\turl (fetch|push)"
    const tab = trimmed.indexOf("\t");
    if (tab === -1) continue;
    const name = trimmed.slice(0, tab);
    const rest = trimmed.slice(tab + 1);
    const url = rest.replace(/\s+\((fetch|push)\)$/, "");
    if (!byName.has(name)) byName.set(name, url);
  }
  return [...byName].map(([name, url]) => ({ name, url }));
}

export async function getRemotes(root: string): Promise<Remote[]> {
  const { stdout } = await runGit(root, ["remote", "-v"]);
  return parseRemotes(stdout);
}

export async function addRemote(root: string, name: string, url: string): Promise<void> {
  await runGit(root, ["remote", "add", name, url]);
}

export async function setRemoteUrl(root: string, name: string, url: string): Promise<void> {
  await runGit(root, ["remote", "set-url", name, url]);
}

export async function removeRemote(root: string, name: string): Promise<void> {
  await runGit(root, ["remote", "remove", name]);
}

/**
 * Config args + env that let git authenticate to an HTTPS remote with the
 * stored token WITHOUT leaking it into argv history and WITHOUT triggering an
 * interactive credential-manager popup (which would hang the server):
 * - `credential.helper=` clears any configured helper (e.g. GCM) for this call.
 * - `http.extraHeader` supplies Basic auth when a token is present.
 * - GIT_TERMINAL_PROMPT=0 makes auth failures error out instead of prompting.
 */
export function authArgs(token: string | null): string[] {
  const args = ["-c", "credential.helper="];
  if (token) {
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    args.push("-c", `http.extraHeader=Authorization: Basic ${basic}`);
  }
  return args;
}

const AUTH_ENV: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };

/** Turn a raw git auth failure into an actionable message when no token is set. */
function rethrowRemoteError(e: unknown, token: string | null): never {
  const msg = e instanceof Error ? e.message : String(e);
  const looksAuth =
    /could not read Username|terminal prompts disabled|Authentication failed|Invalid username or password|403 Forbidden/i.test(
      msg,
    );
  if (looksAuth && !token) {
    throw Object.assign(
      new Error(
        "Authentication required. Connect a GitHub account (Actions → Connect GitHub account), or use an SSH remote.",
      ),
      { status: 401 },
    );
  }
  throw e;
}

/** The branch's upstream short name (e.g. "origin/main"), or null if unset. */
async function upstreamName(root: string, branch: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(root, [
      "rev-parse",
      "--abbrev-ref",
      "--verify",
      `${branch}@{upstream}`,
    ]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** A push rejected because the remote has work the local branch lacks. */
function isNonFastForward(msg: string): boolean {
  return /\[rejected\]|non-fast-forward|fetch first|tip of your (current )?branch is behind|Updates were rejected/i.test(
    msg,
  );
}

export interface PushResult {
  branch: string;
  output: string;
  /** True when a normal push was rejected as non-fast-forward (needs pull/force). */
  rejected?: boolean;
  /** The upstream short name (e.g. "origin/main") when known. */
  upstream?: string | null;
}

/**
 * How a force push overwrites the remote:
 * - `"lease"` → `--force-with-lease`: overwrites unless the remote moved in ways
 *   we never fetched, so a teammate's unpulled commits can't be clobbered.
 * - `"force"` → `--force`: overwrites unconditionally. The only thing that works
 *   when the lease can't be verified (e.g. a rewritten local history whose
 *   remote-tracking ref is stale), and the only one that can destroy work.
 */
export type PushForce = "lease" | "force";

/** The git flag that implements each force mode. */
const FORCE_FLAG: Record<PushForce, string> = {
  lease: "--force-with-lease",
  force: "--force",
};

/**
 * Push the current branch. If it has no upstream, set one on `origin`. A normal
 * push rejected as non-fast-forward — for ANY reason the local and remote tips
 * have diverged (an amended/rebased/reset local branch, or a remote that gained
 * commits) — resolves to `{ rejected: true }` rather than throwing, so the
 * caller can offer Pull or one of the two force modes (see `PushForce`). A
 * lease push that trips its own safety check surfaces a clear "pull first (or
 * force)" error rather than a raw git message. Requires an `origin` remote;
 * HTTPS remotes use the stored token.
 */
export async function push(root: string, opts: { force?: PushForce } = {}): Promise<PushResult> {
  const token = await getToken();
  const branch = await currentBranch(root);
  const upstream = await upstreamName(root, branch);
  const args = [...authArgs(token), "push"];
  if (opts.force) args.push(FORCE_FLAG[opts.force]);
  if (!upstream) args.push("--set-upstream", "origin", branch);
  try {
    const { stderr } = await runGit(root, args, { env: AUTH_ENV });
    return { branch, output: stderr.trim() };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!opts.force && isNonFastForward(msg)) {
      return { branch, output: msg, rejected: true, upstream };
    }
    // A force-with-lease that fails on "stale info" means the remote gained
    // commits we never fetched — the protection working as intended. Bare force
    // is the deliberate way past it, so name it.
    if (opts.force === "lease" && /stale info/i.test(msg)) {
      throw Object.assign(
        new Error(
          "The remote has new commits you haven't fetched yet, so force-with-lease refused to overwrite them. Pull first, or push again and choose Force Push (no lease) to overwrite the remote anyway.",
        ),
        { status: 409 },
      );
    }
    rethrowRemoteError(e, token);
  }
}

/**
 * Delete a branch on the remote (`git push <remote> --delete <branch>`), which
 * also drops the local remote-tracking ref. Destructive and not undoable from
 * here — the caller confirms first. HTTPS remotes use the stored token.
 */
export async function deleteRemoteBranch(
  root: string,
  remote: string,
  branch: string,
): Promise<void> {
  if (!remote || !branch || remote.startsWith("-") || branch.startsWith("-")) {
    throw Object.assign(new Error("Invalid remote branch"), { status: 400 });
  }
  const token = await getToken();
  try {
    await runGit(root, [...authArgs(token), "push", remote, "--delete", branch], { env: AUTH_ENV });
  } catch (e) {
    rethrowRemoteError(e, token);
  }
}

export interface PullResult {
  output: string;
}

/** Pull (fetch + merge) the current branch's upstream. */
export async function pull(root: string): Promise<PullResult> {
  const token = await getToken();
  const args = [...authArgs(token), "-c", "core.editor=true", "pull", "--no-edit"];
  try {
    const { stdout, stderr } = await runGit(root, args, { env: AUTH_ENV });
    return { output: (stdout + stderr).trim() };
  } catch (e) {
    rethrowRemoteError(e, token);
  }
}

/** Derive the target folder name from a clone URL (last path segment, sans `.git`). */
export function repoNameFromUrl(url: string): string {
  const clean = url.trim().replace(/[/\\]+$/, "").replace(/\.git$/i, "");
  const seg = clean.split(/[/\\]/).filter(Boolean).pop() ?? "";
  return seg || "repository";
}

/**
 * Clone `url` into a new subfolder of `parentDir` and open the result. HTTPS
 * GitHub remotes authenticate with the stored token (private repos included)
 * without prompting an interactive credential helper.
 */
export async function cloneRepo(parentDir: string, url: string): Promise<RepoInfo> {
  const token = await getToken();
  const target = path.join(parentDir, repoNameFromUrl(url));
  try {
    await runGit(parentDir, [...authArgs(token), "clone", url, target], { env: AUTH_ENV });
  } catch (e) {
    rethrowRemoteError(e, token);
  }
  return openRepo(target);
}

export interface CreateRepoResult {
  repo: CreatedRepo;
  remotes: Remote[];
}

/**
 * Create a GitHub repository for the connected account, wire it up as a remote,
 * and push the current branch's local refs to it.
 */
export async function createGitHubRemote(
  root: string,
  opts: { name: string; description?: string; private: boolean; remoteName: string },
): Promise<CreateRepoResult> {
  const token = await getToken();
  if (!token) {
    throw Object.assign(new Error("Connect a GitHub account first"), { status: 401 });
  }
  const repo = await createRepo(token, {
    name: opts.name,
    description: opts.description,
    private: opts.private,
  });
  await addRemote(root, opts.remoteName, repo.cloneUrl);
  const branch = await currentBranch(root);
  await runGit(root, [...authArgs(token), "push", "--set-upstream", opts.remoteName, branch], {
    env: AUTH_ENV,
  });
  return { repo, remotes: await getRemotes(root) };
}

export interface CreateGitHubResult {
  created: CreatedRepo;
  /** The local clone, or null when "clone after init" was off. */
  repo: RepoInfo | null;
}

/**
 * Create a brand-new repository on GitHub for the connected account. When
 * `clone` is set, also initialize a matching local repo (seeded README + initial
 * commit on `defaultBranch`), wire it to the new remote, and push — so the user
 * lands in a ready-to-work local checkout. Without `clone`, the repo is created
 * on GitHub with an auto-generated README and nothing is written locally.
 */
export async function createGitHubRepoNew(opts: {
  name: string;
  description?: string;
  private: boolean;
  defaultBranch: string;
  clone: boolean;
  dir: string;
  identity: { name: string; email: string } | null;
}): Promise<CreateGitHubResult> {
  const token = await getToken();
  if (!token) {
    throw Object.assign(new Error("Connect a GitHub account first"), { status: 401 });
  }
  if (opts.clone && !opts.dir.trim()) {
    throw Object.assign(new Error("A folder to clone into is required"), { status: 400 });
  }
  // When cloning we seed locally and push; otherwise let GitHub auto-init a README.
  const created = await createRepo(token, {
    name: opts.name,
    description: opts.description,
    private: opts.private,
    autoInit: !opts.clone,
  });
  if (!opts.clone) return { created, repo: null };

  const info = await createLocalRepo(opts.dir, opts.name, opts.defaultBranch, opts.identity);
  await addRemote(info.root, "origin", created.cloneUrl);
  try {
    await runGit(
      info.root,
      [...authArgs(token), "push", "--set-upstream", "origin", info.branch],
      { env: AUTH_ENV },
    );
  } catch (e) {
    rethrowRemoteError(e, token);
  }
  return { created, repo: await openRepo(info.root) };
}
