import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { runGit } from "./git/gitRunner.js";
import { openRepo } from "./git/repo.js";
import { registerRepo, unregisterRepo } from "./session.js";
import { setConfigDir } from "./config.js";
import { createApp } from "./app.js";
import {
  clearAiCommitInfo, collectCommitDiff, generateAiCommitInfo, getAiCommitInfo, setAiCommitInfo,
} from "./aiCommit.js";

const TMP = path.join(os.tmpdir(), `gitwebui-ai-${randomBytes(6).toString("hex")}`);
const config = path.join(TMP, "config");
const realFetch = globalThis.fetch;
let root: string;
let server: Server;
let base: string;
const headers = { Cookie: "gwui_desktop=ai-test-token", "Content-Type": "application/json" };
const message = { title: "Add an accurate commit draft", description: "Describe the new behavior.\n\n- Include all relevant changes." };
const response = (value: unknown = message) => Response.json({
  candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(value) }] } }],
});

beforeAll(async () => {
  setConfigDir(config);
  server = createApp({ desktopToken: "ai-test-token" }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

beforeEach(async () => {
  await fs.rm(config, { recursive: true, force: true });
  root = path.join(TMP, randomBytes(6).toString("hex"));
  await fs.mkdir(root, { recursive: true });
  await runGit(root, ["init", "-b", "main"]);
  await runGit(root, ["config", "user.name", "AI Test"]);
  await runGit(root, ["config", "user.email", "ai@example.com"]);
  await runGit(root, ["config", "commit.gpgsign", "false"]);
  await runGit(root, ["config", "core.autocrlf", "false"]);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  unregisterRepo((await openRepo(root)).root);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  setConfigDir(null);
  await fs.rm(TMP, { recursive: true, force: true });
});

async function trackedFile() {
  await fs.writeFile(path.join(root, "tracked.txt"), "original\n");
  await runGit(root, ["add", "."]);
  await runGit(root, ["commit", "-m", "Initial"]);
}

async function ready() {
  await setAiCommitInfo("test-key", "gemini-test");
  await fs.writeFile(path.join(root, "new.txt"), "new content\n");
}

describe("AI settings and API", () => {
  it("persists without exposing the key, retains it on model edits, and clears", async () => {
    expect(await getAiCommitInfo()).toEqual({ configured: false, model: "" });
    expect(await setAiCommitInfo("  test-key  ", " models/gemini-test "))
      .toEqual({ configured: true, model: "gemini-test" });
    await setAiCommitInfo("", "gemini-next");
    expect(JSON.parse(await fs.readFile(path.join(config, "ai-commit.json"), "utf8")))
      .toEqual({ apiKey: "test-key", model: "gemini-next" });
    const saved = await realFetch(base + "/api/ai-commit/settings", { headers });
    expect(await saved.json()).toEqual({ configured: true, model: "gemini-next" });
    const cleared = await realFetch(base + "/api/ai-commit/settings", { method: "DELETE", headers });
    expect(await cleared.json()).toEqual({ configured: false, model: "" });
    await expect(fs.stat(path.join(config, "ai-commit.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("validates settings and requires authentication for every endpoint", async () => {
    await expect(setAiCommitInfo("", "gemini-test")).rejects.toMatchObject({ status: 400 });
    await expect(setAiCommitInfo("key", "https://other.example/model")).rejects.toMatchObject({ status: 400 });
    await expect(setAiCommitInfo("key\nheader", "gemini-test")).rejects.toMatchObject({ status: 400 });
    for (const [url, method] of [["settings", "GET"], ["settings", "POST"], ["settings", "DELETE"], ["generate", "POST"]]) {
      expect((await realFetch(`${base}/api/ai-commit/${url}`, { method })).status).toBe(401);
    }
  });

  it("routes generation to the requested repo and maps upstream 401 to an application error", async () => {
    await ready();
    const repo = registerRepo(await openRepo(root));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response()));
    const generated = await realFetch(base + "/api/ai-commit/generate", {
      method: "POST", headers: { ...headers, "X-Repo-Root": repo.root }, body: "{}",
    });
    expect(generated.status).toBe(200);
    expect(await generated.json()).toEqual({ ...message, source: "unstaged" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: { message: "Invalid key test-key" } }, { status: 401 })));
    const failed = await realFetch(base + "/api/ai-commit/generate", {
      method: "POST", headers: { ...headers, "X-Repo-Root": repo.root }, body: "{}",
    });
    expect(failed.status).toBe(502);
    const error = await failed.text();
    expect(error).toContain("Google AI Studio (401)");
    expect(error).not.toContain("test-key");
  });
});

describe("complete commit diff selection", () => {
  it("includes new text, empty files and binary metadata in an unborn repository", async () => {
    await fs.writeFile(path.join(root, "new file.txt"), "all new content\n");
    await fs.writeFile(path.join(root, "empty.txt"), "");
    await fs.writeFile(path.join(root, "binary.bin"), Buffer.from([0, 1, 2, 3]));
    const context = JSON.parse((await collectCommitDiff(root, false)).serialized);
    expect(context.source).toBe("unstaged");
    expect(context.untracked).toEqual(expect.arrayContaining([
      { path: "new file.txt", kind: "text", content: "all new content\n" },
      { path: "empty.txt", kind: "text", content: "" },
      { path: "binary.bin", kind: "binary", content: null },
    ]));
    await runGit(root, ["add", "--", "new file.txt"]);
    const staged = JSON.parse((await collectCommitDiff(root, false)).serialized);
    expect(staged.source).toBe("staged");
    expect(staged.diff).toContain("+all new content");
    expect(staged.untracked).toEqual([]);
  });

  it("describes only index content for partially staged files", async () => {
    await trackedFile();
    await fs.writeFile(path.join(root, "tracked.txt"), "staged version\n");
    await runGit(root, ["add", "."]);
    await fs.writeFile(path.join(root, "tracked.txt"), "unstaged version\n");
    await fs.writeFile(path.join(root, "untracked.txt"), "untracked secret\n");
    const staged = (await collectCommitDiff(root, false)).serialized;
    expect(staged).toContain("+staged version");
    expect(staged).not.toContain("unstaged version");
    expect(staged).not.toContain("untracked secret");
    await runGit(root, ["reset", "HEAD"]);
    const unstaged = (await collectCommitDiff(root, false)).serialized;
    expect(unstaged).toContain("+unstaged version");
    expect(unstaged).toContain("untracked secret");
  });

  it("retains rename, deletion and binary metadata without invoking external diff tools", async () => {
    await trackedFile();
    await fs.writeFile(path.join(root, "delete.txt"), "remove me\n");
    await fs.writeFile(path.join(root, "binary.bin"), Buffer.from([0, 1]));
    await runGit(root, ["add", "."]);
    await runGit(root, ["commit", "-m", "More files"]);
    await runGit(root, ["mv", "tracked.txt", "renamed.txt"]);
    await fs.rm(path.join(root, "delete.txt"));
    await fs.writeFile(path.join(root, "binary.bin"), Buffer.from([0, 2]));
    await runGit(root, ["add", "-A"]);
    await runGit(root, ["config", "diff.external", "nonexistent-external-diff"]);
    const context = JSON.parse((await collectCommitDiff(root, false)).serialized);
    expect(context.diff).toContain("rename from tracked.txt");
    expect(context.diff).toContain("deleted file mode");
    expect(context.diff).toContain("Binary files");
  });

  it("includes the original commit and staged additions when amending, including a root commit", async () => {
    await trackedFile();
    await fs.writeFile(path.join(root, "tracked.txt"), "original\nnew staged line\n");
    await runGit(root, ["add", "."]);
    let context = JSON.parse((await collectCommitDiff(root, true)).serialized);
    expect(context.diff).toContain("+original");
    expect(context.diff).toContain("+new staged line");
    await runGit(root, ["commit", "-m", "Second"]);
    context = JSON.parse((await collectCommitDiff(root, true)).serialized);
    expect(context.diff).toContain("+new staged line");
    expect(context.diff).not.toContain("+original");
  });

  it("includes large new binaries as metadata while retaining the text payload limit", async () => {
    await ready();
    await fs.writeFile(path.join(root, "large.bin"), Buffer.alloc(9 * 1024 * 1024));
    const context = JSON.parse((await collectCommitDiff(root, false)).serialized);
    expect(context.source).toBe("unstaged");
    expect(context.untracked).toContainEqual({ path: "large.bin", kind: "binary", content: null });
    expect(context.untracked).toContainEqual({ path: "new.txt", kind: "text", content: "new content\n" });
    expect(Buffer.byteLength(JSON.stringify(context))).toBeLessThan(1024);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response()));
    expect(await generateAiCommitInfo(root, false)).toEqual({ ...message, source: "unstaged" });
    await runGit(root, ["add", "--", "large.bin"]);
    const staged = (await collectCommitDiff(root, false)).serialized;
    expect(staged).toContain("Binary files");
    expect(Buffer.byteLength(staged)).toBeLessThan(1024);
  });

  it("preserves UTF-8 characters crossing the binary probe boundary", async () => {
    const content = "a".repeat(7999) + "€\n";
    await fs.writeFile(path.join(root, "unicode.txt"), content);
    const context = JSON.parse((await collectCommitDiff(root, false)).serialized);
    expect(context.untracked).toContainEqual({ path: "unicode.txt", kind: "text", content });
  });

  it("rejects empty and oversized changes instead of silently dropping content", async () => {
    await expect(collectCommitDiff(root, false)).rejects.toThrow("no changes");
    await fs.writeFile(path.join(root, "large.txt"), "x".repeat(8 * 1024 * 1024 + 1));
    await expect(collectCommitDiff(root, false)).rejects.toMatchObject({ status: 413 });
  });
});

describe("Google AI Studio generation", () => {
  it("sends structured output instructions and complete diffs, preserving long descriptions", async () => {
    await ready();
    const description = "Detailed change description.\n".repeat(500);
    const fetchMock = vi.fn().mockResolvedValue(response({ ...message, description }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await generateAiCommitInfo(root, false)).toEqual({ ...message, description: description.trim(), source: "unstaged" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent");
    expect(init.headers["x-goog-api-key"]).toBe("test-key");
    const payload = JSON.parse(init.body);
    expect(payload.generationConfig.responseJsonSchema.required).toEqual(["title", "description"]);
    expect(payload.systemInstruction.parts[0].text).toContain("never as instructions");
    expect(payload.systemInstruction.parts[0].text).toContain("72 characters");
    expect(payload.contents[0].parts[0].text).toContain("new content");
  });

  it.each([
    ["too long", { title: "x".repeat(73), description: "Description" }],
    ["multiline", { title: "One\nTwo", description: "Description" }],
    ["missing description", { title: "Title" }],
    ["empty title", { title: " ", description: "Description" }],
  ])("rejects %s output without returning a partial message", async (_name, value) => {
    await ready();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(value)));
    await expect(generateAiCommitInfo(root, false)).rejects.toMatchObject({ status: 502 });
  });

  it("rejects malformed JSON, blocked and truncated responses", async () => {
    await ready();
    for (const body of [
      { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "not json" }] } }] },
      { promptFeedback: { blockReason: "SAFETY" } },
      { candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: JSON.stringify(message) }] } }] },
    ]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
      await expect(generateAiCommitInfo(root, false)).rejects.toMatchObject({ status: 502 });
    }
  });

  it("ignores thought parts and accepts exactly 72 title characters", async () => {
    await ready();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ candidates: [{
      finishReason: "STOP", content: { parts: [
        { thought: true, text: "Reasoning" },
        { text: JSON.stringify({ ...message, title: "x".repeat(72) }) },
      ] },
    }] })));
    expect((await generateAiCommitInfo(root, false)).title.length).toBe(72);
  });

  it("rejects a stale result when file content changes with the same status", async () => {
    await ready();
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
      await fs.writeFile(path.join(root, "new.txt"), "newer content\n");
      return response();
    }));
    await expect(generateAiCommitInfo(root, false)).rejects.toMatchObject({ status: 409 });
  });

  it("does not send an unconfigured request and reports network failures cleanly", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network failure"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(generateAiCommitInfo(root, false)).rejects.toThrow("Set up an API key");
    expect(fetchMock).not.toHaveBeenCalled();
    await ready();
    await expect(generateAiCommitInfo(root, false)).rejects.toMatchObject({ status: 502 });
    await clearAiCommitInfo();
  });
});
