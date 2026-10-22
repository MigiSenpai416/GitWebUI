import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs, existsSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { runGit, runGitNullRecords } from "./gitRunner.js";
import { pull, push } from "./remote.js";
import { gitPath } from "./gitPath.js";
import { pickShell, runCommand, type RunEvent } from "../terminal.js";

vi.mock("../github.js", () => ({
  getToken: vi.fn(async () => "integration-fixture-token"),
  createRepo: vi.fn(),
}));

const exec = promisify(execFile);
const TOKEN_HEADER = `Basic ${Buffer.from("x-access-token:integration-fixture-token").toString("base64")}`;
const CONTENT = "lazy download fixture\0";
const LFS_CONTENT = Buffer.from("large file fixture downloaded with the app token\n");
const LFS_OID = createHash("sha256").update(LFS_CONTENT).digest("hex");
const requests: { host: string; url: string; authorization: string | undefined }[] = [];
const uploads: Buffer[] = [];
const sockets = new Set<Socket>();
let root: string;
let httpsServer: ReturnType<typeof createHttpsServer>;
let proxy: ReturnType<typeof createHttpServer>;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "gitwebui-auth-integration-"));
  const config = path.join(root, "global-config");
  await fs.writeFile(config, "");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_CONFIG_GLOBAL", config);
  vi.stubEnv("GIT_CONFIG_COUNT", "0");
  vi.stubEnv("GIT_CONFIG_PARAMETERS", "");
  vi.stubEnv("HOME", root);
  vi.stubEnv("XDG_CONFIG_HOME", root);
  vi.stubEnv("GIT_TERMINAL_PROMPT", "0");
  vi.stubEnv("GCM_INTERACTIVE", "never");
  vi.stubEnv("GIT_ASKPASS", "false");
  const gitExecPath = (await exec(gitPath(), ["--exec-path"], { windowsHide: true })).stdout.trim();
  const bundledOpenSsl = path.resolve(gitExecPath, "../../../usr/bin/openssl.exe");
  const openssl = process.platform === "win32" && existsSync(bundledOpenSsl) ? bundledOpenSsl : "openssl";
  await exec(openssl, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=github.com",
    "-keyout", path.join(root, "key.pem"), "-out", path.join(root, "cert.pem")], { windowsHide: true });
  const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
    requests.push({ host: req.headers.host ?? "", url: req.url ?? "", authorization: req.headers.authorization });
    if (req.headers.host === "example.invalid" && req.url === "/signed-lfs-object"
      && req.headers.authorization === "Bearer fixture-download") {
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": LFS_CONTENT.length });
      res.end(LFS_CONTENT);
      return;
    }
    if (req.headers.host !== "github.com") {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="other-host-fixture"' });
      res.end("Other host fixture");
      return;
    }
    if (req.url?.startsWith("/same-redirect.git/")
      || (req.url?.startsWith("/foreign-redirect.git/") && req.headers.authorization === TOKEN_HEADER)) {
      const host = req.url.startsWith("/foreign-redirect.git/") ? "example.invalid" : "github.com";
      res.writeHead(302, { Location: `https://${host}${req.url.replace(/^\/[^/]+/, "/repo.git")}` });
      res.end();
      return;
    }
    if (req.headers.authorization !== TOKEN_HEADER) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="fixture"' });
      res.end("Authentication required");
      return;
    }
    if (req.url?.endsWith("/objects/batch")) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const batch = JSON.parse(Buffer.concat(chunks).toString());
      res.writeHead(200, { "Content-Type": "application/vnd.git-lfs+json" });
      const download = req.url.startsWith("/external.git/")
        ? { href: "https://example.invalid/signed-lfs-object", header: { Authorization: "Bearer fixture-download" } }
        : { href: "https://github.com/lfs-object" };
      res.end(JSON.stringify({
        objects: [{ oid: LFS_OID, size: LFS_CONTENT.length, actions: batch.operation === "upload"
          ? { upload: { href: "https://github.com/lfs-upload" } } : { download } }],
      }));
      return;
    }
    if (req.url === "/lfs-upload" && req.method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      uploads.push(Buffer.concat(chunks));
      res.writeHead(200);
      res.end();
      return;
    }
    if (req.url === "/lfs-object") {
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": LFS_CONTENT.length });
      res.end(LFS_CONTENT);
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    let input = Buffer.concat(chunks);
    if (req.headers["content-encoding"] === "gzip") input = gunzipSync(input);
    const url = new URL(req.url ?? "/", "https://github.com");
    const child = spawn(gitPath(), ["http-backend"], {
      windowsHide: true,
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root.replace(/\\/g, "/"),
        GIT_HTTP_EXPORT_ALL: "1",
        REQUEST_METHOD: req.method,
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: req.headers["content-type"],
        CONTENT_LENGTH: String(input.length),
        HTTP_GIT_PROTOCOL: req.headers["git-protocol"] as string | undefined,
      },
    });
    const output: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.resume();
    child.on("error", () => {
      res.writeHead(500);
      res.end();
    });
    child.on("close", () => {
      if (res.writableEnded) return;
      const response = Buffer.concat(output);
      const separator = response.indexOf("\r\n\r\n");
      if (separator < 0) {
        res.writeHead(500);
        res.end(response);
        return;
      }
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of response.subarray(0, separator).toString().split("\r\n")) {
        const colon = line.indexOf(":");
        const key = line.slice(0, colon);
        const value = line.slice(colon + 1).trim();
        if (key.toLowerCase() === "status") status = Number(value.split(" ")[0]);
        else headers[key] = value;
      }
      res.writeHead(status, headers);
      res.end(response.subarray(separator + 4));
    });
    child.stdin.end(input);
  };
  httpsServer = createHttpsServer({
    key: await fs.readFile(path.join(root, "key.pem")),
    cert: await fs.readFile(path.join(root, "cert.pem")),
  }, (req, res) => {
    void handleRequest(req, res).catch((error: Error) => {
      if (res.writableEnded) return;
      if (!res.headersSent) res.writeHead(500);
      res.end(error.message);
    });
  });
  await new Promise<void>((resolve) => httpsServer.listen(0, "127.0.0.1", resolve));
  const port = (httpsServer.address() as { port: number }).port;
  proxy = createHttpServer((_req, res) => {
    res.writeHead(403);
    res.end();
  });
  proxy.on("connect", (req, client, head) => {
    if (req.url !== "github.com:443" && req.url !== "example.invalid:443" && req.url !== "github.com:8443") {
      client.destroy();
      return;
    }
    const upstream = connect(port, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    sockets.add(upstream);
    upstream.on("close", () => sockets.delete(upstream));
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    client.on("close", () => upstream.destroy());
  });
  proxy.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  vi.stubEnv("HTTPS_PROXY", proxyUrl);
  vi.stubEnv("https_proxy", proxyUrl);
  vi.stubEnv("NO_PROXY", "");
  vi.stubEnv("no_proxy", "");
  await fs.writeFile(config, `[http]\n\tproxy = ${proxyUrl}\n\tsslVerify = false\n[credential]\n\thelper =\n\thelper = "!echo unexpected-credential-helper >&2; exit 1"\n`);

  const source = path.join(root, "source");
  await fs.mkdir(source);
  await runGit(source, ["init", "-b", "main"]);
  await runGit(source, ["config", "user.name", "Fixture"]);
  await runGit(source, ["config", "user.email", "fixture@example.invalid"]);
  await fs.writeFile(path.join(source, "file.txt"), CONTENT);
  await runGit(source, ["add", "file.txt"]);
  await runGit(source, ["commit", "-m", "Fixture"]);
  await runGit(root, ["clone", "--bare", source, path.join(root, "repo.git")]);
  await runGit(path.join(root, "repo.git"), ["config", "uploadpack.allowFilter", "true"]);
  await runGit(path.join(root, "repo.git"), ["config", "uploadpack.allowAnySHA1InWant", "true"]);
  await runGit(path.join(root, "repo.git"), ["config", "http.receivepack", "true"]);
}, 30_000);

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  if (proxy) await new Promise<void>((resolve) => proxy.close(() => resolve()));
  if (httpsServer) {
    httpsServer.closeAllConnections();
    await new Promise<void>((resolve) => httpsServer.close(() => resolve()));
  }
  vi.unstubAllEnvs();
  if (root && path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith("gitwebui-auth-integration-")) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe("saved GitHub credentials in real Git operations", () => {
  it.each(["runner", "records", "terminal", ...(process.platform === "win32" ? ["powershell"] : [])])("authenticates a partial-clone file read from the %s", async (source) => {
    const target = path.join(root, source);
    await runGit(root, ["clone", "--filter=blob:none", "--no-checkout", "https://github.com/repo.git", target]);
    const before = requests.length;
    if (source === "records") {
      expect(await runGitNullRecords(target, ["show", "HEAD:file.txt"])).toEqual([CONTENT.slice(0, -1)]);
    } else if (source === "terminal" || source === "powershell") {
      const events: RunEvent[] = [];
      const shell = pickShell(source === "powershell" ? "powershell" : undefined);
      if (source === "powershell") expect(shell.kind).toBe("powershell");
      await runCommand({ command: "git show HEAD:file.txt", cwd: target, shell }, (e) => events.push(e)).done;
      expect(events.at(-1)?.code).toBe(0);
      expect(events.filter((e) => e.t === "out").map((e) => e.d).join("")).toContain(CONTENT.slice(0, -1));
      expect(events.filter((e) => e.t === "err").map((e) => e.d).join("")).not.toContain("unexpected-credential-helper");
    } else {
      const result = await runGit(target, ["show", "HEAD:file.txt"]);
      expect(result.stdout).toBe(CONTENT);
      expect(result.stderr).not.toContain("unexpected-credential-helper");
    }
    const downloads = requests.slice(before);
    expect(downloads.some((r) => r.url === "/repo.git/git-upload-pack")).toBe(true);
    expect(downloads.some((r) => r.authorization === TOKEN_HEADER)).toBe(true);
    expect(downloads.every((r) => r.authorization === undefined || r.authorization === TOKEN_HEADER)).toBe(true);
  }, 30_000);

  for (const host of ["github", "external"]) {
    it(`authenticates LFS checkout with a ${host} download action`, async (context) => {
      if (await exec(gitPath(), ["lfs", "version"], { windowsHide: true }).then(() => false, () => true)) context.skip();
      const target = path.join(root, `lfs-${host}`);
      await fs.mkdir(target);
      await runGit(target, ["init", "-b", "main"]);
      await runGit(target, ["config", "user.name", "Fixture"]);
      await runGit(target, ["config", "user.email", "fixture@example.invalid"]);
      await runGit(target, ["remote", "add", "origin", "https://github.com/repo.git"]);
      if (host === "external") await runGit(target, ["config", "lfs.url", "https://github.com/external.git/info/lfs"]);
      await fs.writeFile(path.join(target, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
      await fs.writeFile(path.join(target, "asset.bin"), `version https://git-lfs.github.com/spec/v1\noid sha256:${LFS_OID}\nsize ${LFS_CONTENT.length}\n`);
      await runGit(target, ["add", "."]);
      await runGit(target, ["commit", "-m", "LFS pointer fixture"]);
      await runGit(target, ["lfs", "install", "--local"]);
      await fs.unlink(path.join(target, "asset.bin"));
      const before = requests.length;
      const result = await runGit(target, ["checkout", "--", "asset.bin"]);
      expect(await fs.readFile(path.join(target, "asset.bin"))).toEqual(LFS_CONTENT);
      expect(result.stderr).not.toContain("unexpected-credential-helper");
      const downloads = requests.slice(before);
      expect(downloads.some((r) => r.url.endsWith("/objects/batch"))).toBe(true);
      expect(downloads.some((r) => r.url === (host === "github" ? "/lfs-object" : "/signed-lfs-object"))).toBe(true);
      expect(downloads.some((r) => r.authorization === TOKEN_HEADER)).toBe(true);
      expect(downloads.every((r) => r.host === "github.com"
        ? r.authorization === undefined || r.authorization === TOKEN_HEADER
        : r.authorization === "Bearer fixture-download")).toBe(true);
    }, 30_000);
  }

  it("pushes and pulls over HTTPS with the saved token", async () => {
    const writer = path.join(root, "writer");
    const reader = path.join(root, "reader");
    await runGit(root, ["clone", "https://github.com/repo.git", writer]);
    await runGit(root, ["clone", "https://github.com/repo.git", reader]);
    await runGit(writer, ["config", "user.name", "Fixture"]);
    await runGit(writer, ["config", "user.email", "fixture@example.invalid"]);
    await fs.writeFile(path.join(writer, "synced.txt"), "pushed and pulled with the saved token\n");
    await runGit(writer, ["add", "synced.txt"]);
    await runGit(writer, ["commit", "-m", "Remote authentication fixture"]);
    const beforePush = requests.length;
    const pushed = await push(writer);
    expect(pushed.rejected).not.toBe(true);
    expect(pushed.output).not.toContain("unexpected-credential-helper");
    expect(requests.slice(beforePush).some((r) => r.url === "/repo.git/git-receive-pack"
      && r.authorization === TOKEN_HEADER)).toBe(true);
    const head = (await runGit(writer, ["rev-parse", "HEAD"])).stdout;
    expect((await runGit(path.join(root, "repo.git"), ["rev-parse", "refs/heads/main"])).stdout).toBe(head);
    const beforePull = requests.length;
    const pulled = await pull(reader);
    expect(pulled.output).not.toContain("unexpected-credential-helper");
    expect(requests.slice(beforePull).some((r) => r.url === "/repo.git/git-upload-pack"
      && r.authorization === TOKEN_HEADER)).toBe(true);
    expect((await runGit(reader, ["rev-parse", "HEAD"])).stdout).toBe(head);
    expect(await fs.readFile(path.join(reader, "synced.txt"), "utf8")).toBe("pushed and pulled with the saved token\n");
  }, 30_000);

  it("authenticates the LFS upload hook during a push", async (context) => {
    if (await exec(gitPath(), ["lfs", "version"], { windowsHide: true }).then(() => false, () => true)) context.skip();
    const target = path.join(root, "lfs-upload");
    await fs.mkdir(target);
    await runGit(target, ["init", "-b", "lfs-upload-fixture"]);
    await runGit(target, ["config", "user.name", "Fixture"]);
    await runGit(target, ["config", "user.email", "fixture@example.invalid"]);
    await runGit(target, ["remote", "add", "origin", "https://github.com/repo.git"]);
    await runGit(target, ["lfs", "install", "--local"]);
    await fs.writeFile(path.join(target, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
    await fs.writeFile(path.join(target, "asset.bin"), LFS_CONTENT);
    await runGit(target, ["add", "."]);
    await runGit(target, ["commit", "-m", "LFS upload fixture"]);
    const before = requests.length;
    const result = await push(target);
    expect(result.output).not.toContain("unexpected-credential-helper");
    expect(uploads).toContainEqual(LFS_CONTENT);
    expect(requests.slice(before).some((r) => r.url === "/lfs-upload" && r.authorization === TOKEN_HEADER)).toBe(true);
    const head = (await runGit(target, ["rev-parse", "HEAD"])).stdout;
    expect((await runGit(path.join(root, "repo.git"), ["rev-parse", "refs/heads/lfs-upload-fixture"])).stdout).toBe(head);
  }, 30_000);

  it("authenticates recursive submodule cloning with the saved token", async () => {
    const source = path.join(root, "superproject");
    const target = path.join(root, "submodule-clone");
    await fs.mkdir(source);
    await runGit(source, ["init", "-b", "main"]);
    await runGit(source, ["config", "user.name", "Fixture"]);
    await runGit(source, ["config", "user.email", "fixture@example.invalid"]);
    await runGit(source, ["submodule", "add", "https://github.com/repo.git", "child"]);
    await runGit(source, ["commit", "-m", "Submodule fixture"]);
    const before = requests.length;
    const result = await runGit(root, ["clone", "--recurse-submodules", source, target]);
    expect(result.stderr).not.toContain("unexpected-credential-helper");
    expect(await fs.readFile(path.join(target, "child", "file.txt"), "utf8")).toBe(CONTENT);
    expect(requests.slice(before).some((r) => r.url === "/repo.git/git-upload-pack"
      && r.authorization === TOKEN_HEADER)).toBe(true);
  }, 30_000);

  it("does not use the GitHub fetch URL's token for a foreign push URL", async () => {
    const target = path.join(root, "foreign-push");
    await runGit(root, ["clone", "https://github.com/repo.git", target]);
    await runGit(target, ["remote", "set-url", "--push", "origin", "https://example.invalid/repo.git"]);
    const before = requests.length;
    await expect(push(target)).rejects.toThrow();
    const attempts = requests.slice(before);
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts.every((r) => r.host === "example.invalid" && r.authorization === undefined)).toBe(true);
  }, 30_000);

  it.each(["example.invalid", "github.com:8443"])("does not send the saved GitHub token to %s when challenged", async (host) => {
    const before = requests.length;
    await expect(runGit(root, ["ls-remote", `https://${host}/repo.git`])).rejects.toThrow();
    const otherRequests = requests.slice(before);
    expect(otherRequests.length).toBeGreaterThan(0);
    expect(otherRequests.every((r) => r.host === host && r.authorization === undefined)).toBe(true);
  }, 30_000);

  it("does not forward the saved token through an authenticated cross-host redirect", async () => {
    const before = requests.length;
    await expect(runGit(root, ["ls-remote", "https://github.com/foreign-redirect.git"])).rejects.toThrow();
    const attempts = requests.slice(before);
    expect(attempts.some((r) => r.host === "github.com" && r.authorization === TOKEN_HEADER)).toBe(true);
    const redirected = attempts.filter((r) => r.host === "example.invalid");
    expect(redirected.length).toBeGreaterThan(0);
    expect(redirected.every((r) => r.authorization === undefined)).toBe(true);
  }, 30_000);

  it("continues to authenticate after a same-host repository redirect", async () => {
    const before = requests.length;
    const result = await runGit(root, ["ls-remote", "https://github.com/same-redirect.git"]);
    expect(result.stdout).toContain("refs/heads/main");
    expect(requests.slice(before).some((r) => r.url.startsWith("/repo.git/") && r.authorization === TOKEN_HEADER)).toBe(true);
  }, 30_000);
});
