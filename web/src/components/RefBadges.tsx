import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CommitRef } from "../types";
import { RefBadge } from "./RefBadge";
import "./RefBadges.css";

/**
 * Renders the ref badges for a commit. When more than one ref points here, only
 * a single representative badge is shown (the current branch if present, else
 * the first); hovering it reveals the full ordered list in a popover.
 */
export function RefBadges({ refs }: { refs: CommitRef[] }) {
  const visible = refs.filter((r) => !(r.kind === "head" && r.name === "HEAD"));
  const triggerRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  const [rect, setRect] = useState<DOMRect | null>(null);

  if (visible.length === 0) return null;
  if (visible.length === 1) return <RefBadge refInfo={visible[0]} />;

  const primary = visible.find((r) => r.isHead) ?? visible[0];

  const show = () => {
    window.clearTimeout(closeTimer.current);
    if (triggerRef.current) setRect(triggerRef.current.getBoundingClientRect());
  };
  const scheduleHide = () => {
    closeTimer.current = window.setTimeout(() => setRect(null), 140);
  };

  return (
    <div className="ref-group" ref={triggerRef} onMouseEnter={show} onMouseLeave={scheduleHide}>
      <RefBadge refInfo={primary} />
      <span className="ref-more">+{visible.length - 1}</span>

      {rect &&
        createPortal(
          <div
            className="ref-popover"
            style={{ top: rect.bottom + 4, left: rect.left }}
            onMouseEnter={show}
            onMouseLeave={scheduleHide}
          >
            {visible.map((r) => (
              <RefBadge key={r.kind + r.name} refInfo={r} />
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
