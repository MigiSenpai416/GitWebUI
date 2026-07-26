import type { Express } from "express";

/**
 * Start listening, and fail loudly if the socket can't be had.
 *
 * `app.listen(...)` reports a bind failure by emitting `error` on the server it
 * already returned, not by throwing. With no handler attached, Node turns that
 * into an uncaught exception — which `installProcessGuards()` catches and logs,
 * leaving a process that is alive, has printed a message nobody is watching for,
 * and is serving nothing. A port already in use is the ordinary way to hit this,
 * and it should end the process rather than fake a running server.
 */
export function listenOrExit(app: Express, port: number, host: string): void {
  const server = app.listen(port, host, () => {
    const shown = host === "0.0.0.0" || host === "::" ? "localhost" : host;
    console.log(`[gitwebui] server listening on http://${shown}:${port}`);
  });

  server.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE") {
      console.error(
        `[gitwebui] port ${port} is already in use. Pass --port to choose another one.`,
      );
    } else if (e.code === "EACCES") {
      console.error(
        `[gitwebui] not allowed to bind ${host}:${port}. Ports below 1024 usually need ` +
          `elevated privileges — pass --port to choose a higher one.`,
      );
    } else if (e.code === "EADDRNOTAVAIL") {
      console.error(`[gitwebui] no interface on this machine has the address ${host}.`);
    } else {
      console.error(`[gitwebui] could not start the server: ${e.message}`);
    }
    process.exit(1);
  });
}
