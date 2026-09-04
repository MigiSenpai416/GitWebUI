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
import type { CommitPart } from "./aiCommitChunks.js";

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
const chatBody = (value: unknown = message) => ({
  choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(value) } }],
});
let providerRequest: { authorization?: string; body: Record<string, unknown> } | null = null;

beforeAll(async () => {
  setConfigDir(config);
  const app = createApp({ desktopToken: "ai-test-token" });
  app.post("/compatible/v1/chat/completions", (req, res) => {
    providerRequest = { authorization: req.headers.authorization, body: req.body };
    res.json(chatBody());
  });
  server = app.listen(0, "127.0.0.1");
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
    expect(await getAiCommitInfo()).toMatchObject({ configured: false, model: "", provider: "google" });
    expect(await setAiCommitInfo("  test-key  ", " models/gemini-test "))
      .toMatchObject({ configured: true, model: "gemini-test", provider: "google" });
    await setAiCommitInfo("", "gemini-next");
    expect(JSON.parse(await fs.readFile(path.join(config, "ai-commit.json"), "utf8")))
      .toMatchObject({ provider: "google", google: { apiKey: "test-key", model: "gemini-next" } });
    const saved = await realFetch(base + "/api/ai-commit/settings", { headers });
    const info = await saved.json();
    expect(info).toMatchObject({ configured: true, model: "gemini-next" });
    expect(JSON.stringify(info)).not.toContain("test-key");
    const cleared = await realFetch(base + "/api/ai-commit/settings", { method: "DELETE", headers });
    expect(await cleared.json()).toMatchObject({ configured: false, model: "" });
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
    expect(await generated.json()).toEqual({ ...message, source: "unstaged", chunked: false });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: { message: "Invalid key test-key" } }, { status: 401 })));
    const failed = await realFetch(base + "/api/ai-commit/generate", {
      method: "POST", headers: { ...headers, "X-Repo-Root": repo.root }, body: "{}",
    });
    expect(failed.status).toBe(502);
    const error = await failed.text();
    expect(error).toContain("Google AI Studio (401)");
    expect(error).not.toContain("test-key");
  });

  it("loads legacy Google settings and keeps both provider profiles through switching and clearing", async () => {
    await fs.mkdir(config, { recursive: true });
    await fs.writeFile(path.join(config, "ai-commit.json"), JSON.stringify({ apiKey: "legacy-key", model: "gemini-legacy" }));
    expect(await getAiCommitInfo()).toMatchObject({
      provider: "google", configured: true, model: "gemini-legacy",
      profiles: { google: { configured: true, model: "gemini-legacy" }, openai: { configured: false } },
    });
    await setAiCommitInfo("chat-key", "vendor/model:free", "openai", "https://provider.example/api/v1/");
    const switched = await setAiCommitInfo("", "gemini-next", "google");
    expect(switched).toMatchObject({
      provider: "google", model: "gemini-next",
      profiles: { openai: { configured: true, model: "vendor/model:free", baseUrl: "https://provider.example/api/v1" } },
    });
    const stored = JSON.parse(await fs.readFile(path.join(config, "ai-commit.json"), "utf8"));
    expect(stored.google.apiKey).toBe("legacy-key");
    expect(stored.openai.apiKey).toBe("chat-key");
    expect(JSON.stringify(switched)).not.toContain("legacy-key");
    expect(JSON.stringify(switched)).not.toContain("chat-key");
    const cleared = await clearAiCommitInfo("google");
    expect(cleared).toMatchObject({ configured: false, profiles: { openai: { configured: true } } });
    expect(await setAiCommitInfo("", "vendor/new-model", "openai", "https://provider.example/api/v1/chat/completions/"))
      .toMatchObject({ provider: "openai", configured: true, baseUrl: "https://provider.example/api/v1" });
    await clearAiCommitInfo();
    expect((await getAiCommitInfo()).profiles).toMatchObject({ google: { configured: false }, openai: { configured: false } });
  });

  it("never reuses a key across providers or a changed base URL", async () => {
    await ready();
    await expect(setAiCommitInfo("", "model", "openai", "https://provider.example/v1")).rejects.toThrow("API key");
    await setAiCommitInfo("chat-key", "model", "openai", "https://provider.example/v1");
    await expect(setAiCommitInfo("", "model", "openai", "https://other.example/v1")).rejects.toThrow("Re-enter");
    expect(await getAiCommitInfo()).toMatchObject({ provider: "openai", baseUrl: "https://provider.example/v1" });
    await setAiCommitInfo("replacement-key", "model", "openai", "https://other.example/v1");
    const stored = JSON.parse(await fs.readFile(path.join(config, "ai-commit.json"), "utf8"));
    expect(stored.openai.apiKey).toBe("replacement-key");
    expect(stored.google.apiKey).toBe("test-key");
  });

  it("serializes concurrent profile updates and can replace corrupt legacy settings", async () => {
    await Promise.all([
      setAiCommitInfo("google-key", "gemini-test"),
      setAiCommitInfo("chat-key", "model", "openai", "http://localhost:1234/v1"),
    ]);
    expect((await getAiCommitInfo()).profiles).toMatchObject({ google: { configured: true }, openai: { configured: true } });
    await fs.writeFile(path.join(config, "ai-commit.json"), "{broken");
    await expect(getAiCommitInfo()).rejects.toThrow("Couldn't read");
    await setAiCommitInfo("new-key", "gemini-test");
    expect(await getAiCommitInfo()).toMatchObject({ configured: true, provider: "google" });
  });

  it("validates provider settings through the API", async () => {
    for (const baseUrl of ["", "not a URL", "file:///tmp/model", "https://user:pass@provider.example/v1", "https://provider.example/v1?key=secret", "https://provider.example/v1#fragment"]) {
      await expect(setAiCommitInfo("key", "model", "openai", baseUrl)).rejects.toMatchObject({ status: 400 });
    }
    const invalid = await realFetch(base + "/api/ai-commit/settings", {
      method: "POST", headers, body: JSON.stringify({ provider: "unknown", apiKey: "key", model: "model" }),
    });
    expect(invalid.status).toBe(400);
    const saved = await realFetch(base + "/api/ai-commit/settings", {
      method: "POST", headers,
      body: JSON.stringify({ provider: "openai", apiKey: "key", model: "org/model:latest", baseUrl: "https://provider.example/api/v1/" }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ provider: "openai", model: "org/model:latest", baseUrl: "https://provider.example/api/v1" });
    const cleared = await realFetch(base + "/api/ai-commit/settings", {
      method: "DELETE", headers, body: JSON.stringify({ provider: "openai" }),
    });
    expect((await cleared.json()).configured).toBe(false);
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
    expect(await generateAiCommitInfo(root, false)).toEqual({ ...message, source: "unstaged", chunked: false });
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
    expect(await generateAiCommitInfo(root, false)).toEqual({ ...message, description: description.trim(), source: "unstaged", chunked: false });
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

describe("OpenAI-compatible Chat Completions generation", () => {
  it("uses the configured endpoint, bearer key, model and messages over HTTP", async () => {
    await ready();
    await setAiCommitInfo("chat-key", "vendor/model:free", "openai", `${base}/compatible/v1/chat/completions/`);
    providerRequest = null;
    expect(await generateAiCommitInfo(root, false)).toEqual({ ...message, source: "unstaged", chunked: false });
    expect(providerRequest).toMatchObject({
      authorization: "Bearer chat-key",
      body: {
        model: "vendor/model:free", stream: false,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "commit_message", strict: true,
            schema: {
              type: "object",
              properties: { title: { type: "string" }, description: { type: "string" } },
              required: ["title", "description"], additionalProperties: false,
            },
          },
        },
        messages: [
          { role: "system", content: expect.stringContaining("72 characters") },
          { role: "user", content: expect.stringContaining("new content") },
        ],
      },
    });
    expect(JSON.stringify(providerRequest)).not.toContain("generationConfig");
    expect(JSON.stringify(providerRequest)).not.toContain("test-key");
  });

  it("normalizes empty query and fragment delimiters before building the chat endpoint", async () => {
    await ready();
    for (const suffix of ["?", "#", "?#"]) {
      await setAiCommitInfo("chat-key", "model", "openai", `${base}/compatible/v1${suffix}`);
      expect((await getAiCommitInfo()).baseUrl).toBe(`${base}/compatible/v1`);
      expect(await generateAiCommitInfo(root, false)).toEqual({ ...message, source: "unstaged", chunked: false });
    }
  });

  it("reports unsupported JSON Schema output without weakening the request or retrying", async () => {
    await ready();
    await setAiCommitInfo("chat-key", "model", "openai", "https://provider.example/v1");
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      error: { param: "response_format", message: "json_schema is not supported by this model" },
    }, { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(generateAiCommitInfo(root, false)).rejects.toMatchObject({
      status: 502, message: "OpenAI Chat Completions (400): json_schema is not supported by this model",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const first = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(first.response_format).toMatchObject({ type: "json_schema", json_schema: { strict: true } });
    expect(fetchMock.mock.calls[0][1].redirect).toBe("error");
  });

  it.each([400, 401, 429, 500])("reports HTTP %i errors without retrying or exposing the key", async (status) => {
    await ready();
    await setAiCommitInfo("chat-key", "model", "openai", "https://provider.example/v1");
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ error: { message: "Request failed for chat-key" } }, { status }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(generateAiCommitInfo(root, false)).rejects.toMatchObject({
      status: 502, message: `OpenAI Chat Completions (${status}): Request failed for [redacted]`,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid, refused and incomplete Chat Completions responses", async () => {
    await ready();
    await setAiCommitInfo("chat-key", "model", "openai", "https://provider.example/v1");
    for (const body of [
      chatBody({ title: "x".repeat(73), description: "Description" }),
      chatBody({ title: "Title", description: "" }),
      { choices: [{ finish_reason: "stop", message: { content: "not JSON" } }] },
      { choices: [{ finish_reason: "length", message: { content: JSON.stringify(message) } }] },
      { choices: [{ finish_reason: "stop", message: { content: JSON.stringify(message), refusal: "Refused" } }] },
      { choices: [] },
    ]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
      await expect(generateAiCommitInfo(root, false)).rejects.toMatchObject({ status: 502 });
    }
  });

  it("still rejects stale diffs and returns to the unchanged Google request format", async () => {
    await ready();
    await setAiCommitInfo("chat-key", "model", "openai", "https://provider.example/v1");
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
      await fs.writeFile(path.join(root, "new.txt"), "newer content\n");
      return Response.json(chatBody());
    }));
    await expect(generateAiCommitInfo(root, false)).rejects.toMatchObject({ status: 409 });
    await setAiCommitInfo("", "gemini-test", "google");
    const fetchMock = vi.fn().mockResolvedValue(response());
    vi.stubGlobal("fetch", fetchMock);
    expect(await generateAiCommitInfo(root, false)).toEqual({ ...message, source: "unstaged", chunked: false });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent");
    expect(init.headers["x-goog-api-key"]).toBe("test-key");
    expect(init.headers.Authorization).toBeUndefined();
    expect(JSON.parse(init.body).generationConfig.responseJsonSchema.required).toEqual(["title", "description"]);
  });
});

describe("context-window fallback", () => {
  const overflow = () => Response.json({ error: { code: "context_length_exceeded", message: "Input exceeds the context window" } }, { status: 400 });
  const contentOf = (init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    return JSON.parse(body.messages?.[1].content ?? body.contents[0].parts[0].text);
  };
  const largeChange = async () => {
    await ready();
    const text = Array.from({ length: 4000 }, (_, i) => `line ${i}: concrete changed behavior 😀\n`).join("");
    await fs.writeFile(path.join(root, "new.txt"), text);
    return text;
  };

  it.each(["google", "openai"] as const)("splits rejected %s requests and merges every chunk without losing source text", async (provider) => {
    const text = await largeChange();
    if (provider === "openai") await setAiCommitInfo("chat-key", "model", "openai", "https://provider.example/v1");
    const accepted: CommitPart[] = [];
    let summaries = 0;
    let rejections = 0;
    const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
      const payload = JSON.parse(init.body);
      if (provider === "openai") expect(payload.response_format).toMatchObject({ type: "json_schema", json_schema: { strict: true } });
      else expect(payload.generationConfig.responseMimeType).toBe("application/json");
      if (Buffer.byteLength(init.body) > 24_000) {
        rejections++;
        return provider === "openai" ? overflow() : Response.json({ error: {
          message: "The input token count (50000) exceeds the maximum number of tokens allowed (10000).", status: "INVALID_ARGUMENT",
        } }, { status: 400 });
      }
      const data = contentOf(init);
      expect(data).toMatchObject({ source: "unstaged", amend: false, branch: "main" });
      let description: string;
      if (data.changes) {
        accepted.push(...data.changes);
        description = `DETAIL-${summaries++}`;
      } else {
        description = data.summaries.map((part: CommitPart) => part.text).join("\n");
      }
      const value = { title: "Describe all changes", description };
      return provider === "openai" ? Response.json(chatBody(value)) : response(value);
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await generateAiCommitInfo(root, false);
    expect(rejections).toBeGreaterThan(1);
    expect(summaries).toBeGreaterThan(1);
    expect(accepted.filter((p) => p.kind === "untracked").map((p) => p.text).join("")).toBe(text);
    expect(accepted.filter((p) => p.kind === "status").map((p) => JSON.parse(p.text)))
      .toEqual([{ path: "new.txt", status: "?", staged: false }]);
    for (let i = 0; i < summaries; i++) expect(result.description.split("\n")).toContain(`DETAIL-${i}`);
    expect(result.source).toBe("unstaged");
    expect(result.chunked).toBe(true);
    expect(contentOf(fetchMock.mock.calls.at(-1)![1]).summaries).toBeDefined();
  });

  it("reduces oversized intermediate summaries, including splitting a single long summary", async () => {
    await largeChange();
    let summaries = 0;
    let rejectedMerges = 0;
    let splitSummary = false;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url, init) => {
      const data = contentOf(init);
      if (Buffer.byteLength(init.body) > 36_000) {
        if (data.summaries) rejectedMerges++;
        return overflow();
      }
      if (data.changes) return response({ title: "Describe a portion", description: `DETAIL-${summaries++}\n` + "x".repeat(40_000) });
      splitSummary ||= data.summaries.some((p: CommitPart) => (p.offset ?? 0) > 0);
      const details = data.summaries.flatMap((p: CommitPart) => p.text.match(/DETAIL-\d+/g) ?? []);
      return response({ title: "Combine all changes", description: details.join("\n") || "Continuation of described changes" });
    }));
    const result = await generateAiCommitInfo(root, false);
    expect(rejectedMerges).toBeGreaterThan(0);
    expect(result.chunked).toBe(true);
    expect(splitSummary).toBe(true);
    for (let i = 0; i < summaries; i++) expect(result.description).toContain(`DETAIL-${i}`);
  });

  it("keeps amend's complete staged replacement diff and excludes unstaged edits throughout fallback", async () => {
    await trackedFile();
    await setAiCommitInfo("key", "model");
    const added = "new staged content\n".repeat(1500);
    await fs.writeFile(path.join(root, "tracked.txt"), "original\n" + added);
    await runGit(root, ["add", "."]);
    await fs.writeFile(path.join(root, "tracked.txt"), "unstaged private content\n");
    const parts: CommitPart[] = [];
    const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
      const data = contentOf(init);
      expect(data).toMatchObject({ source: "staged", amend: true });
      expect(init.body).not.toContain("unstaged private content");
      if (fetchMock.mock.calls.length === 1) return overflow();
      if (data.changes) parts.push(...data.changes);
      return response();
    });
    vi.stubGlobal("fetch", fetchMock);
    expect((await generateAiCommitInfo(root, true)).source).toBe("staged");
    const diff = parts.filter((p) => p.kind === "diff").map((p) => p.text).join("");
    expect(diff).toContain("+original\n");
    expect(diff.match(/\+new staged content\n/g)).toHaveLength(1500);
  });

  it.each([
    [400, "This model's maximum context length is 8192 tokens."],
    [413, "prompt is too long: 9000 tokens > 8192 maximum"],
    [422, "Input tokens exceed the limit of 8192"],
  ])("recognizes explicit context errors with status %i", async (status, errorMessage) => {
    await largeChange();
    const fetchMock = vi.fn().mockImplementation(async () => fetchMock.mock.calls.length === 1
      ? Response.json({ error: { message: errorMessage } }, { status }) : response());
    vi.stubGlobal("fetch", fetchMock);
    expect(await generateAiCommitInfo(root, false)).toMatchObject(message);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(2);
  });

  it.each([
    [401, "Invalid key"], [429, "Input token limit exceeded for this minute"],
    [400, "json_schema is not supported"], [413, "Request body too large"], [500, "Internal error"],
  ])("does not chunk unrelated errors (%i: %s)", async (status, errorMessage) => {
    await largeChange();
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({ error: { message: errorMessage } }, { status }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(generateAiCommitInfo(root, false)).rejects.toThrow(errorMessage);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops on a failed chunk without publishing or merging partial results", async () => {
    await largeChange();
    const fetchMock = vi.fn().mockImplementation(async () => {
      if (fetchMock.mock.calls.length === 1) return overflow();
      if (fetchMock.mock.calls.length === 2) return response();
      return Response.json({ error: { message: "Rate limited" } }, { status: 429 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(generateAiCommitInfo(root, false)).rejects.toThrow("Rate limited");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.every((call) => !contentOf(call[1]).summaries)).toBe(true);
  });

  it("honors cancellation between chunks and before a pre-cancelled request", async () => {
    await largeChange();
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementation(async () => {
      if (fetchMock.mock.calls.length === 1) return overflow();
      controller.abort();
      return response();
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(generateAiCommitInfo(root, false, controller.signal)).rejects.toThrow("cancelled");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(generateAiCommitInfo(root, false, controller.signal)).rejects.toThrow("cancelled");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects a stale final merge after the selected diff changes", async () => {
    await largeChange();
    const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
      if (fetchMock.mock.calls.length === 1) return overflow();
      if (contentOf(init).summaries) await fs.writeFile(path.join(root, "new.txt"), "changed while generating\n");
      return response();
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(generateAiCommitInfo(root, false)).rejects.toMatchObject({ status: 409 });
  });

  it("terminates when even the smallest chunks are rejected", async () => {
    await largeChange();
    const fetchMock = vi.fn().mockImplementation(overflow);
    vi.stubGlobal("fetch", fetchMock);
    await expect(generateAiCommitInfo(root, false)).rejects.toThrow("context window is too small");
    expect(fetchMock.mock.calls.length).toBeLessThan(12);
  });

  it("bounds requests when a large diff needs too many tiny chunks", async () => {
    await ready();
    await fs.writeFile(path.join(root, "new.txt"), "a".repeat(2 * 1024 * 1024));
    const fetchMock = vi.fn().mockImplementation(async (_url, init) => Buffer.byteLength(init.body) > 8_000 ? overflow() : response());
    vi.stubGlobal("fetch", fetchMock);
    await expect(generateAiCommitInfo(root, false)).rejects.toThrow("too many requests");
    expect(fetchMock).toHaveBeenCalledTimes(256);
  });

  it("bounds reduction when the model repeatedly expands summaries instead of compressing them", async () => {
    await largeChange();
    const fetchMock = vi.fn().mockImplementation(async (_url, init) => Buffer.byteLength(init.body) > 24_000
      ? overflow() : response({ title: "Describe changes", description: "x".repeat(40_000) }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(generateAiCommitInfo(root, false)).rejects.toThrow("context window is too small");
    expect(fetchMock.mock.calls.length).toBeLessThan(256);
  });
});
