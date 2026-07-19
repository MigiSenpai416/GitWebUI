import type {
  Branch,
  Commit,
  CommitFile,
  DiffResult,
  DiffSource,
  RepoInfo,
  StatusResult,
} from "../types";

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      /* non-JSON error */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export const api = {
  currentRepo: () => req<{ repo: RepoInfo | null }>("/api/repo/current"),
  recent: () => req<{ recent: string[] }>("/api/repo/recent"),
  openRepo: (path: string) =>
    req<{ repo: RepoInfo }>("/api/repo/open", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),

  commits: (skip: number, limit: number) =>
    req<{ commits: Commit[]; hasMore: boolean }>(
      `/api/commits?skip=${skip}&limit=${limit}`,
    ),
  commitFiles: (hash: string) =>
    req<{ files: CommitFile[] }>(`/api/commits/${hash}/files`),

  status: () => req<StatusResult>("/api/status"),

  branches: () => req<{ branches: Branch[] }>("/api/branches"),
  checkout: (branch: string) =>
    req<{ repo: RepoInfo }>("/api/checkout", {
      method: "POST",
      body: JSON.stringify({ branch }),
    }),
  createBranch: (name: string, hash: string) =>
    req<{ repo: RepoInfo }>("/api/branch/create", {
      method: "POST",
      body: JSON.stringify({ name, hash }),
    }),
  reset: (hash: string, mode: "hard" | "soft" | "mixed") =>
    req<{ repo: RepoInfo }>("/api/reset", {
      method: "POST",
      body: JSON.stringify({ hash, mode }),
    }),
  revert: (hash: string) =>
    req<{ repo: RepoInfo }>("/api/revert", {
      method: "POST",
      body: JSON.stringify({ hash }),
    }),
  discardAll: () =>
    req<StatusResult>("/api/discard", { method: "POST", body: JSON.stringify({}) }),

  diff: (source: DiffSource, path: string, hash?: string) => {
    const params = new URLSearchParams({ source, path });
    if (hash) params.set("hash", hash);
    return req<DiffResult>(`/api/diff?${params.toString()}`);
  },

  stage: (paths: string[]) =>
    req<StatusResult>("/api/stage", {
      method: "POST",
      body: JSON.stringify({ paths }),
    }),
  stageAll: () =>
    req<StatusResult>("/api/stage", {
      method: "POST",
      body: JSON.stringify({ all: true }),
    }),
  unstage: (paths: string[]) =>
    req<StatusResult>("/api/unstage", {
      method: "POST",
      body: JSON.stringify({ paths }),
    }),
  commit: (title: string, description: string, amend: boolean) =>
    req<{ hash: string; status: StatusResult }>("/api/commit", {
      method: "POST",
      body: JSON.stringify({ title, description, amend }),
    }),
};
