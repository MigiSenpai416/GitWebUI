/**
 * Startup configuration resolved from CLI flags, environment, then defaults
 * (in that precedence). Shared by the Node entry (`index.ts`) and the Bun
 * binary entry (`bunEntry.ts`).
 */

const DEFAULT_PORT = 5174;
const DEFAULT_HOST = "0.0.0.0";

export const HELP_TEXT = `GitWebUI - a local, GitKraken-style web git client

Usage: gitwebui [options]

Options:
  -p, --port <number>   Port to listen on (default ${DEFAULT_PORT}, env PORT)
      --host <address>  Address to bind (default ${DEFAULT_HOST}, env HOST)
  -h, --help            Show this help and exit

The server hosts both the web UI and its API on a single port. Open the
printed URL in a browser; on first visit you'll be asked to set a password.
`;

/** Returns the flag's value, supporting both "--flag value" and "--flag=value". */
function flagValue(argv: string[], names: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    for (const name of names) {
      if (arg === name) return argv[i + 1];
      if (arg.startsWith(name + "=")) return arg.slice(name.length + 1);
    }
  }
  return undefined;
}

export function wantsHelp(argv: string[] = process.argv.slice(2)): boolean {
  return argv.includes("-h") || argv.includes("--help");
}

export function resolvePort(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = flagValue(argv, ["--port", "-p"]) ?? env.PORT;
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw Object.assign(new Error(`Invalid port: ${raw} (expected an integer 1-65535)`), {
      status: 400,
    });
  }
  return n;
}

export function resolveHost(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): string {
  return flagValue(argv, ["--host"]) ?? env.HOST ?? DEFAULT_HOST;
}
