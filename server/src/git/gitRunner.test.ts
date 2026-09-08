import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { gitAuthEnv, runGit, runGitNullRecords } from "./gitRunner.js";
import { getToken } from "../github.js";
import { pickShell, runCommand, type RunEvent } from "../terminal.js";

vi.mock("../github.js", () => ({ getToken: vi.fn(async () => null) }));

const ROOT = path.join(os.tmpdir(), `gitwebui-runner-${randomBytes(6).toString("hex")}`);
const HELPER = '!f() { echo helper-called >&2; if [ "$GCM_INTERACTIVE" != "never" ]; then echo credential-popup >&2; fi; }; f';

beforeEach(async () => {
  vi.mocked(getToken).mockReset().mockResolvedValue(null);
  await fs.rm(ROOT, { recursive: true, force: true });
  await fs.mkdir(ROOT, { recursive: true });
  await fs.writeFile(path.join(ROOT, "global-config"), "");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_CONFIG_GLOBAL", path.join(ROOT, "global-config"));
  vi.stubEnv("GIT_CONFIG_COUNT", "0");
  vi.stubEnv("GIT_CONFIG_PARAMETERS", "");
  vi.stubEnv("GIT_TERMINAL_PROMPT", "0");
  vi.stubEnv("GCM_INTERACTIVE", "true");
  vi.stubEnv("GIT_ASKPASS", "false");
  await runGit(ROOT, ["init", "-b", "main"]);
  await runGit(ROOT, ["config", "credential.helper", HELPER]);
});

afterEach(() => vi.unstubAllEnvs());
afterAll(() => fs.rm(ROOT, { recursive: true, force: true }));

describe("noninteractive Git authentication", () => {
  it.each(["github.com", "github.com:443", "GITHUB.COM"])("uses the saved token for %s without persisting it", async (host) => {
    vi.mocked(getToken).mockResolvedValue("fixture-token");
    const input = `protocol=https\nhost=${host}\n\n`;
    const result = await runGit(ROOT, ["credential", "fill"], { input });
    expect(result.stdout).toContain("username=x-access-token");
    expect(result.stdout).toContain("password=fixture-token");
    expect(result.stderr).not.toContain("helper-called");
    const approved = await runGit(ROOT, ["credential", "approve"], { input: result.stdout });
    expect(approved.stderr).not.toContain("helper-called");
    expect(await fs.readFile(path.join(ROOT, ".git", "config"), "utf8")).not.toContain("fixture-token");
    expect((await runGit(ROOT, ["config", "--list"])).stdout).not.toContain("fixture-token");
  });

  it.each([
    ["http", "github.com"],
    ["https", "github.com.evil.example"],
    ["https", "gitlab.com"],
    ["https", "github.com:8443"],
    ["ssh", "github.com"],
  ])("does not supply the GitHub token to %s://%s", async (protocol, host) => {
    vi.mocked(getToken).mockResolvedValue("fixture-token");
    const error = await runGit(ROOT, ["credential", "fill"], {
      input: `protocol=${protocol}\nhost=${host}\n\n`,
    }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("helper-called");
    expect((error as Error).message).not.toContain("fixture-token");
  });

  it("preserves inherited Git configuration and uses token changes on the next command", async () => {
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "test.inherited");
    vi.stubEnv("GIT_CONFIG_VALUE_0", "preserved");
    vi.mocked(getToken).mockResolvedValue("first-token");
    expect((await runGit(ROOT, ["config", "--get", "test.inherited"])).stdout.trim()).toBe("preserved");
    vi.mocked(getToken).mockResolvedValue("replacement-token");
    expect((await runGit(ROOT, ["credential", "fill"], {
      input: "protocol=https\nhost=github.com\n\n",
    })).stdout).toContain("password=replacement-token");
    vi.mocked(getToken).mockResolvedValue(null);
    vi.stubEnv("GITWEBUI_GITHUB_TOKEN", "stale-token");
    expect((await gitAuthEnv()).GITWEBUI_GITHUB_TOKEN).toBeUndefined();
    await expect(runGit(ROOT, ["credential", "fill"], {
      input: "protocol=https\nhost=github.com\n\n",
    })).rejects.toThrow("terminal prompts disabled");
  });

  it("preserves terminal Git parameters while adding its color configuration", async () => {
    vi.stubEnv("GIT_CONFIG_PARAMETERS", "'test.inherited=preserved'");
    vi.mocked(getToken).mockResolvedValue("fixture-token");
    const events: RunEvent[] = [];
    await runCommand({ command: "git config --get test.inherited", cwd: ROOT, shell: pickShell(undefined) },
      (e) => events.push(e)).done;
    expect(events.at(-1)?.code).toBe(0);
    expect(events.filter((e) => e.t === "out").map((e) => e.d).join("").trim()).toBe("preserved");
  });

  it("does not launch a terminal command cancelled while its token is loading", async () => {
    let ready!: () => void;
    let finish!: (token: string | null) => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const token = new Promise<string | null>((resolve) => { finish = resolve; });
    vi.mocked(getToken).mockImplementationOnce(() => { ready(); return token; });
    const events: RunEvent[] = [];
    const handle = runCommand({ command: "echo should-not-run", cwd: ROOT, shell: pickShell(undefined) },
      (e) => events.push(e));
    await started;
    handle.kill();
    finish("fixture-token");
    await handle.done;
    expect(events).toEqual([{ t: "exit", code: null, cwd: ROOT, killed: true }]);
  });

  it.each([runGit, runGitNullRecords])("prevents credential UI in either runner", async (run) => {
    const error = await run(ROOT, ["credential", "fill"], {
      input: "protocol=https\nhost=example.invalid\n\n",
    }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("helper-called");
    expect((error as Error).message).not.toContain("credential-popup");
  });

  it("still accepts credentials returned without interaction", async () => {
    await runGit(ROOT, ["config", "credential.helper", '!f() { echo username=test; echo password=fixture; }; f']);
    const { stdout } = await runGit(ROOT, ["credential", "fill"], {
      input: "protocol=https\nhost=example.invalid\n\n",
    });
    expect(stdout).toContain("username=test");
    expect(stdout).toContain("password=fixture");
  });

  it("does not fall back to another cached GitHub account when the app token is unavailable", async () => {
    await runGit(ROOT, ["config", "credential.helper", '!f() { echo username=other-account; echo password=other-token; }; f']);
    await expect(runGit(ROOT, ["credential", "fill"], {
      input: "protocol=https\nhost=github.com\n\n",
    })).rejects.toThrow("terminal prompts disabled");
    expect((await runGit(ROOT, ["status", "--porcelain"])).stdout).not.toContain("other-token");
  });

  it("blocks inherited askpass even when remote credential helpers are disabled", async () => {
    const askpass = path.join(ROOT, "askpass.sh").replace(/\\/g, "/");
    await fs.writeFile(askpass, "#!/bin/sh\necho askpass-popup >&2\nexit 1\n", { mode: 0o700 });
    vi.stubEnv("GIT_ASKPASS", askpass);
    const error = await runGit(ROOT, ["-c", "credential.helper=", "credential", "fill"], {
      env: { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
      input: "protocol=https\nhost=example.invalid\n\n",
    }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("askpass-popup");
    expect((error as Error).message).toContain("terminal prompts disabled");
  });

  it.each(["runner", "terminal"])("prevents credential UI during an implicit partial-clone fetch in the %s", async (source) => {
    const server = createServer((_req, res) => {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="test"' });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      await runGit(ROOT, ["config", "remote.origin.url", `http://127.0.0.1:${port}/repo`]);
      await runGit(ROOT, ["config", "remote.origin.promisor", "true"]);
      const { stdout } = await runGit(ROOT, ["hash-object", "-w", "--stdin"], { input: "missing content\n" });
      const oid = stdout.trim();
      await fs.unlink(path.join(ROOT, ".git", "objects", oid.slice(0, 2), oid.slice(2)));
      let message: string;
      if (source === "terminal") {
        const events: RunEvent[] = [];
        await runCommand({ command: `git show ${oid}`, cwd: ROOT, shell: pickShell(undefined) }, (e) => events.push(e)).done;
        expect(events.at(-1)?.code).not.toBe(0);
        message = events.filter((e) => e.t === "err").map((e) => e.d).join("");
      } else {
        const error = await runGit(ROOT, ["show", oid]).catch((e: Error) => e);
        expect(error).toBeInstanceOf(Error);
        message = (error as Error).message;
      }
      expect(message).toContain("helper-called");
      expect(message).not.toContain("credential-popup");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
    }
  });
});
