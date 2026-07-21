import { useEffect } from "react";
import { useStore } from "../state/store";
import "./ConfirmBar.css";

/**
 * The single, shared confirmation UI for destructive actions and multi-way
 * choices: a banner across the top of the window with one or more buttons.
 * Driven by store.requestConfirm / requestChoice / resolveConfirm. Enter picks
 * the first button; Escape dismisses (resolves null).
 */
export function ConfirmBar() {
  const confirm = useStore((s) => s.confirm);
  const resolve = useStore((s) => s.resolveConfirm);
  const checkbox = useStore((s) => s.confirmCheckbox);
  const setCheckbox = useStore((s) => s.setConfirmCheckbox);

  useEffect(() => {
    if (!confirm) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") resolve(null);
      else if (e.key === "Enter") resolve(confirm.buttons[0]?.value ?? null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [confirm, resolve]);

  if (!confirm) return null;

  return (
    <div className="confirm-bar" role="alertdialog" aria-label="Confirm action">
      <span className="confirm-msg">{confirm.message}</span>
      {confirm.buttons.map((b, i) => (
        <button
          key={b.value}
          className={"confirm-btn " + b.kind}
          onClick={() => resolve(b.value)}
          autoFocus={i === 0}
        >
          {b.label}
        </button>
      ))}
      {confirm.checkbox && (
        <label className="confirm-check">
          <input
            type="checkbox"
            checked={checkbox}
            onChange={(e) => setCheckbox(e.target.checked)}
          />
          {confirm.checkbox}
        </label>
      )}
    </div>
  );
}
