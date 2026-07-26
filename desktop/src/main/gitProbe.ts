import { dialog, shell, type BrowserWindow } from "electron";
import {
  isUsableGit,
  resolveGitPath,
  saveGitPathOverride,
  setGitPath,
} from "../../../server/src/git/gitPath.js";

/**
 * Finding git, and asking the user for help when it can't be found.
 *
 * A desktop app doesn't necessarily get the environment a shell would: a PATH
 * change made after login won't have reached an already-running Explorer, so an
 * app launched from the Start menu can miss a git that works fine in a terminal.
 * `resolveGitPath` handles the search — this module handles the consequences.
 */

const DOWNLOAD_URL = "https://git-scm.com/download/win";

let probe: Promise<string | null> | null = null;

/**
 * Start looking for git. Called during startup *without* being awaited, so the
 * search overlaps window creation rather than delaying the first paint.
 */
export function beginGitProbe(): Promise<string | null> {
  if (!probe) {
    probe = resolveGitPath().then((found) => {
      if (found) setGitPath(found);
      return found;
    });
  }
  return probe;
}

/** Whatever the probe settled on, waiting for it if it is still running. */
export function gitProbeResult(): Promise<string | null> {
  return beginGitProbe();
}

/**
 * If git couldn't be found, say so and offer the two things that actually help:
 * point at an install we missed, or go and get one. Returns the path if the
 * user resolved it, else null.
 *
 * Deliberately not fatal. The app opens either way and every git operation
 * reports the same "git is not installed or not on PATH" it always has, so the
 * user can install git and use Locate afterwards without a restart.
 */
export async function ensureGitOrPrompt(window: BrowserWindow | null): Promise<string | null> {
  const found = await gitProbeResult();
  if (found) return found;

  const detail =
    "GitWebUI needs the git command-line tool, and couldn't find it on this machine. " +
    "Install Git for Windows and restart GitWebUI — or point it at an existing git.exe " +
    "if you already have one.";
  const buttons = ["Locate git…", "Download Git", "Continue Anyway"];
  const options: Electron.MessageBoxOptions = {
    type: "warning",
    title: "Git not found",
    message: "GitWebUI needs git",
    detail,
    buttons,
    defaultId: 0,
    cancelId: 2,
  };

  const answer = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options);

  if (answer.response === 1) {
    await shell.openExternal(DOWNLOAD_URL);
    return null;
  }
  if (answer.response !== 0) return null;

  return locateGit(window);
}

/**
 * Ask the user to point at a git executable, and verify it before keeping it —
 * a wrong choice saved unchecked would fail every git call from then on, and
 * survive a restart.
 */
export async function locateGit(window: BrowserWindow | null): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title: "Locate git.exe",
    buttonLabel: "Use this git",
    properties: ["openFile"],
    filters: [{ name: "Programs", extensions: ["exe"] }],
    defaultPath: "C:\\Program Files\\Git\\cmd",
  };

  const picked = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  if (picked.canceled || picked.filePaths.length === 0) return null;

  const candidate = picked.filePaths[0];
  if (!(await isUsableGit(candidate))) {
    const retry = await dialog.showMessageBox({
      type: "error",
      title: "Not a working git",
      message: "That file didn't run as git",
      detail: `${candidate} either isn't git or couldn't be started. Look for git.exe in a Git installation's cmd folder — usually C:\\Program Files\\Git\\cmd\\git.exe.`,
      buttons: ["Try Again", "Cancel"],
      defaultId: 0,
      cancelId: 1,
    });
    return retry.response === 0 ? locateGit(window) : null;
  }

  setGitPath(candidate);
  await saveGitPathOverride(candidate);
  probe = Promise.resolve(candidate);
  return candidate;
}
