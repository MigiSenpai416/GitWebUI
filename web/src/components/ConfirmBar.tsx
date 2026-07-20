import { useEffect } from "react";
import { useStore } from "../state/store";
import "./ConfirmBar.css";

/**
 * The single, shared confirmation UI for destructive actions: a banner across
 * the top of the window with a red confirm button and a cancel button.
 * Driven by store.requestConfirm / resolveConfirm.
 */
export function ConfirmBar() {
  const confirm = useStore((s) => s.confirm);
  const resolve = useStore((s) => s.resolveConfirm);

  useEffect(() => {
    if (!confirm) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") resolve(false);
      else if (e.key === "Enter") resolve(true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [confirm, resolve]);

  if (!confirm) return null;

  return (
    <div className="confirm-bar" role="alertdialog" aria-label="Confirm destructive action">
      <span className="confirm-msg">{confirm.message}</span>
      <button className="confirm-yes" onClick={() => resolve(true)} autoFocus>
        {confirm.confirmLabel}
      </button>
      <button className="confirm-no" onClick={() => resolve(false)}>
        Cancel
      </button>
    </div>
  );
}
