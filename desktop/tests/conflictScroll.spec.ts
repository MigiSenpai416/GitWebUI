import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { cleanupApp, launchApp, makeRepo, removeRepo, type TestApp } from "./helpers";

const resolutions = [
  { name: "a-only", sides: ["A"], lines: ["ours one", "ours two"] },
  { name: "b-only", sides: ["B"], lines: ["theirs one"] },
  { name: "a-then-b", sides: ["A", "B"], lines: ["ours one", "ours two", "theirs one"] },
  { name: "b-then-a", sides: ["B", "A"], lines: ["theirs one", "ours one", "ours two"] },
];

test.describe.serial("conflict resolver scrolling", () => {
  let started: TestApp;
  let app: ElectronApplication;
  let window: Page;
  let repoDir = "";
  let context = "";

  test.beforeAll(async () => {
    repoDir = makeRepo();
    const git = (...args: string[]) => execFileSync("git", ["-C", repoDir, ...args], { stdio: "pipe" });
    git("config", "core.autocrlf", "false");
    context = Array.from({ length: 100 }, (_, i) => `context ${i + 1}`).join("\n");
    const write = async (first: string, last: string, short: string) => {
      await fs.writeFile(path.join(repoDir, "long.txt"), `${first}\n${context}\n${last}\n`);
      await fs.writeFile(path.join(repoDir, "short.txt"), `${short}\n`);
      for (const ending of ["lf", "crlf"]) {
        const eol = ending === "lf" ? "\n" : "\r\n";
        const lines = short === "base" ? ["original"] : short === "ours" ? ["ours one", "ours two"] : ["theirs one"];
        for (const resolution of resolutions) {
          await fs.writeFile(path.join(repoDir, `${resolution.name}-${ending}.txt`), ["before", ...lines, "after", ""].join(eol));
        }
      }
      git("add", ".");
      git("commit", "-m", short);
    };
    await write("base first", "base last", "base");
    git("checkout", "-b", "incoming");
    await write("incoming first", `${"incoming ".repeat(100)}END_B`, "incoming");
    git("checkout", "main");
    await write(`${"ours ".repeat(100)}END_A`, "ours last", "ours");
    expect(() => git("merge", "incoming")).toThrow();

    started = await launchApp();
    app = started.app;
    window = await app.firstWindow();
    await window.setViewportSize({ width: 1600, height: 1000 });
    await window.getByRole("button", { name: "Open" }).first().click();
    await window.locator(".picker-form input").fill(repoDir);
    await window.locator(".picker-form button[type=submit]").click();
    await window.locator('.cp-file[title="long.txt"]').click();
    await expect(window.locator(".cr-out-label")).toHaveCount(2);
  });

  test.afterAll(async () => {
    await app?.close().catch(() => {});
    await cleanupApp(started);
    await removeRepo(repoDir);
  });

  test("synchronizes all panes through long lines, navigation, choices and resizing", async () => {
    const grids = window.locator(".cr-grid");
    const offsets = () => grids.evaluateAll((elements) => elements.map((element) => ({
      left: element.scrollLeft,
      top: element.scrollTop,
      max: element.scrollWidth - element.clientWidth,
    })));
    const expectLeft = async (left: number) => {
      await expect.poll(async () => (await offsets()).map((offset) => offset.left)).toEqual([left, left, left]);
    };
    const initial = await offsets();
    const panesVisible = () => grids.evaluateAll((elements) => elements.every((element) =>
      element.getBoundingClientRect().bottom <= innerHeight,
    ));
    await expect.poll(panesVisible).toBe(true);
    expect(initial[0].max).toBeGreaterThan(1_000);
    expect(initial.map((offset) => offset.max)).toEqual([initial[0].max, initial[0].max, initial[0].max]);

    for (let i = 0; i < 3; i++) {
      const left = 200 * (i + 1);
      await grids.nth(i).evaluate((element, value) => { element.scrollLeft = value; }, left);
      await expectLeft(left);
      const top = 100 * (i + 1);
      await grids.nth(i).evaluate((element, value) => { element.scrollTop = value; }, top);
      await expect.poll(async () => (await offsets()).map((offset) => offset.top)).toEqual([top, top, top]);
      await expectLeft(left);
    }

    await window.getByTitle("Next conflict", { exact: true }).click();
    await expect.poll(async () => (await offsets())[0].top).toBeGreaterThan(1_000);
    const navigated = await offsets();
    expect(navigated.map((offset) => offset.top)).toEqual([navigated[0].top, navigated[0].top, navigated[0].top]);
    await expectLeft(600);
    await window.setViewportSize({ width: 1100, height: 900 });
    await expect.poll(panesVisible).toBe(true);
    await expect.poll(async () => (await offsets())[0].max).toBeGreaterThan(initial[0].max);
    await expectLeft(600);

    await grids.nth(1).evaluate((element) => { element.scrollLeft = element.scrollWidth; });
    const end = (await offsets())[1].max;
    await expectLeft(end);
    const tailVisible = await grids.nth(1).evaluate((element) => {
      const text = [...element.querySelectorAll(".cr-tx")].find((span) => span.textContent?.includes("END_B"))!;
      const bounds = text.getBoundingClientRect();
      const pane = element.getBoundingClientRect();
      return bounds.right <= pane.right && bounds.right > pane.left;
    });
    expect(tailVisible).toBe(true);

    await grids.nth(0).evaluate((element) => { element.scrollLeft = 0; });
    await expectLeft(0);
    await window.getByTitle("Keep side A", { exact: true }).first().click();
    await window.getByRole("button", { name: "Save", exact: true }).click();
    await expect(window.locator(".toast-notice")).toContainText("still unresolved");
    const partial = await fs.readFile(path.join(repoDir, "long.txt"), "utf8");
    expect(partial.match(/<<<<<<< HEAD/g)).toHaveLength(1);
    expect(partial).toContain("END_A");
    expect(execFileSync("git", ["-C", repoDir, "ls-files", "-u", "--", "long.txt"]).toString().trim().split("\n")).toHaveLength(3);
    await window.getByTitle("Keep side A", { exact: true }).last().click();
    await window.getByTitle("Keep side B", { exact: true }).last().click();
    const rowPositions = await grids.evaluateAll((elements) => elements.map((element) =>
      [...element.querySelectorAll<HTMLElement>(".cr-row")].map((row) => row.offsetTop),
    ));
    expect(rowPositions[1]).toEqual(rowPositions[0]);
    expect(rowPositions[2]).toEqual(rowPositions[0]);
    await window.getByTitle("Remove side A", { exact: true }).last().click();
    await window.getByTitle("Keep side A", { exact: true }).last().click();
    await expect.poll(() => grids.nth(2).locator(".cr-tx").evaluateAll((elements) =>
      elements.map((element) => element.textContent).join("\n"),
    )).toContain("END_B\nours last");
    await window.getByTitle("Remove side B", { exact: true }).last().click();
    await window.getByTitle("Keep side B", { exact: true }).last().click();
    await expect(window.getByRole("button", { name: "Save & mark resolved", exact: true })).toBeEnabled();
    await grids.nth(2).evaluate((element) => { element.scrollLeft = element.scrollWidth; });
    await expectLeft(end);
    await window.getByRole("button", { name: "Save & mark resolved", exact: true }).click();
    await expect(window.locator(".conflict-resolver")).toHaveCount(0);
    const saved = await fs.readFile(path.join(repoDir, "long.txt"), "utf8");
    expect(saved).toBe(`${"ours ".repeat(100)}END_A\n${context}\nours last\n${"incoming ".repeat(100)}END_B\n`);
    expect(execFileSync("git", ["-C", repoDir, "ls-files", "-u", "--", "long.txt"]).toString()).toBe("");
    expect(execFileSync("git", ["-C", repoDir, "show", ":long.txt"]).toString()).toBe(saved);
  });

  test("does not overflow horizontally when a newly opened file fits", async () => {
    await window.locator('.cp-file[title="short.txt"]').click();
    await expect(window.locator(".cr-out-label")).toHaveCount(1);
    const ranges = () => window.locator(".cr-grid").evaluateAll((elements) =>
      elements.map((element) => element.scrollWidth - element.clientWidth),
    );
    await expect.poll(ranges).toEqual([0, 0, 0]);
    await window.setViewportSize({ width: 1600, height: 1000 });
    await expect.poll(ranges).toEqual([0, 0, 0]);
  });

  for (const ending of ["lf", "crlf"]) {
    for (const { name, sides, lines } of resolutions) {
      test(`previews and stages ${name} with ${ending} line endings`, async () => {
        const file = `${name}-${ending}.txt`;
        if (await window.locator(".conflict-resolver").count()) {
          await window.getByTitle("Close (Esc)", { exact: true }).click();
        }
        await window.locator(`.cp-file[title="${file}"]`).click();
        await expect(window.locator(".cr-out-label")).toHaveCount(1);
        for (const side of sides) {
          await window.getByTitle(`Keep side ${side}`, { exact: true }).click();
        }
        const output = window.locator(".cr-out-grid");
        const preview = await output.locator(".cr-cell-full").evaluateAll((cells) => cells
          .filter((cell) => cell.querySelector(".cr-ln")!.textContent !== "")
          .map((cell) => {
            const text = cell.querySelector(".cr-tx")!.textContent!.replace(/\r/g, "");
            return text === " " ? "" : text;
          }),
        );
        expect(preview).toEqual(["before", ...lines, "after", ""]);
        for (const [side, cls, expected] of [
          ["A", "ours", ["ours one", "ours two"]],
          ["B", "theirs", ["theirs one"]],
        ] as const) {
          const colored = await output.locator(`.out-cell.${cls} .cr-tx`).evaluateAll((cells) =>
            cells.map((cell) => cell.textContent!.replace(/\r/g, "")),
          );
          expect(colored).toEqual(sides.includes(side) ? expected : []);
        }
        await window.getByRole("button", { name: "Save & mark resolved", exact: true }).click();
        await expect(window.locator(".conflict-resolver")).toHaveCount(0);
        const expected = ["before", ...lines, "after", ""].join(ending === "lf" ? "\n" : "\r\n");
        expect(await fs.readFile(path.join(repoDir, file), "utf8")).toBe(expected);
        expect(execFileSync("git", ["-C", repoDir, "ls-files", "-u", "--", file]).toString()).toBe("");
        expect(execFileSync("git", ["-C", repoDir, "show", `:${file}`]).toString()).toBe(expected);
        await expect(window.locator(`.cp-file.resolved[title="${file}"]`)).toBeVisible();
      });
    }
  }
});
