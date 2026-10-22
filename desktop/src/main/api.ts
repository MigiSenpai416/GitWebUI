import { ipcMain, type WebContents } from "electron";
import { dispatch, errorMessage, errorStatus } from "../../../core/src/api.js";
import type { RunEvent } from "../../../core/src/terminal.js";
import { CH, type ApiReply, type ApiRequest } from "./channels.js";

/**
 * The renderer's way into core/src/api.ts.
 *
 * Every call is tracked by the window that made it, so it can be given up on:
 * by the renderer asking (an AbortSignal fired), by the window reloading,
 * crashing or closing, or by the app quitting. Giving up aborts the call's signal, which is
 * what stops the git process behind a slow read and kills a running terminal
 * command — nothing is left working for a page that is no longer there.
 */

/** Calls in flight, per window, by the id the renderer gave them. */
const inFlight = new Map<WebContents, Map<number, AbortController>>();
/** Windows whose reloads and closing are already being watched. */
const watched = new WeakSet<WebContents>();

function abortAll(contents: WebContents): void {
  const calls = inFlight.get(contents);
  if (!calls) return;
  inFlight.delete(contents);
  for (const controller of calls.values()) controller.abort();
}

function watch(contents: WebContents): void {
  if (watched.has(contents)) return;
  watched.add(contents);
  contents.once("destroyed", () => abortAll(contents));
  // A reload or navigation leaves the calls of the page that made them
  // behind; that page will never read the answers. Only a navigation that
  // commits counts: one refused in `will-navigate` (a file dropped on the
  // window) leaves the page — and its running command — exactly where it was.
  contents.on("did-navigate", () => abortAll(contents));
  // A crashed renderer is not coming back for its answers either.
  contents.on("render-process-gone", () => abortAll(contents));
}

function begin(contents: WebContents, id: number): AbortController {
  watch(contents);
  let calls = inFlight.get(contents);
  if (!calls) {
    calls = new Map();
    inFlight.set(contents, calls);
  }
  // A reused id would orphan the earlier call's controller; give it up first.
  calls.get(id)?.abort();
  const controller = new AbortController();
  calls.set(id, controller);
  return controller;
}

function end(contents: WebContents, id: number, controller: AbortController): void {
  const calls = inFlight.get(contents);
  if (calls?.get(id) === controller) calls.delete(id);
}

/** Stop every call in every window. For shutdown. */
export function abortAllCalls(): void {
  for (const contents of [...inFlight.keys()]) abortAll(contents);
}

type Proceed = () => Promise<unknown>;
type Stub = (input: unknown, proceed: Proceed) => unknown;

/**
 * Seams for the end-to-end tests, present only when `GITWEBUI_E2E=1`: a stub
 * per route that can answer instead of the real handler (or wrap it — `proceed`
 * runs the real one), and a log of every call made. The tests reach them from
 * Playwright's `app.evaluate`, which runs in this process.
 */
interface E2EHooks {
  stubs: Map<string, Stub>;
  calls: { route: string; input: unknown }[];
}

const e2e: E2EHooks | null = process.env.GITWEBUI_E2E === "1" ? { stubs: new Map(), calls: [] } : null;
if (e2e) (globalThis as { __gitwebuiE2E?: E2EHooks }).__gitwebuiE2E = e2e;

export function registerApi(): void {
  ipcMain.handle(CH.api, async (event, request: ApiRequest): Promise<ApiReply> => {
    const id = request?.id;
    const route = request?.route;
    if (!Number.isSafeInteger(id) || typeof route !== "string") {
      return { ok: false, status: 400, error: "Malformed call" };
    }
    const contents = event.sender;
    const controller = begin(contents, id);
    const emit =
      route === "terminalRun"
        ? (e: RunEvent) => {
            if (!contents.isDestroyed()) contents.send(CH.terminalEvent, id, e);
          }
        : undefined;
    const proceed = () =>
      dispatch(route, request.input, {
        root: typeof request.root === "string" ? request.root : "",
        signal: controller.signal,
        emit,
      });
    try {
      let result: unknown;
      if (e2e) {
        e2e.calls.push({ route, input: request.input });
        const stub = e2e.stubs.get(route);
        result = stub ? await stub(request.input, proceed) : await proceed();
      } else {
        result = await proceed();
      }
      return { ok: true, json: JSON.stringify(result ?? null) };
    } catch (error) {
      return { ok: false, status: errorStatus(error), error: errorMessage(error) };
    } finally {
      end(contents, id, controller);
    }
  });

  ipcMain.on(CH.cancel, (event, id: unknown) => {
    if (typeof id !== "number") return;
    inFlight.get(event.sender)?.get(id)?.abort();
  });
}
