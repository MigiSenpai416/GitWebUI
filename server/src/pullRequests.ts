import { ghHeaders, ghError, fetchUser } from "./github.js";

interface User { login: string }
interface Pull {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: string;
  draft: boolean;
  merged_at: string | null;
  user: User | null;
  assignees: User[];
  requested_reviewers: User[];
  requested_teams: Array<{ slug: string }>;
  labels: Array<{ name: string }>;
  updated_at: string;
  head: { label: string; sha: string; ref: string };
  base: { label: string; ref: string };
  mergeable: boolean | null;
  mergeable_state: string;
  additions: number;
  deletions: number;
  changed_files: number;
  commits: number;
  locked: boolean;
}

async function request<T>(token: string, path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw ghError(res.status, await res.text());
  return await res.json() as T;
}

function summary(p: Pull) {
  return {
    number: p.number, title: p.title, body: p.body ?? "", htmlUrl: p.html_url,
    state: p.merged_at ? "merged" : p.state, draft: Boolean(p.draft), author: p.user?.login ?? "ghost",
    assignees: (p.assignees ?? []).map((u) => u.login),
    reviewers: (p.requested_reviewers ?? []).map((u) => u.login),
    teams: (p.requested_teams ?? []).map((t) => t.slug),
    labels: (p.labels ?? []).map((l) => l.name), updatedAt: p.updated_at,
    head: p.head.label, base: p.base.label, sha: p.head.sha,
  };
}

export async function listPullRequests(token: string, slug: string, state: string, page: number) {
  const items = await request<Pull[]>(token,
    `/repos/${slug}/pulls?state=${state}&sort=updated&direction=desc&per_page=100&page=${page}`);
  return { items: items.map(summary), hasMore: items.length === 100 };
}

export async function pullRequestDetails(token: string, slug: string, number: number) {
  const path = `/repos/${slug}`;
  const [p, viewer, repository] = await Promise.all([
    request<Pull>(token, `${path}/pulls/${number}`),
    fetchUser(token),
    request<{ permissions?: { push?: boolean; maintain?: boolean; admin?: boolean }; allow_merge_commit?: boolean;
      allow_squash_merge?: boolean; allow_rebase_merge?: boolean; archived?: boolean }>(token, path),
  ]);
  const write = Boolean(repository.permissions?.push || repository.permissions?.maintain || repository.permissions?.admin);
  const author = p.user?.login.toLowerCase() === viewer.login.toLowerCase();
  return {
    ...summary(p), mergeable: p.mergeable, mergeableState: p.mergeable_state,
    additions: p.additions, deletions: p.deletions, changedFiles: p.changed_files, commits: p.commits,
    canEdit: !repository.archived && (write || author), canMerge: !repository.archived && write,
    canComment: !repository.archived && (!p.locked || write),
    canReview: !repository.archived && !author && p.state === "open" && !p.draft,
    mergeMethods: [repository.allow_merge_commit && "merge", repository.allow_squash_merge && "squash",
      repository.allow_rebase_merge && "rebase"].filter((m): m is string => Boolean(m)),
  };
}

export async function pullRequestActivity(token: string, slug: string, number: number, kind: string, page: number) {
  if (kind === "thread-states") {
    const [owner, name] = slug.split("/");
    const items: Array<{ node_id: string; is_resolved: boolean; is_outdated: boolean; is_collapsed: boolean }> = [];
    let cursor: string | null = null;
    do {
      const result: { data?: { repository?: { pullRequest?: { reviewThreads: {
        nodes: Array<{ isResolved: boolean; isOutdated: boolean; isCollapsed: boolean; comments: { nodes: Array<{ id: string }> } }>;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      } } } }; errors?: Array<{ message: string }> } = await request(token, "/graphql", "POST", {
        query: `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
          repository(owner: $owner, name: $name) { pullRequest(number: $number) {
            reviewThreads(first: 100, after: $cursor) {
              nodes { isResolved isOutdated isCollapsed comments(first: 1) { nodes { id } } }
              pageInfo { hasNextPage endCursor }
            }
          } }
        }`,
        variables: { owner, name, number, cursor },
      });
      if (result.errors?.length) throw new Error(result.errors.map((e) => e.message).join("; "));
      const threads = result.data?.repository?.pullRequest?.reviewThreads;
      if (!threads) throw new Error("GitHub did not return review thread state.");
      for (const thread of threads.nodes) {
        const root = thread.comments.nodes[0];
        if (root) items.push({ node_id: root.id, is_resolved: thread.isResolved, is_outdated: thread.isOutdated, is_collapsed: thread.isCollapsed });
      }
      if (!threads.pageInfo.hasNextPage) break;
      if (!threads.pageInfo.endCursor || threads.pageInfo.endCursor === cursor) throw new Error("GitHub did not advance review thread pagination.");
      cursor = threads.pageInfo.endCursor;
    } while (cursor);
    return { items, hasMore: false };
  }
  const path = `/repos/${slug}`;
  const endpoints: Record<string, string> = {
    timeline: `${path}/issues/${number}/timeline`,
    comments: `${path}/issues/${number}/comments`, reviews: `${path}/pulls/${number}/reviews`,
    threads: `${path}/pulls/${number}/comments`, files: `${path}/pulls/${number}/files`, commits: `${path}/pulls/${number}/commits`,
  };
  if (!Object.prototype.hasOwnProperty.call(endpoints, kind)) throw Object.assign(new Error("Unknown pull request activity"), { status: 400 });
  const endpoint = endpoints[kind];
  const before = kind === "files" ? await request<Pull>(token, `${path}/pulls/${number}`) : null;
  const items = await request<unknown[]>(token, `${endpoint}?per_page=100&page=${page}`);
  if (kind === "timeline") {
    const commits = (items as Array<{ event?: string; node_id?: string; sha?: string }>).filter((item) => item.event === "committed" && item.node_id);
    if (commits.length) {
      try {
        const result = await request<{ data?: { nodes: Array<{ oid: string; author?: { user?: { login: string; avatarUrl: string } }; statusCheckRollup?: { state: string } } | null> }; errors?: Array<{ message: string }> }>(token, "/graphql", "POST", {
          query: `query($ids: [ID!]!) { nodes(ids: $ids) { ... on Commit { oid author { user { login avatarUrl } } statusCheckRollup { state } } } }`,
          variables: { ids: commits.map((item) => item.node_id) },
        });
        if (result.errors?.length) throw new Error(result.errors.map((e) => e.message).join("; "));
        if (!result.data) throw new Error("GitHub did not return commit details.");
        const bySha = new Map(result.data.nodes.filter((node) => node !== null).map((node) => [node.oid, node]));
        return { items: (items as Array<{ event?: string; sha?: string }>).map((item) => {
          const commit = item.event === "committed" ? bySha.get(item.sha ?? "") : undefined;
          return commit ? { ...item, user: commit.author?.user ? { login: commit.author.user.login, avatar_url: commit.author.user.avatarUrl } : undefined, check_state: commit.statusCheckRollup?.state } : item;
        }), hasMore: items.length === 100 };
      } catch (e) {
        return { items, hasMore: items.length === 100, warning: `Commit details unavailable: ${e instanceof Error ? e.message : "Couldn't load commit details."}` };
      }
    }
  }
  if (before) {
    const after = await request<Pull>(token, `${path}/pulls/${number}`);
    if (before.head.sha !== after.head.sha) throw Object.assign(new Error("The pull request changed while loading files. Refresh and try again."), { status: 409 });
  }
  return { items, hasMore: items.length === 100 && (kind !== "files" || page < 30), ...(before ? { sha: before.head.sha } : {}) };
}

export async function pullRequestChecks(token: string, slug: string, number: number, page: number) {
  const path = `/repos/${slug}`;
  const p = await request<Pull>(token, `${path}/pulls/${number}`);
  const sha = encodeURIComponent(p.head.sha);
  const results = await Promise.allSettled([
    request<{ check_runs: unknown[]; total_count: number }>(token, `${path}/commits/${sha}/check-runs?per_page=100&page=${page}`),
    request<{ state: string; statuses: unknown[]; total_count: number }>(token, `${path}/commits/${sha}/status?per_page=100&page=${page}`),
  ]);
  const checks = results[0];
  const statuses = results[1];
  return {
    sha: p.head.sha,
    checks: checks.status === "fulfilled" ? checks.value.check_runs : [],
    statuses: statuses.status === "fulfilled" ? statuses.value.statuses : [],
    hasMore: (checks.status === "fulfilled" && checks.value.total_count > page * 100)
      || (statuses.status === "fulfilled" && statuses.value.total_count > page * 100),
    errors: results.flatMap((r) => r.status === "rejected" ? [r.reason instanceof Error ? r.reason.message : "Couldn't load checks"] : []),
  };
}

export async function actOnPullRequest(token: string, slug: string, number: number, input: Record<string, unknown>) {
  const path = `/repos/${slug}`;
  const action = input.action;
  const body = typeof input.body === "string" ? input.body : "";
  const invalid = (message: string) => { throw Object.assign(new Error(message), { status: 400 }); };
  if (action === "code-comment") {
    if (!body.trim()) invalid("Enter a code comment");
    if (typeof input.path !== "string" || !input.path.trim()) invalid("A file path is required");
    if (!Number.isSafeInteger(input.line) || Number(input.line) < 1) invalid("Invalid diff line");
    if (input.side !== "LEFT" && input.side !== "RIGHT") invalid("Invalid diff side");
    if (!/^[a-f0-9]{40}$/i.test(String(input.sha))) invalid("A head commit is required");
    const current = await request<Pull>(token, `${path}/pulls/${number}`);
    if (current.head.sha !== input.sha) throw Object.assign(new Error("The pull request has new commits. Refresh the files before commenting."), { status: 409 });
    await request(token, `${path}/pulls/${number}/comments`, "POST", { body, commit_id: input.sha, path: input.path, line: input.line, side: input.side });
  } else if (action === "reply") {
    if (!body.trim()) invalid("Enter a reply");
    const commentId = Number(input.commentId);
    if (!Number.isSafeInteger(commentId) || commentId < 1) invalid("Invalid code comment");
    const reply = await request(token, `${path}/pulls/${number}/comments/${commentId}/replies`, "POST", { body });
    return { ok: true, reply };
  } else if (action === "comment") {
    if (!body.trim()) invalid("Enter a comment");
    await request(token, `${path}/issues/${number}/comments`, "POST", { body });
  } else if (action === "review") {
    if (!["APPROVE", "REQUEST_CHANGES", "COMMENT"].includes(String(input.event))) invalid("Invalid review event");
    if (input.event !== "APPROVE" && !body.trim()) invalid("Enter a review message");
    if (!/^[a-f0-9]{40}$/i.test(String(input.sha))) invalid("A head commit is required");
    await request(token, `${path}/pulls/${number}/reviews`, "POST", { body, event: input.event, commit_id: input.sha });
  } else if (action === "edit") {
    if (typeof input.title !== "string" || !input.title.trim()) invalid("Enter a title");
    await request(token, `${path}/pulls/${number}`, "PATCH", { title: String(input.title).trim(), body });
  } else if (action === "close" || action === "reopen") {
    await request(token, `${path}/pulls/${number}`, "PATCH", { state: action === "close" ? "closed" : "open" });
  } else if (action === "merge") {
    if (!["merge", "squash", "rebase"].includes(String(input.method))) invalid("Invalid merge method");
    if (!/^[a-f0-9]{40}$/i.test(String(input.sha))) invalid("A head commit is required");
    const customMessage = input.commitTitle !== undefined || input.commitMessage !== undefined;
    if (customMessage && input.method === "rebase") invalid("Rebase preserves individual commit messages");
    if (input.commitTitle !== undefined && (typeof input.commitTitle !== "string" || !input.commitTitle.trim() || /[\r\n]/.test(input.commitTitle))) invalid("Enter a single-line commit title");
    if (input.commitMessage !== undefined && typeof input.commitMessage !== "string") invalid("Invalid commit description");
    const result = await request<{ merged: boolean; message: string }>(token, `${path}/pulls/${number}/merge`, "PUT",
      { sha: input.sha, merge_method: input.method,
        ...(input.commitTitle !== undefined ? { commit_title: (input.commitTitle as string).trim() } : {}),
        ...(input.commitMessage !== undefined ? { commit_message: input.commitMessage } : {}),
      });
    if (!result.merged) throw Object.assign(new Error(result.message || "Pull request was not merged"), { status: 409 });
  } else {
    invalid("Unknown pull request action");
  }
  return { ok: true };
}
