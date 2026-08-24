import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { cleanupApp, launchApp, makeRepo, removeRepo, type TestApp } from "./helpers";

test.describe.serial("File Manager history deletion", () => {
  let started: TestApp;
  let app: ElectronApplication;
  let window: Page;
  let repoDir = "";

  test.beforeAll(async () => {
    repoDir = makeRepo();
    await fs.mkdir(path.join(repoDir, "private"), { recursive: true });
    await fs.writeFile(path.join(repoDir, "private", "secret.txt"), "sensitive\n");
    await fs.writeFile(path.join(repoDir, "keep.txt"), "keep\n");
    execFileSync("git", ["-C", repoDir, "add", "-A"], { stdio: "pipe" });
    execFileSync("git", ["-C", repoDir, "commit", "-m", "tracked files"], { stdio: "pipe" });

    started = await launchApp();
    app = started.app;
    window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");

    await window.getByRole("button", { name: "Open" }).first().click();
    await window.locator(".picker-form input").fill(repoDir);
    await window.locator(".picker-form button[type=submit]").click();
    await expect(window.getByText("tracked files").first()).toBeVisible();
  });

  test.afterAll(async () => {
    await app?.close().catch(() => {});
    await cleanupApp(started);
    await removeRepo(repoDir);
  });

  test("places the button before Actions and browses the current HEAD tree", async () => {
    const fileManager = window.getByRole("button", { name: "File Manager", exact: true });
    const actions = window.getByRole("button", { name: "Actions", exact: true });
    await expect(fileManager).toBeVisible();
    const fmBox = await fileManager.boundingBox();
    const actionsBox = await actions.boundingBox();
    expect(fmBox).not.toBeNull();
    expect(actionsBox).not.toBeNull();
    expect(fmBox!.x).toBeLessThan(actionsBox!.x);

    await fileManager.click();
    const dialog = window.getByRole("dialog", { name: "File Manager" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("private", { exact: true }).last()).toBeVisible();
    await expect(dialog.getByText("keep.txt", { exact: true })).toBeVisible();

    await dialog.getByText("private", { exact: true }).last().dblclick();
    await expect(dialog.getByText("secret.txt", { exact: true })).toBeVisible();

    const treeFolder = dialog.locator('.fm-tree-name[title="private"]');
    await treeFolder.click({ button: "right" });
    await window.getByRole("menuitem", { name: "Delete directory from history…" }).click();
    const confirm = window.getByRole("alertdialog", { name: "Confirm history rewrite" });
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText("Unreachable old Git objects may remain until pruning");
    await expect(confirm).toContainText("Non-stash reflogs are cleared");
    await confirm.getByLabel("Type the exact repository path to confirm:").press("Escape");
    await expect(confirm).toBeHidden();
    await expect(treeFolder).toBeFocused();
  });

  test("requires exact typed confirmation and deletes through the UI", async () => {
    const secret = window.getByRole("dialog", { name: "File Manager" }).getByText("secret.txt", { exact: true });
    await secret.click({ button: "right" });
    await window.getByRole("menuitem", { name: "Delete file from history…" }).click();

    const confirm = window.getByRole("alertdialog", { name: "Confirm history rewrite" });
    await expect(confirm).toBeVisible();
    const destructive = confirm.getByRole("button", { name: "Delete from all history" });
    await expect(destructive).toBeDisabled();
    const field = confirm.getByLabel("Type the exact repository path to confirm:");
    await field.fill("wrong");
    await expect(destructive).toBeDisabled();
    await field.fill("private/secret.txt");
    await expect(destructive).toBeEnabled();
    await destructive.click();

    await expect(window.locator(".fm-result")).toContainText("Removed private/secret.txt from", {
      timeout: 30_000,
    });
    await expect(window.getByRole("dialog", { name: "File Manager" })).toBeFocused();
    await expect(fs.access(path.join(repoDir, "private", "secret.txt"))).rejects.toThrow();
    expect(
      execFileSync(
        "git",
        ["-C", repoDir, "log", "--all", "--format=%H", "--", ":(literal)private/secret.txt"],
        { encoding: "utf8" },
      ).trim(),
    ).toBe("");
    expect(await fs.readFile(path.join(repoDir, "keep.txt"), "utf8")).toBe("keep\n");
  });
});
