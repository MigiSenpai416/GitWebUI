import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHmac,
} from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Router, type Request, type Response, type NextFunction } from "express";
import { CONFIG_DIR } from "./config.js";

/**
 * WebUI access control. A single shared password gates the whole app; a
 * stateless HMAC-signed token (delivered as an HttpOnly cookie) proves an
 * authenticated session. The signing secret and password hash live in the
 * per-OS config dir, so remembered logins survive a server restart.
 */

const AUTH_FILE = path.join(CONFIG_DIR, "auth.json");
const COOKIE_NAME = "gwui_session";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
const MIN_PASSWORD_LEN = 6;

interface AuthConfig {
  passwordHash: string; // hex
  salt: string; // hex
  secret: string; // hex, HMAC key for session tokens
}

// Cached after first read so we don't hit disk on every request.
let cache: AuthConfig | null = null;
let loaded = false;

async function read(): Promise<AuthConfig | null> {
  if (loaded) return cache;
  try {
    const raw = await fs.readFile(AUTH_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<AuthConfig>;
    if (parsed.passwordHash && parsed.salt && parsed.secret) {
      cache = { passwordHash: parsed.passwordHash, salt: parsed.salt, secret: parsed.secret };
    } else {
      cache = null;
    }
  } catch {
    cache = null;
  }
  loaded = true;
  return cache;
}

async function write(cfg: AuthConfig): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(AUTH_FILE, JSON.stringify(cfg, null, 2), "utf8");
  cache = cfg;
  loaded = true;
}

function hashPassword(password: string, saltHex: string): string {
  return scryptSync(password, Buffer.from(saltHex, "hex"), 64).toString("hex");
}

/** Constant-time compare of two hex strings of equal length. */
function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export async function isConfigured(): Promise<boolean> {
  return (await read()) !== null;
}

/** Set the initial password. Rejects if one is already configured. */
export async function setupPassword(password: string): Promise<void> {
  if (password.length < MIN_PASSWORD_LEN) {
    throw badRequest(`Password must be at least ${MIN_PASSWORD_LEN} characters`);
  }
  if (await isConfigured()) {
    throw conflict("A password is already configured");
  }
  const salt = randomBytes(16).toString("hex");
  const secret = randomBytes(32).toString("hex");
  await write({ passwordHash: hashPassword(password, salt), salt, secret });
}

export async function verifyPassword(password: string): Promise<boolean> {
  const cfg = await read();
  if (!cfg) return false;
  return safeEqualHex(hashPassword(password, cfg.salt), cfg.passwordHash);
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
  const payload = base64url(JSON.stringify({ exp }));
  return `${payload}.${sign(payload, cfg.secret)}`;
}

/** Validate a session token's signature and expiry. */
export async function verifyToken(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const cfg = await read();
  if (!cfg) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = sign(payload, cfg.secret);
  // Signature check first (constant time), then expiry.
  const macBuf = Buffer.from(mac);
  const expBuf = Buffer.from(expected);
  if (macBuf.length !== expBuf.length || !timingSafeEqual(macBuf, expBuf)) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: number };
    return typeof exp === "number" && exp > Date.now();
  } catch {
    return false;
  }
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

async function isAuthenticated(req: Request): Promise<boolean> {
  return verifyToken(readCookie(req, COOKIE_NAME));
}

function badRequest(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 400 });
}
function conflict(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 409 });
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
  Promise.all([isConfigured(), isAuthenticated(req)])
    .then(([configured, authenticated]) => res.json({ configured, authenticated }))
    .catch(next);
});

authRouter.post("/setup", (req, res, next) => {
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
  const password = String(req.body?.password ?? "");
  const remember = Boolean(req.body?.remember);
  verifyPassword(password)
    .then(async (ok) => {
      if (!ok) {
        res.status(401).json({ error: "Incorrect password" });
        return;
      }
      const token = await issueToken(remember);
      setSessionCookie(res, token, remember);
      res.json({ ok: true });
    })
    .catch(next);
});

authRouter.post("/logout", (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

/** Test hook: drop the in-memory cache so a fresh config file is re-read. */
export function _resetAuthCache(): void {
  cache = null;
  loaded = false;
}
