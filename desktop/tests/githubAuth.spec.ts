import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { cleanupApp, launchApp, makeRepo, removeRepo, type TestApp } from "./helpers";

test.describe.serial("GitHub account connection", () => {
  let started: TestApp;
  let app: ElectronApplication;
  let window: Page;
  let repoDir = "";

  test.beforeAll(async () => {
    repoDir = makeRepo();
    started = await launchApp();
    app = started.app;
    window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");

    await window.getByRole("button", { name: "Open" }).first().click();
    await window.locator(".picker-form input").fill(repoDir);
    await window.locator(".picker-form button[type=submit]").click();
    await expect(window.getByText("first commit").first()).toBeVisible();
  });

  test.afterAll(async () => {
    await app?.close().catch(() => {});
    await cleanupApp(started);
    await removeRepo(repoDir);
  });

  test("chooses OAuth or PAT before showing either connection flow", async () => {
    await window.getByRole("button", { name: "Actions", exact: true }).click();
    await window.getByRole("button", { name: "Connect GitHub account…" }).click();

    const choice = window.getByRole("dialog", { name: "Connect GitHub account" });
    await expect(choice).toBeVisible();
    await expect(choice.getByRole("button", { name: /GitHub OAuth/ })).toBeVisible();
    await expect(choice.getByRole("button", { name: /Personal Access Token/ })).toBeVisible();

    await choice.getByRole("button", { name: /Personal Access Token/ }).click();
    const pat = window.getByRole("dialog", { name: "GitHub Personal Access Token" });
    await expect(pat.getByPlaceholder("ghp_… or github_pat_…")).toBeVisible();
    await pat.getByRole("button", { name: "Back" }).click();

    await choice.getByRole("button", { name: /GitHub OAuth/ }).click();
    const oauth = window.getByRole("dialog", { name: "GitHub OAuth" });
    await expect(oauth.getByRole("button", { name: "Continue with GitHub" })).toBeVisible();
    await oauth.getByRole("button", { name: "Close" }).click();
  });

  test("opens the connection choice above the Pull Request dialog", async () => {
    await window.getByRole("button", { name: "Actions", exact: true }).click();
    await window.getByRole("button", { name: "Create pull request…" }).click();
    const pullRequest = window.locator(".pr-dialog");
    await expect(pullRequest).toBeVisible();
    await pullRequest.getByRole("button", { name: "Connect GitHub account" }).click();

    const choice = window.getByRole("dialog", { name: "Connect GitHub account" });
    await choice.getByRole("button", { name: /Personal Access Token/ }).click();
    const pat = window.getByRole("dialog", { name: "GitHub Personal Access Token" });
    await expect(pat).toBeVisible();
    await pat.getByRole("button", { name: "Close" }).click();
    await pullRequest.getByRole("button", { name: "Close" }).click();
  });

  test("cancels an active flow on Back and completes an authorized flow", async () => {
    let intervalMs = 60_000;
    let cancellations = 0;
    await window.route("**/api/github/oauth/device", async (route) => {
      if (route.request().method() === "DELETE") {
        cancellations++;
        await route.fulfill({ json: { ok: true } });
        return;
      }
      await route.fulfill({
        json: {
          flowId: `flow-${intervalMs}`,
          userCode: "ABCD-EFGH",
          verificationUri: "https://github.com/login/device",
          verificationUriComplete: null,
          expiresAt: Date.now() + 900_000,
          intervalMs,
        },
      });
    });
    await window.route("**/api/github/oauth/poll", (route) => route.fulfill({
      json: {
        status: "complete",
        user: { login: "octocat", name: "The Octocat", avatarUrl: null },
      },
    }));

    await window.getByRole("button", { name: "Actions", exact: true }).click();
    await window.getByRole("button", { name: "Connect GitHub account…" }).click();
    const choice = window.getByRole("dialog", { name: "Connect GitHub account" });
    await choice.getByRole("button", { name: /GitHub OAuth/ }).click();
    let oauth = window.getByRole("dialog", { name: "GitHub OAuth" });
    await oauth.getByRole("button", { name: "Continue with GitHub" }).click();
    await expect(oauth.getByText("ABCD-EFGH")).toBeVisible();
    await expect(oauth.getByRole("button", { name: "Back" })).toBeEnabled();
    await oauth.getByRole("button", { name: "Back" }).click();
    await expect(choice).toBeVisible();
    await expect.poll(() => cancellations).toBe(1);

    await choice.getByRole("button", { name: /GitHub OAuth/ }).click();
    oauth = window.getByRole("dialog", { name: "GitHub OAuth" });
    await oauth.getByRole("button", { name: "Continue with GitHub" }).click();
    await expect(oauth.getByText("ABCD-EFGH")).toBeVisible();
    await oauth.getByRole("button", { name: "Close" }).click();
    await expect.poll(() => cancellations).toBe(2);

    await window.getByRole("button", { name: "Actions", exact: true }).click();
    await window.getByRole("button", { name: "Connect GitHub account…" }).click();
    await choice.getByRole("button", { name: /GitHub OAuth/ }).click();
    oauth = window.getByRole("dialog", { name: "GitHub OAuth" });
    intervalMs = 1;
    await oauth.getByRole("button", { name: "Continue with GitHub" }).click();
    await expect(oauth).toContainText("Signed in as @octocat");
    await oauth.getByRole("button", { name: "Done" }).click();

    await window.getByRole("button", { name: "Actions", exact: true }).click();
    await window.getByRole("button", { name: "GitHub: @octocat" }).click();
    await expect(window.getByRole("dialog", { name: "Connect GitHub account" })).toBeVisible();
  });
});
