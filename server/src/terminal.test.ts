import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { buildScript, detectShells, pickShell, runCommand, type RunEvent } from "./terminal.js";

const DIR = path.join(os.tmpdir(), `gitwebui-term-${randomBytes(6).toString("hex")}`);

beforeAll(async () => {
  await fs.mkdir(path.join(DIR, "sub"), { recursive: true });
});
afterAll(() => fs.rm(DIR, { recursive: true, force: true }));

/** Run to completion, collecting the stream the client would have received. */
async function run(command: string, cwd = DIR, shellId?: string) {
  const events: RunEvent[] = [];
  const handle = runCommand(
    { command, cwd, shell: pickShell(shellId) },
    (e) => events.push(e),
  );
  await handle.done;
  const text = (t: RunEvent["t"]) =>
    events.filter((e) => e.t === t).map((e) => e.d).join("");
  const exit = events[events.length - 1];
  return { events, out: text("out"), err: text("err"), exit };
}

describe("buildScript", () => {
  it("moves to the working directory, keeps the exit code, and reports where it ended", () => {
    const sh = buildScript("bash", "git status");
    expect(sh).toContain('cd "$GW_CWD"');
    expect(sh).toContain("git status");
    expect(sh).toContain("__gw_code=$?");
    expect(sh).toContain('> "$GW_OUT"');
    expect(sh).toContain("exit $__gw_code");
    // `pwd -W` is Git Bash's Windows-style path, with plain pwd everywhere else.
    expect(sh).toContain("pwd -W 2>/dev/null || pwd");
  });

  it("uses PowerShell's own idioms, including its two ways of failing", () => {
    const ps = buildScript("powershell", "git status");
    expect(ps).toContain("Set-Location -LiteralPath $env:GW_CWD");
    expect(ps).toContain("git status");
    expect(ps).toContain("Out-File -FilePath $env:GW_OUT");
    // $? must be read on the line right after the command, before anything else
    // can overwrite it, and must not be pre-empted by a seeded $LASTEXITCODE.
    const lines = ps.split("\n");
    expect(lines[lines.indexOf("git status") + 1]).toBe("$__gw_ok = $?");
    expect(ps).not.toContain("$global:LASTEXITCODE = 0");
    expect(ps).toContain("if ($null -ne $__gw_last) { $__gw_last } elseif ($__gw_ok) { 0 } else { 1 }");
  });

  it("passes a multi-line command through as written", () => {
    expect(buildScript("bash", "echo one\necho two")).toContain("echo one\necho two");
  });
});

describe("detectShells", () => {
  it("finds at least one usable shell on this machine", () => {
    const shells = detectShells();
    expect(shells.length).toBeGreaterThan(0);
    for (const s of shells) {
      expect(s.path).toBeTruthy();
      expect(s.label).toBeTruthy();
      expect(["bash", "zsh", "sh", "powershell", "pwsh"]).toContain(s.kind);
    }
  });

  it("prefers Git Bash on Windows and a POSIX shell elsewhere", () => {
    const [first] = detectShells();
    if (process.platform === "win32") {
      // Git is a hard requirement of this app, so its bash should be there.
      expect(["bash", "powershell"]).toContain(first.kind);
    } else {
      expect(["bash", "zsh", "sh"]).toContain(first.kind);
    }
  });

  it("falls back to the best shell when the requested one is unknown", () => {
    expect(pickShell("nope-not-a-shell")).toEqual(detectShells()[0]);
    expect(pickShell(undefined)).toEqual(detectShells()[0]);
  });
});

describe("runCommand", () => {
  it("streams stdout and reports a zero exit", async () => {
    const { out, exit } = await run("echo hello-from-the-runner");
    expect(out).toContain("hello-from-the-runner");
    expect(exit).toMatchObject({ t: "exit", code: 0, killed: false });
  });

  it("keeps stderr separate from stdout", async () => {
    const shell = pickShell();
    const cmd =
      shell.kind === "powershell" || shell.kind === "pwsh"
        ? "[Console]::Error.WriteLine('to-stderr'); Write-Output 'to-stdout'"
        : "echo to-stdout; echo to-stderr 1>&2";
    const { out, err } = await run(cmd);
    expect(out).toContain("to-stdout");
    expect(err).toContain("to-stderr");
    expect(out).not.toContain("to-stderr");
  });

  it("surfaces a non-zero exit code", async () => {
    const shell = pickShell();
    const cmd = shell.kind === "powershell" || shell.kind === "pwsh" ? "exit 3" : "exit 3";
    const { exit } = await run(cmd);
    expect(exit.code).toBe(3);
  });

  it("reports the directory a `cd` left it in, so the next command starts there", async () => {
    const { exit } = await run("cd sub");
    expect(exit.cwd).toBeTruthy();
    expect(path.resolve(exit.cwd!).toLowerCase()).toBe(path.join(DIR, "sub").toLowerCase());
  });

  it("stays put when the command doesn't move", async () => {
    const { exit } = await run("echo staying");
    expect(path.resolve(exit.cwd!).toLowerCase()).toBe(path.resolve(DIR).toLowerCase());
  });

  it("runs in the directory it was given", async () => {
    const sub = path.join(DIR, "sub");
    await fs.writeFile(path.join(sub, "marker.txt"), "x", "utf8");
    const shell = pickShell();
    const cmd = shell.kind === "powershell" || shell.kind === "pwsh" ? "Get-ChildItem -Name" : "ls";
    const { out } = await run(cmd, sub);
    expect(out).toContain("marker.txt");
  });

  it("decodes non-ASCII output as UTF-8", async () => {
    const shell = pickShell();
    const cmd =
      shell.kind === "powershell" || shell.kind === "pwsh"
        ? "Write-Output 'ünïcodé — ✓'"
        : "printf '%s\\n' 'ünïcodé — ✓'";
    const { out } = await run(cmd);
    expect(out).toContain("ünïcodé — ✓");
  });

  it("ends the stream when killed, marking why", async () => {
    const shell = pickShell();
    const sleep =
      shell.kind === "powershell" || shell.kind === "pwsh" ? "Start-Sleep -Seconds 30" : "sleep 30";
    const events: RunEvent[] = [];
    const handle = runCommand({ command: sleep, cwd: DIR, shell }, (e) => events.push(e));
    setTimeout(() => handle.kill(), 250);
    await handle.done;
    const exit = events[events.length - 1];
    expect(exit.t).toBe("exit");
    expect(exit.killed).toBe(true);
    expect(exit.code).not.toBe(0);
  }, 20000);
});

// PowerShell reports failure differently from every other shell here, and reads
// its own script files in the system codepage, so it gets its own pass.
const ps = detectShells().find((s) => s.kind === "powershell" || s.kind === "pwsh");
describe.skipIf(!ps)("runCommand on PowerShell", () => {
  it("reports a failing cmdlet as a failure, not a success", async () => {
    const { exit, err } = await run("Get-Item 'no-such-file-here'", DIR, ps!.id);
    expect(exit.code).not.toBe(0);
    expect(err).toMatch(/no-such-file-here/);
  });

  it("reports a passing cmdlet as a success", async () => {
    const { exit, out } = await run("Write-Output 'fine'", DIR, ps!.id);
    expect(out).toContain("fine");
    expect(exit.code).toBe(0);
  });

  it("takes a native program's exit code over the cmdlet channel", async () => {
    const { exit } = await run("git nope-not-a-command", DIR, ps!.id);
    expect(exit.code).toBe(1);
  });

  it("keeps non-ASCII intact through the script file", async () => {
    const { out } = await run("Write-Output 'ünïcodé — ✓'", DIR, ps!.id);
    expect(out).toContain("ünïcodé — ✓");
  });

  it("follows Set-Location the way it follows cd", async () => {
    const { exit } = await run("Set-Location sub", DIR, ps!.id);
    expect(path.resolve(exit.cwd!).toLowerCase()).toBe(path.join(DIR, "sub").toLowerCase());
  });
});
