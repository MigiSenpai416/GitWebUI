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
