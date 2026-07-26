import {
  randomBytes,
  scrypt,
  timingSafeEqual,
  createHmac,
} from "node:crypto";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import { Router, type Request, type Response, type NextFunction } from "express";
import { configPath, ensureConfigDir } from "./config.js";

/**
 * WebUI access control. A single shared password gates the whole app; a
 * stateless HMAC-signed token (delivered as an HttpOnly cookie) proves an
 * authenticated session. The signing secret and password hash live in the
 * per-OS config dir, so remembered logins survive a server restart.
 *
 * Tokens carry an id so signing out can retire the one being used: the id goes
 * on a revocation list that outlives a restart, which is the only way to take
 * back a token that is otherwise valid until it expires.
 */

const authFile = () => configPath("auth.json");
const revokedFile = () => configPath("revoked-sessions.json");
const COOKIE_NAME = "gwui_session";
const DESKTOP_COOKIE_NAME = "gwui_desktop";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
const MIN_PASSWORD_LEN = 6;

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

interface AuthConfig {
  passwordHash: string; // hex
  salt: string; // hex
  secret: string; // hex, HMAC key for session tokens
}

// Cached after first read so we don't hit disk on every request.
let cache: AuthConfig | null = null;
let loaded = false;
/**
 * Set when `auth.json` is there but unusable — corrupt, truncated by a crash
 * mid-write, or briefly unreadable. That is not the same as having no password,
 * and the difference decides whether `POST /api/auth/setup` is open: caching an
 * unreadable file as "no password configured" would hand a configured install
 * to whoever asked to set one next.
 */
let unreadable = false;
let warnedUnreadable = false;

function isMissingFile(e: unknown): boolean {
  return (e as NodeJS.ErrnoException)?.code === "ENOENT";
}

async function read(): Promise<AuthConfig | null> {
  if (loaded) return cache;
  try {
    const raw = await fs.readFile(authFile(), "utf8");
    const parsed = JSON.parse(raw) as Partial<AuthConfig>;
    if (parsed.passwordHash && parsed.salt && parsed.secret) {
      cache = { passwordHash: parsed.passwordHash, salt: parsed.salt, secret: parsed.secret };
      unreadable = false;
      loaded = true;
      return cache;
    }
    // Present but incomplete — treat as unusable rather than absent.
    markUnreadable("the password file is incomplete");
  } catch (e) {
    if (isMissingFile(e)) {
      // No file at all: genuinely unconfigured, and worth caching — this is the
      // ordinary first-run path, hit on every request until a password is set.
      cache = null;
      unreadable = false;
      loaded = true;
      return cache;
    }
    markUnreadable((e as Error).message);
  }
  // Deliberately not cached: the next request re-reads, so a transient failure
  // recovers on its own and a repaired file is picked up without a restart.
  cache = null;
  return null;
}

function markUnreadable(why: string): void {
  unreadable = true;
  if (warnedUnreadable) return;
  warnedUnreadable = true;
  console.error(
    `[gitwebui] cannot read the stored password (${why}). Sign-in is disabled until ` +
      `${authFile()} is repaired or removed; removing it lets a new password be set.`,
  );
}

async function write(cfg: AuthConfig): Promise<void> {
  await ensureConfigDir();
  await fs.writeFile(authFile(), JSON.stringify(cfg, null, 2), "utf8");
  cache = cfg;
  unreadable = false;
  loaded = true;
}

/**
 * Hashing is deliberately expensive, so it runs on the crypto threadpool rather
 * than inline: `scryptSync` would hold Node's only thread for the ~60ms it takes,
 * and an unauthenticated caller repeating that is enough to stall every other
 * request in the app.
 */
async function hashPassword(password: string, saltHex: string): Promise<string> {
  const key = await scryptAsync(password, Buffer.from(saltHex, "hex"), 64);
  return key.toString("hex");
}

/** Constant-time compare of two hex strings of equal length. */
function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Whether this install has a password. A file that exists but cannot be read
 * counts as configured: the safe answer to "is there a password?" when we can't
 * tell is yes, since the alternative re-opens setup on a machine that has one.
 */
export async function isConfigured(): Promise<boolean> {
  return (await read()) !== null || unreadable;
}

/** Set the initial password. Rejects if one is already configured. */
export async function setupPassword(password: string): Promise<void> {
  if (password.length < MIN_PASSWORD_LEN) {
    throw badRequest(`Password must be at least ${MIN_PASSWORD_LEN} characters`);
  }
  await read();
  if (unreadable) {
    throw conflict(
      "This machine has a password, but the stored copy can't be read. Repair or remove the " +
        "password file to set a new one.",
    );
  }
  if (await isConfigured()) {
    throw conflict("A password is already configured");
  }
  const salt = randomBytes(16).toString("hex");
  const secret = randomBytes(32).toString("hex");
  await write({ passwordHash: await hashPassword(password, salt), salt, secret });
}

export async function verifyPassword(password: string): Promise<boolean> {
  const cfg = await read();
  if (!cfg) return false;
  return safeEqualHex(await hashPassword(password, cfg.salt), cfg.passwordHash);
}

/**
 * Ids of tokens that have been signed out, each held until the moment the token
 * would have expired anyway — after that the signature check rejects it on its
 * own and the entry is dead weight. Persisted, because the signing secret
 * survives a restart and so would an un-revoked token.
 */
let revokedLoad: Promise<Map<string, number>> | null = null;
/** Serialises writes so two sign-outs at once can't overwrite one another. */
let revokedWrites: Promise<unknown> = Promise.resolve();

/**
 * The one and only revocation map. What is memoised is the *promise*, not its
 * result: callers that arrive while the first read is still in flight have to
 * await that same read and receive that same Map. Memoising the result instead
 * lets each of them build a Map of its own, and the last one to finish quietly
 * replaces everyone else's — which is a sign-out that reports success and
 * doesn't happen.
 */
function loadRevoked(): Promise<Map<string, number>> {
  if (!revokedLoad) {
    revokedLoad = (async () => {
      const map = new Map<string, number>();
      try {
        const raw = JSON.parse(await fs.readFile(revokedFile(), "utf8")) as Record<string, number>;
        const now = Date.now();
        for (const [jti, exp] of Object.entries(raw)) {
          if (typeof exp === "number" && exp > now) map.set(jti, exp);
        }
      } catch {
        /* no list yet, or unreadable — start empty */
      }
      return map;
    })();
  }
  return revokedLoad;
}

/**
 * Write the whole list. Failures don't poison the queue: the next sign-out
 * chains onto a settled promise and tries again, and because every write is a
 * snapshot of the entire map, one success re-persists everything a failed write
 * lost. The caller still hears about the failure.
 */
async function persistRevoked(map: Map<string, number>): Promise<void> {
  const snapshot = Object.fromEntries(map);
  const write = revokedWrites.then(async () => {
    await ensureConfigDir();
    await fs.writeFile(revokedFile(), JSON.stringify(snapshot, null, 2), "utf8");
  });
  revokedWrites = write.catch(() => undefined);
  await write;
}

/** Retire a token id until `exp`, dropping any entries that have aged out. */
async function revoke(jti: string, exp: number): Promise<void> {
  const map = await loadRevoked();
  map.set(jti, exp);
  const now = Date.now();
  for (const [id, at] of map) {
    if (at <= now) map.delete(id);
  }
  // The token is dead in this process from here on, whether or not the list
  // reaches disk; persistence is what carries that across a restart.
  await persistRevoked(map);
}

async function isRevoked(jti: string): Promise<boolean> {
  return (await loadRevoked()).has(jti);
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Mint a signed session token. `remember` extends its lifetime to 7 days. */
export async function issueToken(remember: boolean): Promise<string> {
  const cfg = await read();
  if (!cfg) throw conflict("No password configured");
  const exp = Date.now() + (remember ? SEVEN_DAYS_MS : TWELVE_HOURS_MS);
  const jti = randomBytes(12).toString("base64url");
  const payload = base64url(JSON.stringify({ jti, exp }));
  return `${payload}.${sign(payload, cfg.secret)}`;
}

/** A token's claims, or null if it isn't signed by this install. */
async function openToken(token: string | undefined): Promise<{ jti: string; exp: number } | null> {
  if (!token) return null;
  const cfg = await read();
  if (!cfg) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = sign(payload, cfg.secret);
  // Signature first (constant time); nothing inside is trusted until it passes.
  const macBuf = Buffer.from(mac);
  const expBuf = Buffer.from(expected);
  if (macBuf.length !== expBuf.length || !timingSafeEqual(macBuf, expBuf)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      jti?: unknown;
      exp?: unknown;
    };
    // A token with no id predates revocation and could never be signed out;
    // rejecting it costs one re-login and leaves nothing unrevokable behind.
    if (typeof claims.jti !== "string" || !claims.jti) return null;
    if (typeof claims.exp !== "number") return null;
    return { jti: claims.jti, exp: claims.exp };
  } catch {
    return null;
  }
}

/** Validate a session token's signature, expiry, and that it wasn't signed out. */
export async function verifyToken(token: string | undefined): Promise<boolean> {
  const claims = await openToken(token);
  if (!claims || claims.exp <= Date.now()) return false;
  return !(await isRevoked(claims.jti));
}

/**
 * Retire the token this request is carrying. Unknown or already-expired tokens
 * are a no-op — signing out always reports success, so a stale cookie can't be
 * used to probe which tokens exist.
 */
export async function revokeToken(token: string | undefined): Promise<void> {
  const claims = await openToken(token);
  if (!claims || claims.exp <= Date.now()) return;
  await revoke(claims.jti, claims.exp);
}

/** Parse a single cookie value out of the request's Cookie header. */
function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

function setSessionCookie(res: Response, token: string, remember: boolean): void {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
  ];
  // Persistent for "remember me"; otherwise a session cookie (cleared on close).
  if (remember) parts.push(`Max-Age=${Math.floor(SEVEN_DAYS_MS / 1000)}`);
  res.append("Set-Cookie", parts.join("; "));
}

function clearSessionCookie(res: Response): void {
  res.append("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

/**
 * Desktop mode. The Electron main process mints a random token, plants it as a
 * cookie in its own window's session, and hands the same value here — so the
 * one client that was handed it is let in and nothing else is, without the
 * user ever meeting a password screen for an app running on their own machine.
 *
 * It replaces the password gate rather than sitting alongside it. The desktop
 * server listens on loopback, and a loopback port is reachable by every other
 * process on the machine: if signing in still worked, a local browser could
 * find the port, see an install with no password set, and set one — claiming
 * an app that isn't theirs. So while a desktop token is set, `setup` and
 * `login` are closed and this cookie is the only way in.
 */
let desktopToken: string | null = null;

/** Switch to (or, with `null`, out of) desktop mode. */
export function setDesktopToken(token: string | null): void {
  desktopToken = token === null || token === "" ? null : token;
}

export function isDesktopMode(): boolean {
  return desktopToken !== null;
}

/** Constant-time compare of two arbitrary strings. */
function safeEqualString(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function hasDesktopCookie(req: Request): boolean {
  if (desktopToken === null) return false;
  const presented = readCookie(req, DESKTOP_COOKIE_NAME);
  return presented !== undefined && safeEqualString(presented, desktopToken);
}

async function isAuthenticated(req: Request): Promise<boolean> {
  if (desktopToken !== null) return hasDesktopCookie(req);
  return verifyToken(readCookie(req, COOKIE_NAME));
}

/** The 403 both password routes return while the app owns this server. */
function desktopModeRefusal(): Error & { status: number } {
  return Object.assign(
    new Error("This server belongs to the GitWebUI desktop app and has no password to set."),
    { status: 403 },
  );
}

function badRequest(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 400 });
}
function conflict(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 409 });
}

/**
 * Failed-login throttle. A single shared password with no lockout is guessable
 * for as long as an attacker cares to keep trying, and every guess costs a
 * hash — so wrong answers are counted per client and the door shuts for a while
 * once there have been too many. A correct password clears the count, so
 * someone mistyping their own password is never locked out for long.
 *
 * Keyed by peer address. Express's `trust proxy` is off, so this is the socket's
 * address and not a header a caller can choose.
 */
const MAX_FAILURES = 8;
const FAILURE_WINDOW_MS = 5 * 60 * 1000;
const attempts = new Map<string, { count: number; until: number }>();

function clientKey(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

/**
 * Claim one attempt, or report how long the caller must wait. Counting on the
 * way in rather than after the answer is known is what makes a burst count:
 * attempts sent all at once would otherwise all pass the check before the first
 * of them had finished hashing. It also caps how many hashes can be in flight.
 */
function beginAttempt(key: string): number {
  const now = Date.now();
  // Sweep stale entries so a long run of one-off attempts can't grow the map.
  for (const [k, v] of attempts) {
    if (v.until <= now) attempts.delete(k);
  }
  const entry = attempts.get(key);
  if (!entry) {
    attempts.set(key, { count: 1, until: now + FAILURE_WINDOW_MS });
    return 0;
  }
  if (entry.count >= MAX_FAILURES) {
    // Still knocking while blocked pushes the window out, so hammering doesn't pay.
    entry.until = now + FAILURE_WINDOW_MS;
    return entry.until - now;
  }
  entry.count++;
  return 0;
}

function clearFailures(key: string): void {
  attempts.delete(key);
}

/** Test hook: forget every recorded attempt. */
export function _resetLoginThrottle(): void {
  attempts.clear();
}

/** Blocks protected routes unless a valid session cookie is present. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  isAuthenticated(req)
    .then((ok) => {
      if (ok) next();
      else res.status(401).json({ error: "Authentication required" });
    })
    .catch(next);
}

// Public auth endpoints (mounted before requireAuth).
export const authRouter = Router();

authRouter.get("/status", (req, res, next) => {
  // In desktop mode there is no password to configure, so the window is told
  // the gate is settled — which is what makes the login screen never render.
  if (desktopToken !== null) {
    res.json({ configured: true, authenticated: hasDesktopCookie(req) });
    return;
  }
  Promise.all([isConfigured(), isAuthenticated(req)])
    .then(([configured, authenticated]) => res.json({ configured, authenticated }))
    .catch(next);
});

authRouter.post("/setup", (req, res, next) => {
  if (desktopToken !== null) {
    next(desktopModeRefusal());
    return;
  }
  const password = String(req.body?.password ?? "");
  const remember = Boolean(req.body?.remember);
  setupPassword(password)
    .then(() => issueToken(remember))
    .then((token) => {
      setSessionCookie(res, token, remember);
      res.json({ ok: true });
    })
    .catch(next);
});

authRouter.post("/login", (req, res, next) => {
  if (desktopToken !== null) {
    next(desktopModeRefusal());
    return;
  }
  const who = clientKey(req);
  const wait = beginAttempt(who);
  if (wait > 0) {
    res.setHeader("Retry-After", String(Math.ceil(wait / 1000)));
    res.status(429).json({ error: `Too many attempts — try again in ${Math.ceil(wait / 1000)}s.` });
    return;
  }
  const password = String(req.body?.password ?? "");
  const remember = Boolean(req.body?.remember);
  verifyPassword(password)
    .then(async (ok) => {
      if (!ok) {
        res.status(401).json({ error: "Incorrect password" });
        return;
      }
      clearFailures(who);
      const token = await issueToken(remember);
      setSessionCookie(res, token, remember);
      res.json({ ok: true });
    })
    .catch(next);
});

authRouter.post("/logout", (req, res, next) => {
  // Nothing to sign out of in desktop mode — the window's token is the app's,
  // not a session the user established. Reported as success so the caller has
  // no branch to take; the UI hides the control anyway.
  if (desktopToken !== null) {
    res.json({ ok: true });
    return;
  }
  // Retire the token as well as clearing the cookie: the cookie is only the
  // browser's copy, and a token that has been read off the wire or off a shared
  // machine would otherwise stay good until it expired.
  revokeToken(readCookie(req, COOKIE_NAME))
    .then(() => {
      clearSessionCookie(res);
      res.json({ ok: true });
    })
    .catch(next);
});

/** Test hook: drop the in-memory caches so a fresh config dir is re-read. */
export function _resetAuthCache(): void {
  cache = null;
  loaded = false;
  unreadable = false;
  warnedUnreadable = false;
  revokedLoad = null;
  revokedWrites = Promise.resolve();
}
