import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { useStore } from "./store";
import type { CommitFile } from "../types";

beforeEach(() => {
  useStore.setState({
    repo: { root: "C:/repo", branch: "main", head: "head" },
    selectedCommitHash: null, selectedStashHash: null, selectionVersion: 0,
    commitFiles: [], loadingCommitFiles: false, toasts: [],
  });
});

afterEach(() => vi.restoreAllMocks());

describe("commit selection requests", () => {
  it.each(["selectCommit", "selectStash"] as const)("cancels superseded reads and keeps %s loading until its own response", async (select) => {
    const responses: Array<(value: { files: CommitFile[] }) => void> = [];
    const requests = vi.spyOn(api, "commitFiles").mockImplementation(() => new Promise((resolve) => { responses.push(resolve); }));
    const first = useStore.getState().selectCommit("first");
    const latest = useStore.getState()[select]("latest");
    expect(requests.mock.calls[0][1]?.aborted).toBe(true);
    responses[0]({ files: [{ path: "stale", status: "A" }] });
    await first;
    expect(useStore.getState().loadingCommitFiles).toBe(true);
    expect(useStore.getState().commitFiles).toEqual([]);
    responses[1]({ files: [{ path: "latest", status: "M" }] });
    await latest;
    expect(useStore.getState().loadingCommitFiles).toBe(false);
    expect(useStore.getState().commitFiles).toEqual([{ path: "latest", status: "M" }]);
  });

  it("leaves working changes selected and suppresses canceled errors", async () => {
    let reject!: (error: Error) => void;
    const request = vi.spyOn(api, "commitFiles").mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    const pending = useStore.getState().selectCommit("first");
    await useStore.getState().selectCommit(null);
    reject(new Error("canceled"));
    await pending;
    expect(request.mock.calls[0][1]?.aborted).toBe(true);
    expect(useStore.getState()).toMatchObject({ selectedCommitHash: null, loadingCommitFiles: false, commitFiles: [], toasts: [] });
  });
});
