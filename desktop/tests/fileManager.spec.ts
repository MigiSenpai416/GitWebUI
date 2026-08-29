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
    await fs.writeFile(path.join(repoDir, "private", "secret.txt"), "sensitive\nother sensitive\n");
    await fs.writeFile(path.join(repoDir, "keep.txt"), "keep\n");
    await fs.writeFile(path.join(repoDir, "removed.txt"), "historical only\n");
    await fs.writeFile(path.join(repoDir, "shape"), "historical file\n");
    await fs.mkdir(path.join(repoDir, "former"));
    await fs.writeFile(path.join(repoDir, "former", "old.txt"), "historical child\n");
    execFileSync("git", ["-C", repoDir, "add", "-A"], { stdio: "pipe" });
    execFileSync("git", ["-C", repoDir, "commit", "-m", "tracked files"], { stdio: "pipe" });
    await fs.rm(path.join(repoDir, "removed.txt"));
    await fs.rm(path.join(repoDir, "shape"));
    await fs.mkdir(path.join(repoDir, "shape"));
    await fs.writeFile(path.join(repoDir, "shape", "keep.txt"), "current child\n");
    await fs.rm(path.join(repoDir, "former"), { recursive: true });
    await fs.writeFile(path.join(repoDir, "former"), "current file\n");
    execFileSync("git", ["-C", repoDir, "add", "-A"], { stdio: "pipe" });
    execFileSync("git", ["-C", repoDir, "commit", "-m", "remove historical file"], { stdio: "pipe" });

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
    await expect(dialog.locator('.fm-row[title="keep.txt"] .fm-file-glyph svg')).toBeVisible();
    await expect(dialog.getByText("removed.txt", { exact: true })).toBeHidden();

    await dialog.getByRole("button", { name: /History paths/ }).click();
    const removed = dialog.locator('.fm-row[title="removed.txt"]');
    await expect(removed).toContainText("Not at HEAD");
    await removed.click({ button: "right" });
    await window.getByRole("menuitem", { name: "Delete file from history…" }).click();
    const historicalConfirm = window.getByRole("alertdialog", { name: "Confirm history rewrite" });
    await expect(historicalConfirm).toContainText("already absent from HEAD");
    await historicalConfirm.getByLabel("Type the exact repository path to confirm:").press("Escape");

    const shape = dialog.locator('.fm-row[title="shape"]');
    await expect(shape).toContainText("Folder + historical file");
    const viewport = await window.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    await shape.dispatchEvent("contextmenu", {
      button: 2,
      clientX: viewport.width - 1,
      clientY: viewport.height - 1,
    });
    const shapeMenu = window.getByRole("menu", { name: "Actions for shape" });
    const shapeMenuBox = await shapeMenu.boundingBox();
    expect(shapeMenuBox).not.toBeNull();
    expect(shapeMenuBox!.x + shapeMenuBox!.width).toBeLessThanOrEqual(viewport.width - 8);
    expect(shapeMenuBox!.y + shapeMenuBox!.height).toBeLessThanOrEqual(viewport.height - 8);
    await expect(window.getByRole("menuitem", { name: "Delete file only from history…" })).toBeVisible();
    await expect(window.getByRole("menuitem", { name: "Delete directory from history…" })).toBeVisible();
    await window.evaluate(() => dispatchEvent(new Event("resize")));
    await expect(shapeMenu).toBeHidden();
    await shape.click({ button: "right" });
    await window.getByRole("menuitem", { name: "Delete file only from history…" }).click();
    await expect(window.getByRole("alertdialog", { name: "Confirm history rewrite" })).toContainText(
      "a directory currently occupies the same path",
    );
    await window.keyboard.press("Escape");

    const former = dialog.locator('.fm-row[title="former"]');
    await expect(former).toContainText("Folder + file at HEAD");
    await former.click({ button: "right" });
    await expect(window.getByRole("menuitem", { name: "Open file" })).toBeVisible();
    await expect(window.getByRole("menuitem", { name: "Delete file only from history…" })).toBeVisible();
    await expect(window.getByRole("menuitem", { name: "Delete directory from history…" })).toBeVisible();
    await window.keyboard.press("Escape");

    await dialog.getByRole("button", { name: /History paths/ }).click();
    await expect(removed).toBeHidden();

    await dialog.getByText("private", { exact: true }).last().dblclick();
    await expect(dialog.getByText("secret.txt", { exact: true })).toBeVisible();

    const treeFolder = dialog.locator('.fm-tree-name[title="private"]');
    await treeFolder.click({ button: "right" });
    await window.getByRole("menuitem", { name: "Delete directory from history…" }).click();
    const confirm = window.getByRole("alertdialog", { name: "Confirm history rewrite" });
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText("requires git-filter-repo");
    await expect(confirm).toContainText("Unreachable old Git objects may remain until pruning");
    await expect(confirm).toContainText("Non-stash reflogs are cleared");
    await confirm.getByLabel("Type the exact repository path to confirm:").press("Escape");
    await expect(confirm).toBeHidden();
    await expect(treeFolder).toBeFocused();
  });

  test("opens a tracked file at HEAD in the searchable file view", async () => {
    const dialog = window.getByRole("dialog", { name: "File Manager" });
    await dialog.getByText("secret.txt", { exact: true }).dblclick();

    await expect(dialog).toBeVisible();
    const preview = dialog.getByRole("region", { name: "Preview private/secret.txt" });
    await expect(preview).toBeVisible();
    await expect(preview.locator(".fm-preview-path")).toContainText("private/secret.txt");
    await expect(preview.locator(".cm-content")).toContainText("sensitive");

    await window.keyboard.press("Control+f");
    const search = preview.getByRole("textbox", { name: "Find in file" });
    await search.fill("sensitive");
    await expect(preview.locator(".fm-preview-find-count")).toHaveText("1 of 2");
    await preview.getByRole("button", { name: "Next match" }).click();
    await expect(search).toBeFocused();
    await expect(preview.locator(".fm-preview-find-count")).toHaveText("2 of 2");

    const treeFolder = dialog.locator('.fm-tree-name[title="private"]');
    await treeFolder.click({ button: "right" });
    await window.getByRole("menuitem", { name: "Delete directory from history…" }).click();
    const confirm = window.getByRole("alertdialog", { name: "Confirm history rewrite" });
    const confirmation = confirm.getByLabel("Type the exact repository path to confirm:");
    await expect(confirmation).toBeFocused();
    await window.keyboard.press("Control+f");
    await expect(confirmation).toBeFocused();
    await window.keyboard.press("Escape");
    await expect(confirm).toBeHidden();
    await expect(preview).toBeVisible();
    await expect(search).toBeVisible();
    await window.keyboard.press("Escape");
    await expect(search).toBeHidden();
    await expect(preview).toBeVisible();

    await preview.getByRole("button", { name: "Close file preview" }).click();

    await expect(preview).toBeHidden();
    const secret = dialog.locator('.fm-row[title="private/secret.txt"]');
    await expect(secret).toBeFocused();
    await secret.press("Enter");
    await expect(preview).toBeVisible();
    await window.keyboard.press("Escape");
    await expect(preview).toBeHidden();
    await expect(secret).toBeFocused();
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
