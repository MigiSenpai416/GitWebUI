import { promises as fs } from "node:fs";
import path from "node:path";
import { app, screen, type BrowserWindow, type Rectangle } from "electron";

/**
 * Remembers where the window was.
 *
 * Kept under Electron's own `userData` rather than with the git config: it is a
 * property of this installation's UI, not of the user's repositories, and a
 * headless server has no use for it.
 */

const DEFAULT_WIDTH = 1440;
const DEFAULT_HEIGHT = 900;
const MIN_WIDTH = 900;
const MIN_HEIGHT = 560;
const SAVE_DEBOUNCE_MS = 400;

export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

const stateFile = () => path.join(app.getPath("userData"), "window-state.json");

function defaults(): WindowState {
  return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, maximized: false };
}

/**
 * Is this rectangle somewhere the user can actually see?
 *
 * A window restored onto a monitor that has since been unplugged opens
 * off-screen, and looks to the user exactly like an app that failed to start.
 * Requiring a real overlap with some display — not merely that the origin is
 * inside one — also catches the case of a window mostly hanging off an edge.
 */
function isVisible(bounds: Rectangle): boolean {
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    const overlapX = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
    const overlapY = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);
    // Enough of the title bar to grab, and enough width to recognise it by.
    return overlapX > 120 && overlapY > 40;
  });
}

export async function loadWindowState(): Promise<WindowState> {
  try {
    const parsed = JSON.parse(await fs.readFile(stateFile(), "utf8")) as Partial<WindowState>;
    const width = Number(parsed.width);
    const height = Number(parsed.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return defaults();

    const state: WindowState = {
      width: Math.max(MIN_WIDTH, Math.round(width)),
      height: Math.max(MIN_HEIGHT, Math.round(height)),
      maximized: Boolean(parsed.maximized),
    };

    const x = Number(parsed.x);
    const y = Number(parsed.y);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      const bounds = { x: Math.round(x), y: Math.round(y), width: state.width, height: state.height };
      // Dropping just the position lets Electron centre the window at the
      // remembered size, which is a better answer than resetting both.
      if (isVisible(bounds)) {
        state.x = bounds.x;
        state.y = bounds.y;
      }
    }
    return state;
  } catch {
    return defaults();
  }
}

/** Persist bounds as they change. Returns a function that stops watching. */
export function trackWindowState(window: BrowserWindow): () => void {
  let timer: NodeJS.Timeout | null = null;
  let closed = false;

  const capture = (): WindowState => {
    const maximized = window.isMaximized();
    // While maximized the *normal* bounds are what should be restored, so
    // un-maximizing later returns the window to the size it had before.
    const bounds = maximized ? window.getNormalBounds() : window.getBounds();
    return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, maximized };
  };

  const write = async (state: WindowState): Promise<void> => {
    try {
      await fs.mkdir(path.dirname(stateFile()), { recursive: true });
      await fs.writeFile(stateFile(), JSON.stringify(state, null, 2), "utf8");
    } catch {
      /* where the window was is never worth failing over */
    }
  };

  const schedule = (): void => {
    if (closed || window.isDestroyed() || window.isMinimized()) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void write(capture()), SAVE_DEBOUNCE_MS);
  };

  // Listed one by one rather than looped: BrowserWindow.on is a set of
  // per-event overloads, so a union of event names matches none of them.
  window.on("resize", schedule);
  window.on("move", schedule);
  window.on("maximize", schedule);
  window.on("unmaximize", schedule);

  // The debounce would otherwise lose the last change on a quick close, so the
  // final state is captured synchronously while the window still exists.
  const onClose = (): void => {
    if (timer) clearTimeout(timer);
    if (!window.isDestroyed() && !window.isMinimized()) void write(capture());
    closed = true;
  };
  window.on("close", onClose);

  return () => {
    if (timer) clearTimeout(timer);
    closed = true;
  };
}

export const WINDOW_MIN_SIZE = { width: MIN_WIDTH, height: MIN_HEIGHT };
