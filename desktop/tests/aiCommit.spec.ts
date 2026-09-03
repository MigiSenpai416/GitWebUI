import { test, expect, type ElectronApplication } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { cleanupApp, launchApp, makeRepo, removeRepo, type TestApp } from "./helpers";

interface AiTestState {
  requests: Array<{ contents: Array<{ parts: Array<{ text: string }> }> }>;
  openedUrls: string[];
  mode: "success" | "error" | "slow";
  release?: () => void;
}

interface AiProviderTestState {
  requests: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }>;
}

test("AI settings persist and all compose controls populate the current draft safely", async () => {
  const repoDir = makeRepo();
  let started: TestApp | undefined;
  let app: ElectronApplication | undefined;
  try {
    await fs.writeFile(path.join(repoDir, "new.txt"), "A new feature\n");
    started = await launchApp();
    app = started.app;
    let window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await window.getByRole("button", { name: "Open", exact: true }).first().click();
    await window.locator(".picker-form input").fill(repoDir);
    await window.locator(".picker-form button[type=submit]").click();
    await expect(window.locator(".changes-title")).toContainText("1 file change");

    await app.evaluate(({ shell }) => {
      const state: AiTestState = { requests: [], openedUrls: [], mode: "success" };
      (globalThis as unknown as { aiTest: AiTestState }).aiTest = state;
      shell.openExternal = async (url) => { state.openedUrls.push(url); };
      const original = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        if (!String(input).startsWith("https://generativelanguage.googleapis.com/")) return original(input, init);
        state.requests.push(JSON.parse(String(init?.body)));
        if (state.mode === "slow") await new Promise<void>((resolve) => { state.release = resolve; });
        if (state.mode === "error") return Response.json({ error: { message: "Test quota exceeded" } }, { status: 429 });
        return Response.json({ candidates: [{
          finishReason: "STOP",
          content: { parts: [{ text: JSON.stringify({
            title: `Describe feature changes ${state.requests.length}`,
            description: "Add the feature described by the diff.\n\n- Include the relevant implementation details.",
          }) }] },
        }] });
      };
    });

    await window.locator(".ai-btn").click();
    const dialog = window.getByRole("dialog", { name: "Set Up AI Commit Info" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("link", { name: "Create API Key", exact: true }).click();
    await expect.poll(() => app!.evaluate(() => (globalThis as unknown as { aiTest: AiTestState }).aiTest.openedUrls))
      .toEqual(["https://aistudio.google.com/api-keys"]);
    await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await dialog.getByLabel("API key").fill("test-key");
    await expect(dialog.getByLabel("API key")).toHaveAttribute("type", "password");
    await dialog.getByLabel("Model slug").fill("gemini-test");
    await window.screenshot({ path: test.info().outputPath("ai-settings.png") });
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toBeHidden();

    const summary = window.getByPlaceholder("Commit summary");
    const description = window.getByPlaceholder("Description", { exact: true });
    for (const [index, selector] of [".ai-btn", ".summary-ai", ".compose-ai"].entries()) {
      await window.locator(selector).click();
      await expect(summary).toHaveValue(`Describe feature changes ${index + 1}`);
      await expect(description).toHaveValue(/implementation details/);
    }
    const firstDiff = await app.evaluate(() => {
      const state = (globalThis as unknown as { aiTest: AiTestState }).aiTest;
      return JSON.parse(state.requests[0].contents[0].parts[0].text);
    });
    expect(firstDiff.source).toBe("unstaged");
    expect(firstDiff.untracked[0].content).toBe("A new feature\n");
    await expect(summary).toHaveAttribute("maxlength", "72");

    await window.getByRole("button", { name: "Stage All Changes", exact: true }).click();
    await expect(window.locator(".summary-ai")).toHaveAttribute("title", /from staged changes/);
    await fs.writeFile(path.join(repoDir, "new.txt"), "Unstaged replacement\n");
    await window.locator(".summary-ai").click();
    await expect(summary).toHaveValue("Describe feature changes 4");
    const stagedDiff = await app.evaluate(() => {
      const state = (globalThis as unknown as { aiTest: AiTestState }).aiTest;
      return state.requests[3].contents[0].parts[0].text;
    });
    expect(stagedDiff).toContain("+A new feature");
    expect(stagedDiff).not.toContain("Unstaged replacement");

    await app.evaluate(() => { (globalThis as unknown as { aiTest: AiTestState }).aiTest.mode = "error"; });
    await window.locator(".compose-ai").click();
    await expect(window.getByText(/Test quota exceeded/)).toBeVisible();
    await expect(summary).toHaveValue("Describe feature changes 4");
    await expect(window.locator(".app")).toBeVisible();

    await app.evaluate(() => { (globalThis as unknown as { aiTest: AiTestState }).aiTest.mode = "slow"; });
    await window.locator(".ai-btn").click();
    await expect(window.locator(".compose-ai")).toContainText("Generating");
    await expect(window.locator(".summary-ai")).toBeDisabled();
    await expect(window.locator(".commit-submit")).toBeDisabled();
    await expect.poll(() => app!.evaluate(() => !!(globalThis as unknown as { aiTest: AiTestState }).aiTest.release)).toBe(true);
    await summary.fill("My newer draft");
    await app.evaluate(() => { (globalThis as unknown as { aiTest: AiTestState }).aiTest.release?.(); });
    await expect(window.locator(".summary-ai")).toBeEnabled();
    await expect(summary).toHaveValue("My newer draft");

    await window.getByRole("button", { name: "Actions", exact: true }).click();
    await window.getByRole("button", { name: "Set Up AI Commit Info", exact: true }).click();
    await expect(dialog.getByLabel("API key")).toHaveValue("");
    await expect(dialog.getByLabel("API key")).toHaveAttribute("placeholder", /Key saved/);
    await expect(dialog.getByLabel("Model slug")).toHaveValue("gemini-test");
    await dialog.getByLabel("Model slug").fill("models/gemini-next");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toBeHidden();

    await app.close();
    app = undefined;
    app = (await launchApp({ reuse: started })).app;
    window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await window.getByRole("button", { name: "Actions", exact: true }).click();
    await window.getByRole("button", { name: "Set Up AI Commit Info", exact: true }).click();
    const restored = window.getByRole("dialog", { name: "Set Up AI Commit Info" });
    await expect(restored.getByLabel("Model slug")).toHaveValue("gemini-next");
    await expect(restored.getByLabel("API key")).toHaveValue("");
    await restored.getByRole("button", { name: "Clear", exact: true }).click();
    await expect(restored).toBeHidden();
    await window.locator(".summary-ai").click();
    await expect(restored).toBeVisible();
    await expect(restored.getByLabel("Model slug")).toHaveValue("");
    expect(execFileSync("git", ["-C", repoDir, "log", "--format=%s"], { encoding: "utf8" }).trim()).toBe("first commit");
  } finally {
    if (app) await app.close();
    if (started) await cleanupApp(started);
    await removeRepo(repoDir);
  }
});

test("generated messages commit staged changes and preserve amend draft behavior", async () => {
  const repoDir = makeRepo();
  const git = (...args: string[]) => execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8" }).trim();
  let started: TestApp | undefined;
  let app: ElectronApplication | undefined;
  try {
    await fs.writeFile(path.join(repoDir, "feature.txt"), "staged feature\n");
    git("add", "--", "feature.txt");
    await fs.writeFile(path.join(repoDir, "feature.txt"), "later unstaged edit\n");
    started = await launchApp();
    app = started.app;
    await fs.mkdir(started.configDir, { recursive: true });
    await fs.writeFile(path.join(started.configDir, "ai-commit.json"), JSON.stringify({ apiKey: "test-key", model: "gemini-test" }));
    await app.evaluate(() => {
      const original = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        if (!String(input).startsWith("https://generativelanguage.googleapis.com/")) return original(input, init);
        const payload = JSON.parse(String(init?.body));
        const context = JSON.parse(payload.contents[0].parts[0].text);
        return Response.json({ candidates: [{
          finishReason: "STOP",
          content: { parts: [{ text: JSON.stringify({
            title: context.amend ? "Clarify the feature implementation" : "Add the feature implementation",
            description: "Include the staged feature.\n\n- Keep subsequent edits for a later commit.",
          }) }] },
        }] });
      };
    });
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await window.getByRole("button", { name: "Open", exact: true }).first().click();
    await window.locator(".picker-form input").fill(repoDir);
    await window.locator(".picker-form button[type=submit]").click();
    const summary = window.getByPlaceholder("Commit summary");
    const description = window.getByPlaceholder("Description", { exact: true });
    await expect(window.locator(".summary-ai")).toHaveAttribute("title", /from staged changes/);
    await window.locator(".summary-ai").click();
    await expect(summary).toHaveValue("Add the feature implementation");
    await window.locator(".commit-submit").click();
    await expect(summary).toHaveValue("");
    expect(git("log", "-1", "--format=%s")).toBe("Add the feature implementation");
    expect(git("log", "-1", "--format=%b")).toContain("Keep subsequent edits");
    expect(git("show", "HEAD:feature.txt")).toBe("staged feature");
    expect(git("diff", "--", "feature.txt")).toContain("+later unstaged edit");
    const previousHead = git("rev-parse", "HEAD");

    await summary.fill("Keep my next commit draft");
    await description.fill("Restore this description after leaving amend.");
    await window.getByLabel("Amend previous commit").check();
    await expect(summary).toHaveValue("Add the feature implementation");
    await window.locator(".compose-ai").click();
    await expect(summary).toHaveValue("Clarify the feature implementation");
    await window.getByLabel("Amend previous commit").uncheck();
    await expect(summary).toHaveValue("Keep my next commit draft");
    await expect(description).toHaveValue("Restore this description after leaving amend.");

    await window.getByLabel("Amend previous commit").check();
    await window.locator(".compose-ai").click();
    await expect(summary).toHaveValue("Clarify the feature implementation");
    await description.press("Control+Enter");
    await expect(summary).toHaveValue("");
    await expect(window.getByLabel("Amend previous commit")).not.toBeChecked();
    expect(git("rev-parse", "HEAD")).not.toBe(previousHead);
    expect(git("rev-list", "--count", "HEAD")).toBe("2");
    expect(git("log", "-1", "--format=%s")).toBe("Clarify the feature implementation");
    expect(git("show", "HEAD:feature.txt")).toBe("staged feature");
    expect(git("diff", "--", "feature.txt")).toContain("+later unstaged edit");
  } finally {
    if (app) await app.close();
    if (started) await cleanupApp(started);
    await removeRepo(repoDir);
  }
});

test("provider selection preserves Google settings and uses Chat Completions for all AI controls", async () => {
  const repoDir = makeRepo();
  let started: TestApp | undefined;
  let app: ElectronApplication | undefined;
  try {
    await fs.writeFile(path.join(repoDir, "new.txt"), "A new feature\n");
    started = await launchApp();
    app = started.app;
    await fs.mkdir(started.configDir, { recursive: true });
    await fs.writeFile(path.join(started.configDir, "ai-commit.json"), JSON.stringify({ apiKey: "legacy-key", model: "gemini-legacy" }));
    await app.evaluate(() => {
      const state: AiProviderTestState = { requests: [] };
      (globalThis as unknown as { aiProviderTest: AiProviderTestState }).aiProviderTest = state;
      const original = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const url = String(input);
        const google = url.startsWith("https://generativelanguage.googleapis.com/");
        if (!google && !url.startsWith("https://compatible.example/")) return original(input, init);
        state.requests.push({ url, headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
        const content = JSON.stringify({
          title: google ? "Google commit draft" : `Chat commit draft ${state.requests.length}`,
          description: "Describe the feature changes from the complete diff.",
        });
        return Response.json(google
          ? { candidates: [{ finishReason: "STOP", content: { parts: [{ text: content }] } }] }
          : { choices: [{ finish_reason: "stop", message: { role: "assistant", content } }] });
      };
    });
    let window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await window.getByRole("button", { name: "Open", exact: true }).first().click();
    await window.locator(".picker-form input").fill(repoDir);
    await window.locator(".picker-form button[type=submit]").click();
    const openSettings = async () => {
      await window.getByRole("button", { name: "Actions", exact: true }).click();
      await window.getByRole("button", { name: "Set Up AI Commit Info", exact: true }).click();
    };
    await openSettings();
    let dialog = window.getByRole("dialog", { name: "Set Up AI Commit Info" });
    await expect(dialog.getByRole("tab", { name: "Google AI Studio" })).toHaveAttribute("aria-selected", "true");
    await expect(dialog.getByLabel("Model slug")).toHaveValue("gemini-legacy");
    await expect(dialog.getByLabel("Base URL")).toHaveCount(0);
    await expect(dialog.getByRole("link", { name: "Create API Key" })).toBeVisible();
    await window.screenshot({ path: test.info().outputPath("google-provider.png") });

    await dialog.getByRole("tab", { name: "OpenAI Chat Completions" }).click();
    await expect(dialog.getByRole("link", { name: "Create API Key" })).toHaveCount(0);
    await expect(dialog.getByLabel("Base URL")).toHaveValue("https://api.openai.com/v1");
    await expect(dialog.getByLabel("Model slug")).toHaveValue("");
    await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await dialog.getByLabel("Base URL").fill("https://compatible.example/api/v1/");
    await dialog.getByLabel("API key").fill("chat-key");
    await dialog.getByLabel("Model slug").fill("vendor/model:free");
    await dialog.getByRole("tab", { name: "Google AI Studio" }).click();
    await expect(dialog.getByLabel("Model slug")).toHaveValue("gemini-legacy");
    await expect(dialog.getByLabel("API key")).toHaveValue("");
    await dialog.getByRole("tab", { name: "OpenAI Chat Completions" }).click();
    await expect(dialog.getByLabel("Model slug")).toHaveValue("vendor/model:free");
    await expect(dialog.getByLabel("API key")).toHaveValue("chat-key");
    await window.screenshot({ path: test.info().outputPath("chat-provider.png") });
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toBeHidden();

    const summary = window.getByPlaceholder("Commit summary");
    for (const [index, selector] of [".ai-btn", ".summary-ai", ".compose-ai"].entries()) {
      await window.locator(selector).click();
      await expect(summary).toHaveValue(`Chat commit draft ${index + 1}`);
      await expect(window.getByPlaceholder("Description", { exact: true })).toHaveValue(/complete diff/);
    }
    const requests = await app.evaluate(() => (globalThis as unknown as { aiProviderTest: AiProviderTestState }).aiProviderTest.requests);
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(request.url).toBe("https://compatible.example/api/v1/chat/completions");
      expect(request.headers.Authorization).toBe("Bearer chat-key");
      expect(request.headers["x-goog-api-key"]).toBeUndefined();
      expect(request.body).toMatchObject({
        model: "vendor/model:free", stream: false,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "commit_message", strict: true,
            schema: { type: "object", required: ["title", "description"], additionalProperties: false },
          },
        },
      });
      expect(JSON.stringify(request.body.messages)).toContain("A new feature");
    }

    await openSettings();
    await expect(dialog.getByRole("tab", { name: "OpenAI Chat Completions" })).toHaveAttribute("aria-selected", "true");
    await expect(dialog.getByLabel("API key")).toHaveValue("");
    await dialog.getByLabel("Base URL").fill("https://different.example/v1");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("Re-enter the API key");
    const initialSize = await app.evaluate(({ BrowserWindow }) => {
      const current = BrowserWindow.getAllWindows()[0];
      const size = current.getSize();
      current.setSize(900, 560);
      return size;
    });
    await expect.poll(() => window.evaluate(() => innerHeight)).toBeLessThanOrEqual(560);
    await window.screenshot({ path: test.info().outputPath("chat-provider-small-window.png") });
    const bounds = await dialog.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, viewportHeight: innerHeight };
    });
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewportHeight);
    await dialog.getByRole("button", { name: "Save", exact: true }).scrollIntoViewIfNeeded();
    await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeInViewport();
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]), initialSize);
    await dialog.getByLabel("Base URL").fill("https://compatible.example/api/v1");
    await dialog.getByLabel("Model slug").fill("vendor/new-model");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toBeHidden();
    await openSettings();
    await dialog.getByRole("tab", { name: "Google AI Studio" }).click();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await window.locator(".summary-ai").click();
    await expect(summary).toHaveValue("Chat commit draft 4");
    await openSettings();
    await dialog.getByRole("tab", { name: "Google AI Studio" }).click();
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toBeHidden();
    await window.locator(".summary-ai").click();
    await expect(summary).toHaveValue("Google commit draft");
    const google = await app.evaluate(() => (globalThis as unknown as { aiProviderTest: AiProviderTestState }).aiProviderTest.requests.at(-1));
    expect(google?.headers["x-goog-api-key"]).toBe("legacy-key");
    expect(google?.body.generationConfig).toBeDefined();
    await openSettings();
    await dialog.getByRole("tab", { name: "OpenAI Chat Completions" }).click();
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toBeHidden();

    await app.close();
    app = undefined;
    app = (await launchApp({ reuse: started })).app;
    window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await openSettings();
    dialog = window.getByRole("dialog", { name: "Set Up AI Commit Info" });
    await expect(dialog.getByRole("tab", { name: "OpenAI Chat Completions" })).toHaveAttribute("aria-selected", "true");
    await expect(dialog.getByLabel("Model slug")).toHaveValue("vendor/new-model");
    await expect(dialog.getByLabel("Base URL")).toHaveValue("https://compatible.example/api/v1");
    await expect(dialog.getByLabel("API key")).toHaveValue("");
    await dialog.getByRole("button", { name: "Clear", exact: true }).click();
    await expect(dialog).toBeHidden();
    await openSettings();
    await expect(dialog.getByLabel("Model slug")).toHaveValue("");
    await dialog.getByRole("tab", { name: "Google AI Studio" }).click();
    await expect(dialog.getByLabel("Model slug")).toHaveValue("gemini-legacy");
    await expect(dialog.getByLabel("API key")).toHaveAttribute("placeholder", /Key saved/);
  } finally {
    if (app) await app.close();
    if (started) await cleanupApp(started);
    await removeRepo(repoDir);
  }
});
