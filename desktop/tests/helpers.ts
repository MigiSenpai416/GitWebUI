import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Launching the app under test, in isolation from the developer's own copy.
 *
 * Isolation is not automatic and getting it wrong is quiet. The app pins its
 * Electron profile to a fixed directory — that is what lets it remember open
 * tabs between launches. The cost is that a test launched with the defaults
 * shares it with the installed app: it would read the developer's real open
 * tabs (and could pass because of them) and overwrite them on the way out.
 *
 * So every launch here gets two throwaway things: a config directory and an
 * Electron profile. It also turns on the main process's test seams
 * (`GITWEBUI_E2E`), which `stubRoute` and `callLog` below reach into.
 */

const desktopDir = path.resolve(__dirname, "..");
const mainEntry = path.join(desktopDir, "dist", "main.js");

export interface TestApp {
  app: ElectronApplication;
  /** Config dir (recent repos, GitHub token, AI settings) — main-process state. */
  configDir: string;
  /** Electron profile (localStorage, caches) — renderer-side state. */
  userDataDir: string;
}

export interface LaunchOptions {
  /**
   * Reuse an earlier launch's directories, so the app sees the state it left
   * behind. This is what makes a restart a restart rather than a fresh install.
   */
  reuse?: Pick<TestApp, "configDir" | "userDataDir">;
}

/** Launch the app — the packaged binary when `GITWEBUI_E2E_BINARY` names one. */
export async function launchApp(options: LaunchOptions = {}): Promise<TestApp> {
  const id = randomBytes(6).toString("hex");
  const configDir = options.reuse?.configDir ?? path.join(os.tmpdir(), `gitwebui-e2e-cfg-${id}`);
  const userDataDir =
    options.reuse?.userDataDir ?? path.join(os.tmpdir(), `gitwebui-e2e-profile-${id}`);

  // The size the suite was written against. Left to the app, a fresh profile
  // opens at its default and the screen it lands on decides the rest, which
  // on a CI runner's small display squeezes the layout in ways the assertions
  // were never meant to cover.
  if (!options.reuse) {
    await fs.mkdir(userDataDir, { recursive: true });
    await fs.writeFile(
      path.join(userDataDir, "window-state.json"),
      JSON.stringify({ width: 1440, height: 900, maximized: false }),
    );
  }

  const packaged = process.env.GITWEBUI_E2E_BINARY;
  const app = await electron.launch({
    ...(packaged ? { executablePath: packaged, args: [] } : { args: [mainEntry] }),
    env: {
      ...process.env,
      GITWEBUI_CONFIG_DIR: configDir,
      GITWEBUI_USER_DATA_DIR: userDataDir,
      GITWEBUI_E2E: "1",
    },
  });

  return { app, configDir, userDataDir };
}

/** Remove a launch's directories. Safe to call for a reused pair, once. */
export async function cleanupApp(app: Pick<TestApp, "configDir" | "userDataDir">): Promise<void> {
  await fs.rm(app.configDir, { recursive: true, force: true });
  await fs.rm(app.userDataDir, { recursive: true, force: true });
}

/** What a route's stub is handed: the call's input, the real handler, and `arg`. */
export type Stub<A> = (
  input: Record<string, unknown>,
  proceed: () => Promise<unknown>,
  arg: A,
) => unknown;

/** The main process's `globalThis`, as the helpers below use it. */
interface MainGlobals {
  /** The seams themselves — see desktop/src/main/api.ts. */
  __gitwebuiE2E: {
    stubs: Map<string, Stub<undefined>>;
    calls: { route: string; input: Record<string, unknown> }[];
  };
  e2eGates?: Record<string, { open: () => void; opened: Promise<void> }>;
  e2eReplies?: Record<string, number>;
}

/**
 * Answer every call to `route` with `stub` instead of the real handler, until
 * it is replaced or removed. A stub fails a call by throwing an error with a
 * `status`, and wraps the real handler by awaiting `proceed()`.
 *
 * The stub runs in the main process, so it is sent there as source and cannot
 * close over anything in the test. What it needs goes in `arg`; state it shares
 * with the test lives on the main process's `globalThis`, which `app.evaluate`
 * can read and change.
 */
export async function stubRoute<A = undefined>(
  app: ElectronApplication,
  route: string,
  stub: Stub<A>,
  arg?: A,
): Promise<void> {
  await app.evaluate(
    (_electron, [name, source, data]) => {
      const run = new Function(`return (${source});`)() as Stub<unknown>;
      (globalThis as unknown as MainGlobals).__gitwebuiE2E.stubs.set(name, (input, proceed) =>
        run(input, proceed, data),
      );
    },
    [route, stub.toString(), arg] as const,
  );
}

/** Hand `route` back to its real handler. */
export async function unstubRoute(app: ElectronApplication, route: string): Promise<void> {
  await app.evaluate((_electron, name) => {
    (globalThis as unknown as MainGlobals).__gitwebuiE2E.stubs.delete(name);
  }, route);
}

/** The input of every call made to `route` since launch, oldest first. */
export async function callLog(
  app: ElectronApplication,
  route: string,
): Promise<Record<string, unknown>[]> {
  return await app.evaluate(
    (_electron, name) =>
      (globalThis as unknown as MainGlobals).__gitwebuiE2E.calls
        .filter((call) => call.route === name)
        .map((call) => call.input),
    route,
  );
}

/**
 * Hold every call to `route` from now on until the returned function is
 * called, then let them through to the real handler — for catching the UI
 * while it waits.
 */
export async function holdRoute(
  app: ElectronApplication,
  route: string,
): Promise<() => Promise<void>> {
  await app.evaluate((_electron, name) => {
    const main = globalThis as unknown as MainGlobals;
    let open = () => {};
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    main.e2eGates = { ...main.e2eGates, [name]: { open, opened } };
  }, route);
  await stubRoute(
    app,
    route,
    async (_input, proceed, name) => {
      await (globalThis as unknown as MainGlobals).e2eGates?.[name].opened;
      return await proceed();
    },
    route,
  );
  return async () => {
    await app.evaluate((_electron, name) => {
      (globalThis as unknown as MainGlobals).e2eGates?.[name].open();
    }, route);
  };
}

/**
 * Count the calls to `route` answered from now on — what `waitForResponse`
 * was for, now that there is no response to wait on. Returns a reader for the
 * count.
 */
export async function countReplies(
  app: ElectronApplication,
  route: string,
): Promise<() => Promise<number>> {
  await stubRoute(
    app,
    route,
    async (_input, proceed, name) => {
      const main = globalThis as unknown as MainGlobals;
      try {
        return await proceed();
      } finally {
        main.e2eReplies = { ...main.e2eReplies, [name]: (main.e2eReplies?.[name] ?? 0) + 1 };
      }
    },
    route,
  );
  return () =>
    app.evaluate(
      (_electron, name) => (globalThis as unknown as MainGlobals).e2eReplies?.[name] ?? 0,
      route,
    );
}

/**
 * Make one call through the window's bridge, the way the UI does, and return
 * what it answers. Throws with the core's message when the call fails.
 */
export async function callApi<T = unknown>(
  window: Page,
  route: string,
  input: Record<string, unknown> = {},
): Promise<T> {
  const reply = await window.evaluate(
    ([name, data]) => {
      const bridge = (globalThis as unknown as {
        gitwebui: {
          call(id: number, route: string, input: unknown, root: string | null): Promise<
            { ok: true; json: string } | { ok: false; status: number; error: string }
          >;
        };
      }).gitwebui;
      // Far above the UI's own call ids: main gives up a call whose id is
      // reused, so this must never stand in for one of them.
      return bridge.call(Number.MAX_SAFE_INTEGER, name, data, null);
    },
    [route, input] as const,
  );
  if (!reply.ok) throw new Error(`${route} failed (${reply.status}): ${reply.error}`);
  return JSON.parse(reply.json) as T;
}

/** A throwaway repository with one commit, so the app has something to show. */
export function makeRepo(): string {
  const dir = path.join(os.tmpdir(), `gitwebui-e2e-repo-${randomBytes(6).toString("hex")}`);
  execFileSync("git", ["init", "-b", "main", dir], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "config", "user.email", "e2e@example.com"], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "config", "user.name", "End To End"], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "config", "commit.gpgsign", "false"], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "commit", "--allow-empty", "-m", "first commit"], {
    stdio: "pipe",
  });
  return dir;
}

export async function removeRepo(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}
