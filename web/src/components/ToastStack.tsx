import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import type { ToastItem } from "../state/store";
import { IconCheck, IconWarning } from "./icons";
import "./ToastStack.css";

/** How long a toast stays up, and how long its exit takes (mirrors ToastStack.css). */
const TOAST_LIFE_MS = 5000;
const TOAST_EXIT_MS = 170;
/** How long a toast takes to slide to its new slot when the stack shifts. */
const SHIFT_MS = 260;
const SHIFT_EASE = "cubic-bezier(0.16, 1, 0.3, 1)";

/**
 * Results of the last few actions, bottom-left, newest nearest the corner. A new
 * toast lands at the bottom and lifts the older ones out of its way; the fourth
 * one takes the oldest one's place.
 */
export function ToastStack() {
  const toasts = useStore((s) => s.toasts);
  const dismissToast = useStore((s) => s.dismissToast);
  const stack = useRef<HTMLDivElement>(null);
  /** Where each toast sat after the last pass, in viewport coordinates. */
  const seats = useRef(new Map<number, number>());

  // The stack grows upwards from the corner, so arriving/leaving toasts re-seat
  // every other one. Flip them: they have already been re-laid-out by the time
  // this runs, so put each one back where the user last saw it and let the
  // browser transition it into its new seat.
  useLayoutEffect(() => {
    const el = stack.current;
    const next = new Map<number, number>();
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    for (const slot of Array.from(el?.children ?? []) as HTMLElement[]) {
      // Freeze any shift still in flight, so `settled` is the seat the toast is
      // headed for and `shown - settled` is how far short of it it currently is.
      const shown = slot.getBoundingClientRect().top;
      slot.style.transition = "none";
      slot.style.transform = "none";
      const settled = slot.getBoundingClientRect().top;
      const was = seats.current.get(Number(slot.dataset.toastId));
      next.set(Number(slot.dataset.toastId), settled);

      const from = was === undefined || still ? 0 : was - settled + (shown - settled);
      if (from !== 0) {
        slot.style.transform = `translateY(${from}px)`;
        void slot.offsetHeight; // commit the starting point before transitioning off it
        slot.style.transition = `transform ${SHIFT_MS}ms ${SHIFT_EASE}`;
      }
      slot.style.transform = "";
    }
    seats.current = next;
  }, [toasts]);

  // A resize can re-wrap messages and move every seat. Re-read them, or the next
  // arrival would slide in from where the stack used to be.
  useEffect(() => {
    const resync = () => {
      const el = stack.current;
      if (!el) return;
      const next = new Map<number, number>();
      for (const slot of Array.from(el.children) as HTMLElement[]) {
        next.set(Number(slot.dataset.toastId), slot.getBoundingClientRect().top);
      }
      seats.current = next;
    };
    window.addEventListener("resize", resync);
    return () => window.removeEventListener("resize", resync);
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="toast-stack" ref={stack}>
      {toasts.map((toast) => (
        // The slot carries the re-seating transform so it can't collide with the
        // toast's own enter/exit animation.
        <div className="toast-slot" key={toast.id} data-toast-id={toast.id}>
          <Toast toast={toast} onClose={() => dismissToast(toast.id)} />
        </div>
      ))}
    </div>
  );
}

/** One message. It retreats the way it arrived — after five seconds, or when dismissed. */
function Toast({ toast, onClose }: { toast: ToastItem; onClose: () => void }) {
  const [leaving, setLeaving] = useState(false);
  // Held in a ref so the exit timer isn't restarted by the parent re-rendering.
  const close = useRef(onClose);
  close.current = onClose;

  // Repeating a message bumps `seq` instead of stacking a duplicate, which
  // starts this toast's life — and the rail's countdown — over.
  useEffect(() => {
    setLeaving(false);
    const t = setTimeout(() => setLeaving(true), TOAST_LIFE_MS);
    return () => clearTimeout(t);
  }, [toast.seq]);

  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(() => close.current(), TOAST_EXIT_MS);
    return () => clearTimeout(t);
  }, [leaving]);

  return (
    <div
      className={"toast toast-" + toast.kind + (leaving ? " leaving" : "")}
      role={toast.kind === "error" ? "alert" : "status"}
    >
      <span className="toast-rail" key={toast.seq} aria-hidden />
      <span className="toast-icon" aria-hidden>
        {toast.kind === "error" ? (
          <IconWarning width={15} height={15} />
        ) : (
          <IconCheck width={15} height={15} />
        )}
      </span>
      <span className="toast-msg">{toast.message}</span>
      <button className="toast-x" onClick={() => setLeaving(true)} aria-label="Dismiss">
        ✕
      </button>
    </div>
  );
}
