import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import type { ResetMode } from "../state/store";
import { IconBranch, IconChevron, IconCommit, IconMonitor } from "./icons";
import "./CommitContextMenu.css";

const MENU_W = 260;

export function CommitContextMenu() {
  const menu = useStore((s) => s.commitMenu);
  const repo = useStore((s) => s.repo);
  const commits = useStore((s) => s.commits);
  const close = useStore((s) => s.closeCommitMenu);
  const openBranchDialog = useStore((s) => s.openBranchDialog);
  const resetToCommit = useStore((s) => s.resetToCommit);
  const revertCommit = useStore((s) => s.revertCommit);
  const checkoutCommit = useStore((s) => s.checkoutCommit);
  const cherryPick = useStore((s) => s.cherryPick);
  const requestConfirm = useStore((s) => s.requestConfirm);
  const requestChoice = useStore((s) => s.requestChoice);

  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: -9999, top: -9999 });
  const [resetOpen, setResetOpen] = useState(false);

  // Clamp the menu inside the viewport once it has a measured height.
  useLayoutEffect(() => {
    if (!menu) return;
    const h = ref.current?.offsetHeight ?? 200;
    const left = Math.min(menu.x, window.innerWidth - MENU_W - 8);
    const top = Math.min(menu.y, window.innerHeight - h - 8);
    setPos({ left: Math.max(8, left), top: Math.max(8, top) });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu, close]);

  if (!menu) return null;
  const commit = commits.find((c) => c.hash === menu.hash);
  const shortHash = commit?.shortHash ?? menu.hash.slice(0, 7);
  const branch = repo?.branch ?? "HEAD";

  const doReset = async (mode: ResetMode) => {
    // A hard reset discards all uncommitted work — confirm it.
    if (mode === "hard") {
      close();
      const ok = await requestConfirm(
        `This is a destructive operation, are you sure you want to hard reset "${branch}" to ${shortHash}? All uncommitted changes will be discarded.`,
        "Reset",
      );
      if (!ok) return;
    }
    resetToCommit(menu.hash, mode);
  };

  const doCheckout = () => {
    close();
    checkoutCommit(menu.hash);
  };

  const doCherryPick = async () => {
    close();
    const choice = await requestChoice(
      "Do you want to immediately commit the cherry picked changes?",
      [
        { label: "Yes", value: "yes", kind: "primary" },
        { label: "No", value: "no", kind: "neutral" },
        { label: "Cancel", value: "cancel", kind: "danger" },
      ],
    );
    if (choice === "yes") cherryPick(menu.hash, false);
    else if (choice === "no") cherryPick(menu.hash, true);
  };

  return (
    <div
      className="ctx-menu"
      ref={ref}
      style={{ left: pos.left, top: pos.top, width: MENU_W }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button className="ctx-item" onClick={doCheckout}>
        <IconMonitor width={15} height={15} className="ctx-icon" />
        Checkout this commit
      </button>

      <button className="ctx-item" onClick={() => openBranchDialog(menu.hash)}>
        <IconBranch width={15} height={15} className="ctx-icon" />
        Create branch here
      </button>

      <button className="ctx-item" onClick={doCherryPick}>
        <IconCommit width={15} height={15} className="ctx-icon" />
        Cherry pick commit
      </button>

      <div
        className="ctx-item ctx-has-sub"
        onMouseEnter={() => setResetOpen(true)}
        onMouseLeave={() => setResetOpen(false)}
      >
        <span className="ctx-reset-label">
          Reset <span className="ctx-branch">{branch}</span> to this commit
        </span>
        <IconChevron width={11} height={11} className="ctx-sub-caret" />
        {resetOpen && (
          <div className="ctx-submenu">
            <button className="ctx-sub-item" onClick={() => doReset("hard")}>
              <span className="ctx-sub-title">Hard</span>
              <span className="ctx-sub-desc">Discard all changes</span>
            </button>
            <button className="ctx-sub-item" onClick={() => doReset("mixed")}>
              <span className="ctx-sub-title">Mixed</span>
              <span className="ctx-sub-desc">Keep working copy, reset the index</span>
            </button>
            <button className="ctx-sub-item" onClick={() => doReset("soft")}>
              <span className="ctx-sub-title">Soft</span>
              <span className="ctx-sub-desc">Keep all changes (staged)</span>
            </button>
          </div>
        )}
      </div>

      <button className="ctx-item" onClick={() => revertCommit(menu.hash)}>
        <span className="ctx-icon ctx-revert">⤺</span>
        Revert commit
      </button>

      <div className="ctx-footer">{shortHash}</div>
    </div>
  );
}
