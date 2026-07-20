import { runGit } from "./gitRunner.js";
import { currentBranch } from "./repo.js";
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

async function hasUpstream(root: string, branch: string): Promise<boolean> {
  try {
    await runGit(root, ["rev-parse", "--abbrev-ref", "--verify", `${branch}@{upstream}`]);
    return true;
  } catch {
    return false;
  }
}

export interface PushResult {
  branch: string;
  output: string;
}

/**
 * Push the current branch. If it has no upstream, set one on `origin`.
 * Requires an `origin` remote; HTTPS remotes use the stored token.
 */
export async function push(root: string): Promise<PushResult> {
  const token = await getToken();
  const branch = await currentBranch(root);
  const upstream = await hasUpstream(root, branch);
  const args = [...authArgs(token), "push"];
  if (!upstream) args.push("--set-upstream", "origin", branch);
  try {
    const { stderr } = await runGit(root, args, { env: AUTH_ENV });
    return { branch, output: stderr.trim() };
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
