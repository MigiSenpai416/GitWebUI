import { promises as fs } from "node:fs";
import path from "node:path";
import { getRemotes } from "./remote.js";
import { parseGitHubSlug } from "../github.js";

/**
 * Repo-side facts the Create Pull Request dialog needs: which remotes point at
 * GitHub, and which pull-request templates the working tree ships. Everything
 * that talks to the GitHub API lives in ../github.ts; this module only reads the
 * local repository.
 */

export interface GitHubRemote {
  /** Remote name, e.g. "origin". */
  remote: string;
  owner: string;
  repo: string;
  url: string;
}

export interface PrTemplate {
  /** Repo-relative path, e.g. ".github/pull_request_template.md". */
  path: string;
  /** File name shown in the picker. */
  name: string;
}

/** Max template size to read — templates are prose, anything larger is a mistake. */
const MAX_TEMPLATE_BYTES = 64 * 1024;

/** Directories that may hold several named templates. */
const TEMPLATE_DIRS = [
  ".github/PULL_REQUEST_TEMPLATE",
  "PULL_REQUEST_TEMPLATE",
  "docs/PULL_REQUEST_TEMPLATE",
];

/** Directories that may hold a single default template. */
const TEMPLATE_ROOTS = [".github", "", "docs"];

const TEMPLATE_BASENAMES = [
  "pull_request_template.md",
  "pull_request_template.markdown",
  "pull_request_template.txt",
];

const TEMPLATE_EXTENSIONS = [".md", ".markdown", ".txt"];

/**
 * The repo's GitHub remotes, de-duplicated by owner/repo with `origin` first —
 * the order the From/To repo pickers present them in. Non-GitHub remotes are
 * dropped.
 */
export async function githubRemotes(root: string): Promise<GitHubRemote[]> {
  const remotes = await getRemotes(root);
  const seen = new Set<string>();
  const out: GitHubRemote[] = [];
  for (const r of remotes) {
    const slug = parseGitHubSlug(r.url);
    if (!slug) continue;
    const key = `${slug.owner}/${slug.repo}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ remote: r.name, owner: slug.owner, repo: slug.repo, url: r.url });
  }
  out.sort((a, b) => Number(b.remote === "origin") - Number(a.remote === "origin"));
  return out;
}

/** List a directory, treating "missing" as "empty". */
async function readDirSafe(abs: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(abs, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Every pull-request template in the working tree, in GitHub's own lookup order:
 * the multi-template directories first, then the single-file form at `.github/`,
 * the repo root, and `docs/`. Matching is case-insensitive, so both
 * `PULL_REQUEST_TEMPLATE.md` and `pull_request_template.md` are found.
 */
export async function findPullRequestTemplates(root: string): Promise<PrTemplate[]> {
  const found: PrTemplate[] = [];
  const seen = new Set<string>();

  const add = (relPath: string, name: string) => {
    const key = relPath.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ path: relPath, name });
  };

  for (const dir of TEMPLATE_DIRS) {
    const names = await readDirSafe(path.join(root, ...dir.split("/")));
    for (const name of names.sort()) {
      if (!TEMPLATE_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext))) continue;
      add(`${dir}/${name}`, name);
    }
  }

  for (const dir of TEMPLATE_ROOTS) {
    const abs = dir ? path.join(root, ...dir.split("/")) : root;
    for (const name of await readDirSafe(abs)) {
      if (!TEMPLATE_BASENAMES.includes(name.toLowerCase())) continue;
      add(dir ? `${dir}/${name}` : name, name);
    }
  }

  return found;
}

/**
 * Read one discovered template. The path must be one `findPullRequestTemplates`
 * returned — a whitelist check, so no traversal or absolute path can escape the
 * repository regardless of what the client sends.
 */
export async function readPullRequestTemplate(root: string, relPath: string): Promise<string> {
  const wanted = (relPath ?? "").trim().replace(/\\/g, "/");
  const templates = await findPullRequestTemplates(root);
  const match = templates.find((t) => t.path.toLowerCase() === wanted.toLowerCase());
  if (!match) {
    throw Object.assign(new Error("Unknown pull request template"), { status: 400 });
  }
  const abs = path.join(root, ...match.path.split("/"));
  const buf = await fs.readFile(abs);
  return buf.subarray(0, MAX_TEMPLATE_BYTES).toString("utf8");
}
