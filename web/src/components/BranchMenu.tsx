import { useEffect, useRef } from "react";
import { useStore } from "../state/store";
import { IconBranch, IconCheck } from "./icons";
import "./BranchMenu.css";

export function BranchMenu({ onClose }: { onClose: () => void }) {
  const branches = useStore((s) => s.branches);
  const repo = useStore((s) => s.repo);
  const checkout = useStore((s) => s.checkout);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape.
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const pick = (name: string) => {
    if (name !== repo?.branch) checkout(name);
    onClose();
  };

  return (
    <div className="branch-menu" ref={ref}>
      <div className="branch-menu-head">Local branches</div>
      <div className="branch-menu-list">
        {branches.length === 0 && <div className="branch-menu-empty">No local branches</div>}
        {branches.map((b) => (
          <button key={b.name} className="branch-menu-item" onClick={() => pick(b.name)}>
            <span className="bmi-check">{b.current ? <IconCheck /> : null}</span>
            <IconBranch className="bmi-icon" width={14} height={14} />
            <span className="bmi-name">{b.name}</span>
            <span className="bmi-hash">{b.shortHash}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
