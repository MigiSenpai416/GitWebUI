import { useEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import { IconBranch, IconCheck, IconDots, IconMerge, IconTrash } from "./icons";
import "./BranchMenu.css";

/** Which branch's action popover is open, anchored at these screen coords. */
interface ActionsAnchor {
  name: string;
  x: number;
  y: number;
}

export function BranchMenu({ onClose }: { onClose: () => void }) {
  const branches = useStore((s) => s.branches);
  const repo = useStore((s) => s.repo);
  const checkout = useStore((s) => s.checkout);
  const deleteBranch = useStore((s) => s.deleteBranch);
  const mergeBranch = useStore((s) => s.mergeBranch);
  const requestConfirm = useStore((s) => s.requestConfirm);
  const requestChoice = useStore((s) => s.requestChoice);
  const ref = useRef<HTMLDivElement>(null);

  const current = repo?.branch ?? "";
  const [actions, setActions] = useState<ActionsAnchor | null>(null);

  // Close on outside click or Escape.
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") (actions ? setActions(null) : onClose());
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose, actions]);

  const pick = (name: string) => {
    if (name !== current) checkout(name);
    onClose();
  };

  const remove = async (name: string) => {
    onClose();
    const ok = await requestConfirm(
      `This is a destructive operation, are you sure you want to delete "${name}"?`,
      "Delete",
    );
    if (ok) deleteBranch(name);
  };

  const merge = async (name: string) => {
    onClose();
    const choice = await requestChoice(`Merge "${name}" into "${current}"?`, [
      { label: "Merge", value: "merge", kind: "primary" },
      { label: "Cancel", value: "cancel", kind: "neutral" },
    ]);
    if (choice === "merge") mergeBranch(name);
  };

  const openActions = (name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (actions?.name === name) {
      setActions(null);
      return;
    }
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setActions({ name, x: r.right, y: r.bottom });
  };

  return (
    <div className="branch-menu" ref={ref}>
      <div className="branch-menu-head">Local branches</div>
      <div className="branch-menu-list">
        {branches.length === 0 && <div className="branch-menu-empty">No local branches</div>}
        {branches.map((b) => (
          <div key={b.name} className={"branch-row" + (actions?.name === b.name ? " menu-open" : "")}>
            <button className="bmi-main" onClick={() => pick(b.name)}>
              <span className="bmi-check">{b.current ? <IconCheck /> : null}</span>
              <IconBranch className="bmi-icon" width={14} height={14} />
              <span className="bmi-name">{b.name}</span>
              <span className="bmi-hash">{b.shortHash}</span>
            </button>
            {b.current ? (
              <span className="bmi-more-slot" aria-hidden />
            ) : (
              <button
                className="bmi-more"
                title="Branch actions"
                onClick={(e) => openActions(b.name, e)}
              >
                <IconDots width={16} height={16} />
              </button>
            )}
          </div>
        ))}
      </div>

      {actions && (
        <div
          className="branch-actions"
          style={{ top: actions.y + 4, left: Math.max(8, actions.x - 200) }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button className="branch-action" onClick={() => pick(actions.name)}>
            <IconBranch width={14} height={14} className="ba-icon" />
            Checkout
          </button>
          <button className="branch-action" onClick={() => merge(actions.name)}>
            <IconMerge width={14} height={14} className="ba-icon" />
            Merge into <span className="ba-branch">{current}</span>
          </button>
          <div className="branch-action-sep" />
          <button className="branch-action danger" onClick={() => remove(actions.name)}>
            <IconTrash width={14} height={14} className="ba-icon" />
            Delete branch
          </button>
        </div>
      )}
    </div>
  );
}
