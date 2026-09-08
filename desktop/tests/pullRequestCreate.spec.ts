import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { launchApp, cleanupApp, makeRepo, removeRepo, type TestApp } from "./helpers";

test("creating from a different branch uses its fork alias and actual upstream branch name", async () => {
  const repo = makeRepo();
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("remote", "add", "origin", "https://github.com/team/fork.git");
  git("remote", "add", "fork-alias", "https://github.com/team/fork.git");
  git("remote", "add", "upstream", "https://github.com/team/project.git");
  git("update-ref", "refs/remotes/upstream/main", "HEAD");
  git("config", "branch.main.remote", "upstream");
  git("config", "branch.main.merge", "refs/heads/main");
  git("checkout", "-b", "local-feature");
  git("commit", "--allow-empty", "-m", "Add feature");
  git("update-ref", "refs/remotes/fork-alias/remote-feature", "HEAD");
  git("config", "branch.local-feature.remote", "fork-alias");
  git("config", "branch.local-feature.merge", "refs/heads/remote-feature");
  git("checkout", "main");
  let started: TestApp | undefined;
  try {
    started = await launchApp();
    await started.app.evaluate(({ shell }) => {
      shell.openExternal = async () => {};
      const original = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (!url.startsWith("https://api.github.com/")) return original(input, init);
        const pathname = new URL(url).pathname;
        if (pathname === "/user") return Response.json({ login: "viewer", id: 1 });
        if (pathname === "/user/emails") return Response.json([]);
        if (pathname === "/repos/team/fork" || pathname === "/repos/team/project") {
          const fork = pathname.endsWith("/fork");
          return Response.json({ full_name: fork ? "team/fork" : "team/project", name: fork ? "fork" : "project", owner: { login: "team" }, default_branch: "main", fork, parent: fork ? { full_name: "team/project" } : null });
        }
        if (pathname.endsWith("/branches")) return Response.json([{ name: "main" }]);
        if (pathname.endsWith("/pulls") && init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          if (pathname !== "/repos/team/project/pulls" || body.head !== "team:remote-feature" || body.head_repo !== "fork" || body.base !== "main") return Response.json({ message: "Wrong source repository or branch" }, { status: 422 });
          return Response.json({ number: 9, title: body.title, html_url: "https://github.com/team/project/pull/9" });
        }
        return Response.json([]);
      };
    });
    const window = await started.app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await window.evaluate(async () => {
      const response = await fetch("/api/github/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "test-token" }) });
      if (!response.ok) throw new Error(await response.text());
    });
    await window.reload();
    await window.getByRole("button", { name: "Open", exact: true }).first().click();
    await window.locator(".picker-form input").fill(repo);
    await window.locator(".picker-form button[type=submit]").click();
    await window.route("**/api/pr/meta?**", (route) => route.fulfill({ json: { collaborators: [], assignees: [], labels: [{ name: "needs-review", color: "abcdef" }] } }));
    await window.getByRole("button", { name: "Actions", exact: true }).click();
    await window.getByRole("button", { name: "Create pull request…" }).click();
    const dialog = window.locator(".pr-dialog");
    await expect(dialog.locator(".pr-repos select").nth(0)).toHaveValue("team/project");
    await dialog.getByRole("button", { name: "Add labels…" }).click();
    await dialog.getByRole("checkbox", { name: "needs-review" }).check();
    await dialog.getByLabel("Title", { exact: true }).click();
    await dialog.locator(".pr-repos select").nth(2).selectOption("local-feature");
    await expect(dialog.locator(".pr-repos select").nth(0)).toHaveValue("team/fork");
    await expect(dialog.locator(".pr-chip")).toHaveText(["needs-review"]);
    await dialog.getByLabel("Title", { exact: true }).fill("Add feature from fork");
    let releaseBranches: (() => Promise<void>) | undefined;
    await window.route("**/api/pr/branches?**", async (route) => {
      if (new URL(route.request().url()).searchParams.get("repo") !== "team/fork") return route.continue();
      await new Promise<void>((resolve) => {
        releaseBranches = async () => { await route.fulfill({ json: { branches: ["fork-main"] } }); resolve(); };
      });
    });
    await dialog.locator(".pr-repos select").nth(1).selectOption("team/fork");
    await expect(dialog.getByRole("button", { name: "Create Pull Request", exact: true })).toBeDisabled();
    await expect(dialog.locator(".pr-repos select").nth(3)).toBeDisabled();
    await expect(dialog.locator(".pr-repos select").nth(3).locator("option")).toHaveText(["Loading branches…"]);
    await expect.poll(() => !!releaseBranches).toBe(true);
    await releaseBranches!();
    await expect(dialog.locator(".pr-repos select").nth(3)).toHaveValue("fork-main");
    await dialog.locator(".pr-repos select").nth(1).selectOption("team/project");
    await expect(dialog.locator(".pr-repos select").nth(3)).toHaveValue("main");
    await dialog.getByRole("button", { name: "Create Pull Request", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(window.getByRole("status").filter({ hasText: "Opened pull request #9" })).toBeVisible();
  } finally {
    if (started) { await started.app.close(); await cleanupApp(started); }
    await removeRepo(repo);
  }
});
