import { promises as fs } from "node:fs";
import { configPath, ensureConfigDir } from "./config.js";
import type { CommitIdentity } from "./identity.js";

/**
 * GitHub Personal Access Token storage + minimal GitHub REST calls.
 *
 * The token is stored in plaintext in the app config dir (like git's own
 * `store` credential helper) because git needs the live value to authenticate
 * pushes/pulls. Treat the config dir as sensitive.
 */

const tokenFile = () => configPath("github.json");
const API = "https://api.github.com";

export interface GitHubUser {
  login: string;
  name: string | null;
  avatarUrl: string | null;
  id: number;
  email: string | null;
}

interface TokenConfig {
  token: string;
}

let cache: TokenConfig | null = null;
let loaded = false;

async function read(): Promise<TokenConfig | null> {
  if (loaded) return cache;
  try {
    const raw = await fs.readFile(tokenFile(), "utf8");
    const parsed = JSON.parse(raw) as Partial<TokenConfig>;
    cache = parsed.token ? { token: parsed.token } : null;
  } catch {
    cache = null;
  }
  loaded = true;
  return cache;
}

export async function getToken(): Promise<string | null> {
  return (await read())?.token ?? null;
}

export async function hasToken(): Promise<boolean> {
  return (await getToken()) !== null;
}

/** Persist the token. */
export async function setToken(token: string): Promise<void> {
  await ensureConfigDir();
  await fs.writeFile(tokenFile(), JSON.stringify({ token }, null, 2), "utf8");
  cache = { token };
  loaded = true;
}

/** Remove the stored token (revoke locally). */
export async function deleteToken(): Promise<void> {
  await fs.rm(tokenFile(), { force: true });
  cache = null;
  loaded = true;
}

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "GitWebUI",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function ghError(status: number, body: string): Error & { status: number } {
  let message = `GitHub API error (${status})`;
  try {
    const j = JSON.parse(body);
    if (j?.message) message = j.message;
    // Validation failures say only "Validation Failed" at the top level — the
    // actionable text ("No commits between …", "A pull request already exists …")
    // lives in errors[].message.
    const detail = Array.isArray(j?.errors)
      ? j.errors
          .map((e: { message?: string }) => (typeof e === "string" ? e : e?.message))
          .filter(Boolean)
          .join("; ")
      : "";
    if (detail) message = detail;
  } catch {
    /* non-JSON */
  }
  // Map auth failures to 401 so the UI can prompt to reconnect.
  const outStatus = status === 401 || status === 403 ? 401 : 422;
  return Object.assign(new Error(message), { status: outStatus });
}

/** Fetch the authenticated user for a token; throws on an invalid token. */
export async function fetchUser(token: string): Promise<GitHubUser> {
  const res = await fetch(`${API}/user`, { headers: ghHeaders(token) });
  if (!res.ok) throw ghError(res.status, await res.text());
  const j = (await res.json()) as {
    login: string;
    name: string | null;
    avatar_url: string | null;
    id: number;
    email: string | null;
  };
  return {
    login: j.login,
    name: j.name ?? null,
    avatarUrl: j.avatar_url ?? null,
    id: j.id,
    email: j.email ?? null,
  };
}

/**
 * The account's primary verified email via `/user/emails`. Requires the token's
 * `user:email` (or `read:user`) scope; returns null if the scope is missing or
 * the call fails, so the caller can fall back gracefully.
 */
export async function fetchPrimaryEmail(token: string): Promise<string | null> {
  try {
    const res = await fetch(`${API}/user/emails`, { headers: ghHeaders(token) });
    if (!res.ok) return null;
    const emails = (await res.json()) as Array<{
      email: string;
      primary: boolean;
      verified: boolean;
    }>;
    if (!Array.isArray(emails)) return null;
    const chosen =
      emails.find((e) => e.primary && e.verified) ??
      emails.find((e) => e.verified) ??
      emails[0];
    return chosen?.email ?? null;
  } catch {
    return null;
  }
}

/**
 * Commit identity derived from the connected GitHub account, or null if no
 * token is stored / it's invalid. Prefers the primary verified email; falls
 * back to the public-profile email, then GitHub's noreply address, so commits
 * always attribute to the account even when no email scope is granted.
 */
export async function githubIdentity(): Promise<CommitIdentity | null> {
  const token = await getToken();
  if (!token) return null;
  try {
    const u = await fetchUser(token);
    const name = u.name || u.login;
    const primary = await fetchPrimaryEmail(token);
    const email = primary || u.email || `${u.id}+${u.login}@users.noreply.github.com`;
    return { name, email };
  } catch {
    return null;
  }
}

/** Current connection status: whether a token is stored and, if valid, the user. */
export async function status(): Promise<{ configured: boolean; user: GitHubUser | null; error?: string }> {
  const token = await getToken();
  if (!token) return { configured: false, user: null };
  try {
    return { configured: true, user: await fetchUser(token) };
  } catch (e) {
    return { configured: true, user: null, error: e instanceof Error ? e.message : "Invalid token" };
  }
}

export interface GitHubRepo {
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  cloneUrl: string;
  description: string | null;
  updatedAt: string | null;
}

/**
 * List repositories the authenticated account can access (owned, collaborator,
 * and org member), public and private, most-recently-updated first. Paginates
 * up to a sane cap so the clone picker stays snappy.
 */
export async function listRepos(token: string): Promise<GitHubRepo[]> {
  const perPage = 100;
  const maxPages = 5;
  const repos: GitHubRepo[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const url =
      `${API}/user/repos?per_page=${perPage}&page=${page}` +
      `&sort=updated&affiliation=owner,collaborator,organization_member`;
    const res = await fetch(url, { headers: ghHeaders(token) });
    if (!res.ok) throw ghError(res.status, await res.text());
    const batch = (await res.json()) as Array<{
      full_name: string;
      name: string;
      owner: { login: string };
      private: boolean;
      clone_url: string;
      description: string | null;
      updated_at: string | null;
    }>;
    for (const r of batch) {
      repos.push({
        fullName: r.full_name,
        name: r.name,
        owner: r.owner?.login ?? "",
        private: r.private,
        cloneUrl: r.clone_url,
        description: r.description ?? null,
        updatedAt: r.updated_at ?? null,
      });
    }
    if (batch.length < perPage) break;
  }
  return repos;
}

export interface CreatedRepo {
  fullName: string;
  cloneUrl: string;
  htmlUrl: string;
}

/** Create a repository under the authenticated account. */
export async function createRepo(
  token: string,
  opts: { name: string; description?: string; private: boolean; autoInit?: boolean },
): Promise<CreatedRepo> {
  const res = await fetch(`${API}/user/repos`, {
    method: "POST",
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({
      name: opts.name,
      description: opts.description || undefined,
      private: opts.private,
      auto_init: opts.autoInit ?? false,
    }),
  });
  if (!res.ok) throw ghError(res.status, await res.text());
  const j = (await res.json()) as { full_name: string; clone_url: string; html_url: string };
  return { fullName: j.full_name, cloneUrl: j.clone_url, htmlUrl: j.html_url };
}

// ---- Pull requests ----

/** A repository as the pull-request dialog needs it (target + fork lineage). */
export interface GitHubRepoRef {
  fullName: string;
  owner: string;
  name: string;
  defaultBranch: string;
  private: boolean;
  isFork: boolean;
  /** The upstream this repo was forked from ("owner/name"), or null. */
  parentFullName: string | null;
}

/** A user that can be requested as a reviewer or set as an assignee. */
export interface GitHubAccount {
  login: string;
  avatarUrl: string | null;
}

export interface GitHubLabel {
  name: string;
  color: string;
  description: string | null;
}

export interface CreatedPullRequest {
  number: number;
  htmlUrl: string;
  title: string;
}

/**
 * Extract `owner/repo` from a github.com clone URL — HTTPS, `ssh://`, `git://`,
 * and the scp-like `git@github.com:owner/repo.git` form. Anything hosted
 * elsewhere (GitLab, a private server) returns null so non-GitHub remotes are
 * simply skipped by the caller.
 */
export function parseGitHubSlug(url: string): { owner: string; repo: string } | null {
  const raw = (url ?? "").trim();
  if (!raw) return null;

  let host: string;
  let rest: string;
  const scp = raw.match(/^[\w.+-]+@([^/:]+):(.+)$/);
  if (scp) {
    host = scp[1];
    rest = scp[2];
  } else {
    const m = raw.match(/^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/i);
    if (!m) return null;
    host = m[1];
    rest = m[2];
  }

  host = host.toLowerCase().replace(/:\d+$/, "");
  if (host !== "github.com" && host !== "www.github.com") return null;

  const segments = rest
    .replace(/[/]+$/, "")
    .replace(/\.git$/i, "")
    .split("/")
    .filter(Boolean);
  if (segments.length < 2) return null;
  return { owner: segments[0], repo: segments[1] };
}

function toRepoRef(j: {
  full_name: string;
  name: string;
  owner: { login: string };
  default_branch: string;
  private: boolean;
  fork: boolean;
  parent?: { full_name: string } | null;
}): GitHubRepoRef {
  return {
    fullName: j.full_name,
    owner: j.owner?.login ?? "",
    name: j.name,
    defaultBranch: j.default_branch || "main",
    private: j.private,
    isFork: Boolean(j.fork),
    parentFullName: j.parent?.full_name ?? null,
  };
}

/** Fetch a single repository, including its fork parent when it has one. */
export async function fetchRepo(token: string, owner: string, repo: string): Promise<GitHubRepoRef> {
  const res = await fetch(`${API}/repos/${owner}/${repo}`, { headers: ghHeaders(token) });
  if (!res.ok) throw ghError(res.status, await res.text());
  return toRepoRef(await res.json());
}

/** Branch names of a repository (paginated up to a sane cap). */
export async function listBranchNames(
  token: string,
  owner: string,
  repo: string,
): Promise<string[]> {
  const perPage = 100;
  const maxPages = 5;
  const names: string[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = `${API}/repos/${owner}/${repo}/branches?per_page=${perPage}&page=${page}`;
    const res = await fetch(url, { headers: ghHeaders(token) });
    if (!res.ok) throw ghError(res.status, await res.text());
    const batch = (await res.json()) as Array<{ name: string }>;
    for (const b of batch) names.push(b.name);
    if (batch.length < perPage) break;
  }
  return names;
}

/**
 * GET a list endpoint that requires push access, degrading to an empty list when
 * the token can only read the repo — the dialog then shows "None available"
 * instead of failing outright.
 */
async function listOrEmpty<T>(token: string, path: string): Promise<T[]> {
  try {
    const res = await fetch(`${API}${path}`, { headers: ghHeaders(token) });
    if (!res.ok) return [];
    const j = await res.json();
    return Array.isArray(j) ? (j as T[]) : [];
  } catch {
    return [];
  }
}

function toAccounts(raw: Array<{ login: string; avatar_url: string | null }>): GitHubAccount[] {
  return raw.map((u) => ({ login: u.login, avatarUrl: u.avatar_url ?? null }));
}

/** Users who can be requested as reviewers (repo collaborators). */
export async function listCollaborators(
  token: string,
  owner: string,
  repo: string,
): Promise<GitHubAccount[]> {
  return toAccounts(
    await listOrEmpty<{ login: string; avatar_url: string | null }>(
      token,
      `/repos/${owner}/${repo}/collaborators?per_page=100`,
    ),
  );
}

/** Users who can be assigned to an issue/pull request. */
export async function listAssignableUsers(
  token: string,
  owner: string,
  repo: string,
): Promise<GitHubAccount[]> {
  return toAccounts(
    await listOrEmpty<{ login: string; avatar_url: string | null }>(
      token,
      `/repos/${owner}/${repo}/assignees?per_page=100`,
    ),
  );
}

/** Labels defined on a repository. */
export async function listLabels(
  token: string,
  owner: string,
  repo: string,
): Promise<GitHubLabel[]> {
  const raw = await listOrEmpty<{ name: string; color: string; description: string | null }>(
    token,
    `/repos/${owner}/${repo}/labels?per_page=100`,
  );
  return raw.map((l) => ({ name: l.name, color: l.color, description: l.description ?? null }));
}

/**
 * Open a pull request on `owner/repo`. For a cross-repository (fork) PR the
 * caller passes `head` as "owner:branch"; same-repo PRs pass the bare branch.
 */
export async function createPullRequest(
  token: string,
  opts: {
    owner: string;
    repo: string;
    title: string;
    body: string;
    head: string;
    base: string;
    draft: boolean;
  },
): Promise<CreatedPullRequest> {
  const res = await fetch(`${API}/repos/${opts.owner}/${opts.repo}/pulls`, {
    method: "POST",
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({
      title: opts.title,
      body: opts.body || undefined,
      head: opts.head,
      base: opts.base,
      draft: opts.draft,
    }),
  });
  if (!res.ok) throw ghError(res.status, await res.text());
  const j = (await res.json()) as { number: number; html_url: string; title: string };
  return { number: j.number, htmlUrl: j.html_url, title: j.title };
}

/** Request reviews on an open pull request. */
export async function requestReviewers(
  token: string,
  owner: string,
  repo: string,
  number: number,
  reviewers: string[],
): Promise<void> {
  const res = await fetch(`${API}/repos/${owner}/${repo}/pulls/${number}/requested_reviewers`, {
    method: "POST",
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ reviewers }),
  });
  if (!res.ok) throw ghError(res.status, await res.text());
}

/** Set assignees and/or labels (a PR is an issue as far as these fields go). */
export async function updateIssueFields(
  token: string,
  owner: string,
  repo: string,
  number: number,
  fields: { assignees?: string[]; labels?: string[] },
): Promise<void> {
  const res = await fetch(`${API}/repos/${owner}/${repo}/issues/${number}`, {
    method: "PATCH",
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });
  if (!res.ok) throw ghError(res.status, await res.text());
}

/** Test hook to reset the in-memory cache. */
export function _resetTokenCache(): void {
  cache = null;
  loaded = false;
}
