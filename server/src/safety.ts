import { settleTokenWork } from "./github.js";

/**
 * Last-resort process guards. A local dev tool should never be taken down for
 * good by a single unexpected error — log it and keep serving so the user's
 * open repos stay reachable without a manual restart. Route handlers still
 * translate their own errors into clean HTTP responses; this only catches
 * anything that slips past them.
 */
export function installProcessGuards(): void {
  process.on("unhandledRejection", (reason) => {
    console.error("[gitwebui] unhandled promise rejection (ignored):", reason);
  });
  process.on("uncaughtException", (err) => {
    console.error("[gitwebui] uncaught exception (ignored):", err);
  });
}

const SHUTDOWN_HOLD_MS = 3_000;

/**
 * Hold a signal-driven exit for a GitHub token refresh in flight. GitHub
 * retires the old refresh token the moment it answers, so exiting before the
 * rotated pair is written leaves credentials GitHub will never accept again.
 * A second signal exits at once.
 */
export function installShutdownHold(): void {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
    process.once(signal, () => {
      void Promise.race([
        settleTokenWork(),
        new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_HOLD_MS)),
      ]).finally(() => process.exit(0));
    });
  }
}
