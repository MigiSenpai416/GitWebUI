import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import "./CommitContextMenu.css";

const MENU_W = 240;

/** Right-click / click menu for a stash row: pop, apply, or drop it. */
export function StashContextMenu() {
  const menu = useStore((s) => s.stashMenu);
  const close = useStore((s) => s.closeStashMenu);
  const pop = useStore((s) => s.stashPop);
  const apply = useStore((s) => s.stashApply);
  const drop = useStore((s) => s.stashDrop);
  const requestConfirm = useStore((s) => s.requestConfirm);

  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: -9999, top: -9999 });

  useLayoutEffect(() => {
    if (!menu) return;
    const h = ref.current?.offsetHeight ?? 140;
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
  const ref_ = `stash@{${menu.index}}`;

  const onDrop = async () => {
    close();
    const ok = await requestConfirm(
      `This is a destructive operation, are you sure you want to drop ${ref_}?`,
      "Drop",
    );
    if (ok) drop(menu.index);
  };

  return (
    <div
      className="ctx-menu"
      ref={ref}
      style={{ left: pos.left, top: pos.top, width: MENU_W }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button className="ctx-item" onClick={() => pop(menu.index)}>
        <span className="ctx-icon">⤒</span>
        Pop stash
        <span className="ctx-hint">apply &amp; remove</span>
      </button>
      <button className="ctx-item" onClick={() => apply(menu.index)}>
        <span className="ctx-icon">⎘</span>
        Apply stash
        <span className="ctx-hint">keep in list</span>
      </button>
      <button className="ctx-item" onClick={onDrop}>
        <span className="ctx-icon ctx-revert">🗑</span>
        Drop stash
      </button>
      <div className="ctx-footer">{ref_}</div>
    </div>
  );
}
