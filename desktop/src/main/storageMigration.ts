import { promises as fs } from "node:fs";
import path from "node:path";
import { app, net, session, type WebContents } from "electron";
import { log } from "./log.js";
import { APP_URL, BLANK_PAGE, BLANK_PATH } from "./protocol.js";

/**
 * Carry the UI's remembered state over from where earlier releases kept it.
 *
 * Up to 0.3.0 the window was served from http://127.0.0.1:5175, and the UI's
 * localStorage — the open tabs, the sidebar state, which refs are shown — is
 * keyed by origin. Moving the UI to gitwebui://app left all of it behind:
 * still in the profile on disk, just filed under an origin nothing loads any
 * more. There is no main-process API for another origin's storage, so the
 * window itself, before it loads the UI, is pointed at a blank page answered
 * for the old origin to read it out, then at a blank page on the new origin
 * to write it in. Done once, recorded by a file in the profile, and skipped
 * outright on a profile with nothing from the old origin in it: a fresh
 * install never pays for it.
 */

const LEGACY_ORIGIN = "http://127.0.0.1:5175";
const MARKER = "storage-migrated";
const TABS_KEY = "gwui.tabs";

type Entries = Record<string, string>;

interface RepoTab {
  id: string;
  root: string | null;
  name: string;
  branch: string;
}

interface SavedTabs {
  tabs: RepoTab[];
  activeTabId: string | null;
}

/** Run the carry-over in `contents`, which must not have loaded the UI yet. */
export async function migrateLegacyStorage(contents: WebContents): Promise<void> {
  const userData = app.getPath("userData");
  const marker = path.join(userData, MARKER);
  if (await exists(marker)) return;
  try {
    if (await hasLegacyStorage(userData)) {
      const legacy = await readLegacyOrigin(contents);
      if (Object.keys(legacy).length > 0) {
        const blank = APP_URL + BLANK_PATH.slice(1);
        const current = await readOrigin(contents, blank);
        const merged = merge(legacy, current);
        await writeOrigin(contents, blank, merged);
        log.info(
          `carried ${Object.keys(merged).length} saved UI entries over from ${LEGACY_ORIGIN}`,
        );
      }
    }
  } catch (error) {
    // Not worth more than a line: the app works without its remembered tabs.
    log.error("could not carry over the saved UI state:", error);
  } finally {
    await fs.writeFile(marker, new Date().toISOString()).catch(() => undefined);
  }
}

/**
 * Whether an old build ever stored anything here. Chromium keeps localStorage
 * in a LevelDB keyed by origin, and the origin appears in its files as plain
 * text — in the log of recent writes, the manifest, and the table files, where
 * the first key of every block is written in full. Looking for it is far
 * cheaper than loading a page for the old origin, and a fresh profile, which
 * Chromium creates the directory for before anything is stored, never has it.
 */
async function hasLegacyStorage(userData: string): Promise<boolean> {
  const dir = path.join(userData, "Local Storage", "leveldb");
  const needle = Buffer.from(new URL(LEGACY_ORIGIN).host);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return false;
  }
  for (const name of names) {
    try {
      if ((await fs.readFile(path.join(dir, name))).includes(needle)) return true;
    } catch {
      /* a file Chromium holds exclusively, or one that just went away */
    }
  }
  return false;
}

/**
 * Everything the new origin doesn't have yet, plus the tabs of both: a repo
 * opened in the new build before this ran is kept alongside the old ones.
 */
export function merge(legacy: Entries, current: Entries): Entries {
  const merged: Entries = {};
  for (const [key, value] of Object.entries(legacy)) {
    if (key !== TABS_KEY && !(key in current)) merged[key] = value;
  }
  const old = parseTabs(legacy[TABS_KEY]);
  const now = parseTabs(current[TABS_KEY]);
  if (old) {
    const roots = new Set(old.tabs.map((tab) => tab.root));
    const tabs = [
      ...old.tabs,
      ...(now?.tabs ?? []).filter((tab) => tab.root !== null && !roots.has(tab.root)),
    ];
    merged[TABS_KEY] = JSON.stringify({ tabs, activeTabId: now?.activeTabId ?? old.activeTabId });
  }
  return merged;
}

function parseTabs(raw: string | undefined): SavedTabs | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SavedTabs>;
    if (!Array.isArray(parsed.tabs) || parsed.tabs.length === 0) return null;
    return { tabs: parsed.tabs, activeTabId: parsed.activeTabId ?? null };
  } catch {
    return null;
  }
}

/**
 * The old origin's storage. Nothing serves that address any more, so for the
 * duration of the read, http requests for it are answered from here with a
 * blank page; every other http request passes through untouched.
 */
async function readLegacyOrigin(contents: WebContents): Promise<Entries> {
  const { protocol } = session.defaultSession;
  protocol.handle("http", (request) => {
    if (request.url.startsWith(`${LEGACY_ORIGIN}/`)) {
      return new Response(BLANK_PAGE, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    return net.fetch(request, { bypassCustomProtocolHandlers: true });
  });
  try {
    return await readOrigin(contents, `${LEGACY_ORIGIN}/`);
  } finally {
    protocol.unhandle("http");
  }
}

async function readOrigin(contents: WebContents, url: string): Promise<Entries> {
  await contents.loadURL(url);
  return (await contents.executeJavaScript(
    "Object.fromEntries(Object.entries(localStorage))",
  )) as Entries;
}

async function writeOrigin(contents: WebContents, url: string, entries: Entries): Promise<void> {
  await contents.loadURL(url);
  await contents.executeJavaScript(
    `for (const [key, value] of Object.entries(${JSON.stringify(entries)})) localStorage.setItem(key, value);`,
  );
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
