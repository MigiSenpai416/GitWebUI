import { promises as fs } from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "./config.js";
import type { CommitIdentity } from "./identity.js";

/**
 * GitHub Personal Access Token storage + minimal GitHub REST calls.
 *
 * The token is stored in plaintext in the app config dir (like git's own
 * `store` credential helper) because git needs the live value to authenticate
 * pushes/pulls. Treat the config dir as sensitive.
 */

const TOKEN_FILE = path.join(CONFIG_DIR, "github.json");
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
    const raw = await fs.readFile(TOKEN_FILE, "utf8");
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
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(TOKEN_FILE, JSON.stringify({ token }, null, 2), "utf8");
  cache = { token };
  loaded = true;
}

/** Remove the stored token (revoke locally). */
export async function deleteToken(): Promise<void> {
  await fs.rm(TOKEN_FILE, { force: true });
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

/** Test hook to reset the in-memory cache. */
export function _resetTokenCache(): void {
  cache = null;
  loaded = false;
}
