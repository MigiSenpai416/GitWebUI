import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { configPath, ensureConfigDir } from "./config.js";
import type { CommitIdentity } from "./identity.js";

/**
 * GitHub credential storage + minimal GitHub REST calls.
 *
 * The token is stored in plaintext in the app config dir (like git's own
 * `store` credential helper) because git needs the live value to authenticate
 * pushes/pulls. Treat the config dir as sensitive.
 */

const tokenFile = () => configPath("github.json");
const refreshRecoveryFile = () => configPath("github-refresh.json");
const API = "https://api.github.com";
const GITHUB = "https://github.com";
const GITHUB_OAUTH_CLIENT_ID = "Ov23liu2LXjA3dklsGu1";
const OAUTH_FINISH_TTL_MS = 30 * 60_000;
const GITHUB_REQUEST_TIMEOUT_MS = 15_000;
const TOKEN_TEMP_MAX_AGE_MS = 10 * 60_000;

export interface GitHubUser {
  login: string;
  name: string | null;
  avatarUrl: string | null;
  id: number;
  email: string | null;
}

export type GitHubAuthMethod = "pat" | "oauth";

interface TokenConfig {
  token: string;
  authMethod: GitHubAuthMethod;
  refreshToken?: string;
  expiresAt?: number;
  refreshTokenExpiresAt?: number;
}

interface PendingOAuthRefresh {
  config: TokenConfig;
  previousToken: string;
  tokenRevision: number;
}

interface RefreshRecovery {
  config: TokenConfig;
  previousToken: string;
}

let cache: TokenConfig | null = null;
let loaded = false;
let tokenRevision = 0;
let refreshPromise: Promise<TokenConfig | null> | null = null;
let pendingOAuthRefresh: PendingOAuthRefresh | null = null;
let tokenWriteQueue: Promise<void> = Promise.resolve();

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function cleanupTokenTemps(removeActive = false): Promise<void> {
  const target = tokenFile();
  const dir = path.dirname(target);
  const prefix = `${path.basename(target)}.`;
  try {
    for (const name of await fs.readdir(dir)) {
      if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
      const pid = Number(name.slice(prefix.length).split(".", 1)[0]);
      const candidate = path.join(dir, name);
      const age = Date.now() - (await fs.stat(candidate)).mtimeMs;
      if (
        removeActive ||
        age >= TOKEN_TEMP_MAX_AGE_MS ||
        !Number.isSafeInteger(pid) ||
        !processIsRunning(pid)
      ) {
        await fs.rm(candidate, { force: true });
      }
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

async function writeConfigFile(target: string, value: unknown): Promise<void> {
  await ensureConfigDir();
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    if (process.platform !== "win32") await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, target);
  } catch (e) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw e;
  }
}

async function persistTokenConfig(config: TokenConfig): Promise<void> {
  await cleanupTokenTemps();
  await writeConfigFile(tokenFile(), config);
}

function parseTokenConfig(raw: string): TokenConfig | null {
  const parsed = JSON.parse(raw) as Partial<TokenConfig>;
  return parsed.token
    ? {
        token: parsed.token,
        authMethod: parsed.authMethod === "oauth" ? "oauth" : "pat",
        ...(typeof parsed.refreshToken === "string" ? { refreshToken: parsed.refreshToken } : {}),
        ...(typeof parsed.expiresAt === "number" ? { expiresAt: parsed.expiresAt } : {}),
        ...(typeof parsed.refreshTokenExpiresAt === "number"
          ? { refreshTokenExpiresAt: parsed.refreshTokenExpiresAt }
          : {}),
      }
    : null;
}

async function clearRefreshRecovery(): Promise<void> {
  const target = refreshRecoveryFile();
  const dir = path.dirname(target);
  const prefix = `${path.basename(target)}.`;
  await fs.rm(target, { force: true });
  try {
    for (const name of await fs.readdir(dir)) {
      if (name.startsWith(prefix) && name.endsWith(".tmp")) {
        await fs.rm(path.join(dir, name), { force: true });
      }
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

async function readRefreshRecovery(): Promise<RefreshRecovery | null> {
  const target = refreshRecoveryFile();
  const dir = path.dirname(target);
  const prefix = `${path.basename(target)}.`;
  const candidates = [target];
  try {
    for (const name of await fs.readdir(dir)) {
      if (name.startsWith(prefix) && name.endsWith(".tmp")) candidates.push(path.join(dir, name));
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  const recovered: Array<{ recovery: RefreshRecovery; mtimeMs: number }> = [];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(await fs.readFile(candidate, "utf8")) as Partial<RefreshRecovery>;
      const config = parsed.config ? parseTokenConfig(JSON.stringify(parsed.config)) : null;
      if (config && typeof parsed.previousToken === "string") {
        recovered.push({
          recovery: { config, previousToken: parsed.previousToken },
          mtimeMs: (await fs.stat(candidate)).mtimeMs,
        });
      } else {
        throw new Error("Invalid refresh recovery record");
      }
    } catch {
      const name = path.basename(candidate);
      const pid = Number(name.slice(prefix.length).split(".", 1)[0]);
      const age = await fs.stat(candidate).then((stat) => Date.now() - stat.mtimeMs, () => Infinity);
      if (
        candidate === target ||
        age >= TOKEN_TEMP_MAX_AGE_MS ||
        !Number.isSafeInteger(pid) ||
        !processIsRunning(pid)
      ) {
        await fs.rm(candidate, { force: true });
      }
    }
  }
  recovered.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return recovered[0]?.recovery ?? null;
}

async function read(): Promise<TokenConfig | null> {
  if (loaded) return cache;
  try {
    await cleanupTokenTemps();
    const main = await fs.readFile(tokenFile(), "utf8").then(parseTokenConfig, () => null);
    const recovered = await readRefreshRecovery();
    if (recovered) {
      if (main && (
        main.token === recovered.previousToken ||
        main.token === recovered.config.token
      )) {
        try {
          await persistTokenConfig(recovered.config);
          await clearRefreshRecovery();
        } catch {
          // The complete recovery record remains authoritative until promotion succeeds.
        }
        cache = recovered.config;
        loaded = true;
        return cache;
      }
      await clearRefreshRecovery().catch(() => undefined);
    }
    cache = main;
  } catch {
    cache = null;
  }
  loaded = true;
  return cache;
}

export async function getToken(): Promise<string | null> {
  let config = await read();
  if (!config) return null;
  if (pendingOAuthRefresh?.tokenRevision === tokenRevision) {
    try {
      config = (await refreshOAuthToken(config)) ?? config;
    } catch {
      config = pendingOAuthRefresh?.config ?? config;
      if (config.expiresAt !== undefined && config.expiresAt <= Date.now()) return null;
      return config.token;
    }
  }
  if (
    config.authMethod === "oauth" &&
    config.expiresAt !== undefined &&
    config.expiresAt <= Date.now() + 60_000
  ) {
    if (config.refreshToken) {
      try {
        const refreshed = await refreshOAuthToken(config);
        return refreshed?.token ?? null;
      } catch {
        // A token still inside its lifetime can make one final API attempt.
        const pending = pendingOAuthRefresh;
        if (pending?.tokenRevision === tokenRevision) {
          if (pending.config.expiresAt !== undefined && pending.config.expiresAt <= Date.now()) {
            return null;
          }
          return pending.config.token;
        }
      }
    }
    if (config.expiresAt <= Date.now()) return null;
  }
  return config.token;
}

export async function hasToken(): Promise<boolean> {
  return (await getToken()) !== null;
}

async function writeTokenConfig(config: TokenConfig): Promise<void> {
  const write = tokenWriteQueue.then(async () => {
    await persistTokenConfig(config);
    await clearRefreshRecovery().catch(() => undefined);
    tokenRevision++;
    pendingOAuthRefresh = null;
    cache = config;
    loaded = true;
  });
  tokenWriteQueue = write.catch(() => undefined);
  await write;
}

/** Persist a PAT or an OAuth access token. */
export async function setToken(
  token: string,
  options: {
    authMethod?: GitHubAuthMethod;
    refreshToken?: string;
    expiresIn?: number;
    refreshTokenExpiresIn?: number;
  } = {},
): Promise<void> {
  const now = Date.now();
  await writeTokenConfig({
    token,
    authMethod: options.authMethod ?? "pat",
    ...(options.refreshToken ? { refreshToken: options.refreshToken } : {}),
    ...(options.expiresIn ? { expiresAt: now + options.expiresIn * 1000 } : {}),
    ...(options.refreshTokenExpiresIn
      ? { refreshTokenExpiresAt: now + options.refreshTokenExpiresIn * 1000 }
      : {}),
  });
}

/** Remove the stored token (revoke locally). */
export async function deleteToken(): Promise<void> {
  const remove = tokenWriteQueue.then(async () => {
    await clearRefreshRecovery();
    await fs.rm(tokenFile(), { force: true });
    await cleanupTokenTemps(true);
    tokenRevision++;
    pendingOAuthRefresh = null;
    cache = null;
    loaded = true;
  });
  tokenWriteQueue = remove.catch(() => undefined);
  await remove;
}

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "GitWebUI",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function ghError(status: number, body: string): Error & { status: number } {
  let message = `GitHub API error (${status})`;
  try {
    const j = JSON.parse(body);
    if (j?.message) message = j.message;
    // Validation failures say only "Validation Failed" at the top level — the
    // actionable text ("No commits between …", "A pull request already exists …")
    // lives in errors[].message.
    const detail = Array.isArray(j?.errors)
      ? j.errors
          .map((e: { message?: string }) => (typeof e === "string" ? e : e?.message))
          .filter(Boolean)
          .join("; ")
      : "";
    if (detail) message = detail;
  } catch {
    /* non-JSON */
  }
  // Map auth failures to 401 so the UI can prompt to reconnect.
  const outStatus = status === 401 || status === 403 ? 401 : 422;
  return Object.assign(new Error(message), { status: outStatus });
}

function oauthError(value: unknown, fallback: string): Error & { status: number } {
  const response = value as { error?: string; error_description?: string };
  const known: Record<string, string> = {
    access_denied: "GitHub authorization was cancelled.",
    device_flow_disabled: "Device Flow is not enabled for this GitHub OAuth app.",
    expired_token: "The GitHub sign-in code expired. Start again to get a new code.",
    incorrect_client_credentials: "The configured GitHub OAuth Client ID is invalid.",
    incorrect_device_code: "GitHub rejected the sign-in code. Start the sign-in again.",
    unsupported_grant_type: "GitHub rejected the OAuth grant type.",
  };
  const message =
    (response.error && known[response.error]) ||
    response.error_description ||
    fallback;
  return Object.assign(new Error(message), { status: 502 });
}

async function refreshOAuthToken(config: TokenConfig): Promise<TokenConfig | null> {
  if (refreshPromise) return refreshPromise;
  const persist = async (pending: PendingOAuthRefresh): Promise<TokenConfig | null> => {
    const commit = tokenWriteQueue.then(async () => {
      if (pendingOAuthRefresh !== pending || pending.tokenRevision !== tokenRevision) {
        if (pendingOAuthRefresh === pending) pendingOAuthRefresh = null;
        return read();
      }
      try {
        await writeConfigFile(refreshRecoveryFile(), {
          config: pending.config,
          previousToken: pending.previousToken,
        } satisfies RefreshRecovery);
        await persistTokenConfig(pending.config);
        await clearRefreshRecovery();
      } catch (e) {
        if (pending.tokenRevision === tokenRevision) {
          cache = pending.config;
          loaded = true;
        }
        throw e;
      }
      if (pendingOAuthRefresh === pending) pendingOAuthRefresh = null;
      cache = pending.config;
      loaded = true;
      return pending.config;
    });
    tokenWriteQueue = commit.then(() => undefined, () => undefined);
    return commit;
  };

  const refresh = (async () => {
    if (pendingOAuthRefresh?.tokenRevision === tokenRevision) {
      return persist(pendingOAuthRefresh);
    }
    pendingOAuthRefresh = null;

    if (!config.refreshToken) throw new Error("GitHub OAuth cannot refresh this token");
    if (
      config.refreshTokenExpiresAt !== undefined &&
      config.refreshTokenExpiresAt <= Date.now()
    ) {
      throw new Error("The GitHub OAuth refresh token expired");
    }

    const expectedRevision = tokenRevision;
    const body = new URLSearchParams({
      client_id: GITHUB_OAUTH_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: config.refreshToken,
    });
    const res = await fetch(`${GITHUB}/login/oauth/access_token`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
    });
    const response = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      refresh_token_expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !response.access_token) {
      throw oauthError(response, `GitHub OAuth refresh failed (${res.status})`);
    }

    const now = Date.now();
    const pending: PendingOAuthRefresh = {
      tokenRevision: expectedRevision,
      previousToken: config.token,
      config: {
        token: response.access_token,
        authMethod: "oauth",
        refreshToken: response.refresh_token ?? config.refreshToken,
        ...(response.expires_in ? { expiresAt: now + response.expires_in * 1000 } : {}),
        ...(response.refresh_token_expires_in
          ? { refreshTokenExpiresAt: now + response.refresh_token_expires_in * 1000 }
          : config.refreshTokenExpiresAt
            ? { refreshTokenExpiresAt: config.refreshTokenExpiresAt }
            : {}),
      },
    };
    pendingOAuthRefresh = pending;
    return persist(pending);
  })();
  refreshPromise = refresh.finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

export interface GitHubOAuthDeviceFlow {
  flowId: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  expiresAt: number;
  intervalMs: number;
}

export type GitHubOAuthPoll =
  | { status: "pending"; retryAfterMs: number; message?: string }
  | { status: "complete"; user: GitHubUser }
  | { status: "denied" | "expired"; message: string };

interface OAuthFlowState {
  deviceCode: string;
  expiresAt: number;
  intervalMs: number;
  nextPollAt: number;
  polling: boolean;
  cancelled: boolean;
  tokenRevisionAtStart: number;
  exchanged: {
    token: string;
    scope: string;
    refreshToken?: string;
    expiresAt?: number;
    refreshTokenExpiresAt?: number;
    finishExpiresAt: number;
  } | null;
  finishing: boolean;
  commitStarted: boolean;
  commitPromise: Promise<void> | null;
  committedRevision: number | null;
  previousConfig: TokenConfig | null;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
}

const oauthFlows = new Map<string, OAuthFlowState>();

function removeOAuthFlow(flowId: string): void {
  const flow = oauthFlows.get(flowId);
  if (flow?.cleanupTimer) clearTimeout(flow.cleanupTimer);
  oauthFlows.delete(flowId);
}

async function expireOAuthFlow(flowId: string, flow: OAuthFlowState): Promise<void> {
  if (flow.commitStarted) await cancelOAuthDeviceFlow(flowId);
  else removeOAuthFlow(flowId);
}

function scheduleOAuthCleanup(flowId: string, flow: OAuthFlowState, expiresAt: number): void {
  if (flow.cleanupTimer) clearTimeout(flow.cleanupTimer);
  flow.cleanupTimer = setTimeout(() => {
    if (oauthFlows.get(flowId) !== flow) return;
    if (expiresAt > Date.now()) {
      scheduleOAuthCleanup(flowId, flow, expiresAt);
      return;
    }
    void expireOAuthFlow(flowId, flow).catch(() => {
      if (oauthFlows.get(flowId) === flow) {
        scheduleOAuthCleanup(flowId, flow, Date.now() + 1_000);
      }
    });
  }, Math.max(1, expiresAt - Date.now()));
  flow.cleanupTimer.unref?.();
}

async function pruneOAuthFlows(now = Date.now()): Promise<void> {
  for (const [id, flow] of oauthFlows) {
    if ((flow.exchanged?.finishExpiresAt ?? flow.expiresAt) <= now) {
      await expireOAuthFlow(id, flow);
    }
  }
}

/** Begin GitHub's OAuth Device Flow without exposing the device secret to the browser. */
export async function beginOAuthDeviceFlow(): Promise<GitHubOAuthDeviceFlow> {
  const body = new URLSearchParams({ client_id: GITHUB_OAUTH_CLIENT_ID, scope: "repo user:email" });
  const res = await fetch(`${GITHUB}/login/device/code`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
  });
  const response = (await res.json()) as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    expires_in?: number;
    interval?: number;
    error?: string;
    error_description?: string;
  };
  if (
    !res.ok ||
    !response.device_code ||
    !response.user_code ||
    !response.verification_uri ||
    !response.expires_in
  ) {
    throw oauthError(response, `GitHub OAuth could not start (${res.status})`);
  }

  const verification = new URL(response.verification_uri);
  if (verification.protocol !== "https:" || verification.hostname !== "github.com") {
    throw Object.assign(new Error("GitHub returned an invalid verification URL"), { status: 502 });
  }
  let verificationUriComplete: string | null = null;
  if (response.verification_uri_complete) {
    const complete = new URL(response.verification_uri_complete);
    if (complete.protocol === "https:" && complete.hostname === "github.com") {
      verificationUriComplete = complete.toString();
    }
  }

  const now = Date.now();
  const intervalMs = Math.max(1, response.interval ?? 5) * 1000;
  const flowId = randomUUID();
  const expiresAt = now + response.expires_in * 1000;
  await pruneOAuthFlows(now);
  const flow: OAuthFlowState = {
    deviceCode: response.device_code,
    expiresAt,
    intervalMs,
    nextPollAt: now + intervalMs,
    polling: false,
    cancelled: false,
    tokenRevisionAtStart: tokenRevision,
    exchanged: null,
    finishing: false,
    commitStarted: false,
    commitPromise: null,
    committedRevision: null,
    previousConfig: null,
    cleanupTimer: null,
  };
  oauthFlows.set(flowId, flow);
  scheduleOAuthCleanup(flowId, flow, expiresAt);
  return {
    flowId,
    userCode: response.user_code,
    verificationUri: verification.toString(),
    verificationUriComplete,
    expiresAt,
    intervalMs,
  };
}

async function finishOAuthDeviceFlow(
  flowId: string,
  flow: OAuthFlowState,
): Promise<GitHubOAuthPoll> {
  const exchanged = flow.exchanged;
  if (!exchanged) return { status: "pending", retryAfterMs: flow.intervalMs };
  if (flow.finishing) return { status: "pending", retryAfterMs: flow.intervalMs };
  if (exchanged.finishExpiresAt <= Date.now()) {
    removeOAuthFlow(flowId);
    return {
      status: "expired",
      message: "The completed GitHub authorization expired before it could be saved. Start again.",
    };
  }
  flow.finishing = true;
  try {
    const grantedScopes = new Set(
      exchanged.scope.split(/[ ,]+/).map((scope) => scope.trim()).filter(Boolean),
    );
    if (!grantedScopes.has("repo")) {
      removeOAuthFlow(flowId);
      return {
        status: "denied",
        message: "GitHub did not grant repository access. Authorize the repo scope to connect GitWebUI.",
      };
    }
    if (
      flow.cancelled ||
      oauthFlows.get(flowId) !== flow ||
      flow.tokenRevisionAtStart !== tokenRevision
    ) {
      removeOAuthFlow(flowId);
      return { status: "expired", message: "This GitHub sign-in was cancelled." };
    }

    let user: GitHubUser;
    try {
      user = await fetchUser(exchanged.token, AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS));
    } catch (e) {
      return {
        status: "pending",
        retryAfterMs: flow.intervalMs,
        message: `${e instanceof Error ? e.message : "Couldn't validate the GitHub account."} Retrying…`,
      };
    }
    if (exchanged.finishExpiresAt <= Date.now()) {
      removeOAuthFlow(flowId);
      return {
        status: "expired",
        message: "The completed GitHub authorization expired before it could be saved. Start again.",
      };
    }
    if (
      flow.cancelled ||
      oauthFlows.get(flowId) !== flow ||
      flow.tokenRevisionAtStart !== tokenRevision
    ) {
      removeOAuthFlow(flowId);
      return { status: "expired", message: "This GitHub sign-in was cancelled." };
    }

    try {
      const stored = await storeOAuthToken(flowId, flow, exchanged);
      if (!stored) {
        removeOAuthFlow(flowId);
        return {
          status: "expired",
          message: exchanged.finishExpiresAt <= Date.now()
            ? "The completed GitHub authorization expired before it could be saved. Start again."
            : flow.cancelled
              ? "This GitHub sign-in was cancelled."
              : "The saved GitHub credentials changed while signing in. Start again if needed.",
        };
      }
      if (flow.cancelled) {
        return { status: "expired", message: "This GitHub sign-in was cancelled." };
      }
      if (exchanged.finishExpiresAt <= Date.now()) {
        await cancelOAuthDeviceFlow(flowId);
        return {
          status: "expired",
          message: "The completed GitHub authorization expired before it could be saved. Start again.",
        };
      }
    } catch (e) {
      return {
        status: "pending",
        retryAfterMs: flow.intervalMs,
        message: `${e instanceof Error ? e.message : "Couldn't save the GitHub account."} Retrying…`,
      };
    }
    removeOAuthFlow(flowId);
    return { status: "complete", user };
  } finally {
    flow.finishing = false;
  }
}

async function storeOAuthToken(
  flowId: string,
  flow: OAuthFlowState,
  exchanged: NonNullable<OAuthFlowState["exchanged"]>,
): Promise<boolean> {
  const config: TokenConfig = {
    token: exchanged.token,
    authMethod: "oauth",
    ...(exchanged.refreshToken ? { refreshToken: exchanged.refreshToken } : {}),
    ...(exchanged.expiresAt ? { expiresAt: exchanged.expiresAt } : {}),
    ...(exchanged.refreshTokenExpiresAt
      ? { refreshTokenExpiresAt: exchanged.refreshTokenExpiresAt }
      : {}),
  };
  let stored = false;
  const commit = tokenWriteQueue.then(async () => {
    if (
      flow.cancelled ||
      oauthFlows.get(flowId) !== flow ||
      flow.tokenRevisionAtStart !== tokenRevision ||
      exchanged.finishExpiresAt <= Date.now()
    ) {
      return;
    }
    flow.commitStarted = true;
    flow.previousConfig = await read();
    if (
      flow.cancelled ||
      oauthFlows.get(flowId) !== flow ||
      flow.tokenRevisionAtStart !== tokenRevision ||
      exchanged.finishExpiresAt <= Date.now()
    ) {
      return;
    }
    await persistTokenConfig(config);
    await clearRefreshRecovery().catch(() => undefined);
    tokenRevision++;
    flow.committedRevision = tokenRevision;
    pendingOAuthRefresh = null;
    cache = config;
    loaded = true;
    stored = true;
  });
  flow.commitPromise = commit;
  tokenWriteQueue = commit.catch(() => undefined);
  try {
    await commit;
  } finally {
    if (!stored) {
      flow.commitStarted = false;
      if (flow.cancelled) removeOAuthFlow(flowId);
    }
  }
  return stored;
}

/** Poll one Device Flow at GitHub's required cadence and store the resulting token. */
export async function pollOAuthDeviceFlow(flowId: string): Promise<GitHubOAuthPoll> {
  const flow = oauthFlows.get(flowId);
  if (!flow) {
    return { status: "expired", message: "This GitHub sign-in is no longer active. Start again." };
  }
  const now = Date.now();
  if ((flow.exchanged?.finishExpiresAt ?? flow.expiresAt) <= now) {
    await expireOAuthFlow(flowId, flow);
    return {
      status: "expired",
      message: flow.exchanged
        ? "The completed GitHub authorization expired before it could be saved. Start again."
        : "The GitHub sign-in code expired. Start again.",
    };
  }
  if (flow.cancelled) {
    await cancelOAuthDeviceFlow(flowId);
    return { status: "expired", message: "This GitHub sign-in was cancelled." };
  }
  if (flow.tokenRevisionAtStart !== tokenRevision) {
    removeOAuthFlow(flowId);
    return {
      status: "expired",
      message: "The saved GitHub credentials changed while signing in. Start again if needed.",
    };
  }
  if (flow.exchanged) return finishOAuthDeviceFlow(flowId, flow);
  if (flow.polling || flow.nextPollAt > now) {
    return { status: "pending", retryAfterMs: Math.max(250, flow.nextPollAt - now) };
  }

  flow.polling = true;
  flow.nextPollAt = now + flow.intervalMs;
  try {
    const body = new URLSearchParams({
      client_id: GITHUB_OAUTH_CLIENT_ID,
      device_code: flow.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    const res = await fetch(`${GITHUB}/login/oauth/access_token`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
    });
    const response = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      refresh_token_expires_in?: number;
      scope?: string;
      error?: string;
      error_description?: string;
      interval?: number;
    };
    if (response.access_token) {
      if (
        flow.cancelled ||
        oauthFlows.get(flowId) !== flow ||
        flow.tokenRevisionAtStart !== tokenRevision ||
        flow.expiresAt <= Date.now()
      ) {
        removeOAuthFlow(flowId);
        return { status: "expired", message: "This GitHub sign-in was cancelled." };
      }
      const exchangedAt = Date.now();
      const expiresAt = response.expires_in
        ? exchangedAt + response.expires_in * 1000
        : undefined;
      flow.exchanged = {
        token: response.access_token,
        scope: response.scope ?? "",
        refreshToken: response.refresh_token,
        expiresAt,
        refreshTokenExpiresAt: response.refresh_token_expires_in
          ? exchangedAt + response.refresh_token_expires_in * 1000
          : undefined,
        finishExpiresAt: Math.min(
          expiresAt ?? Number.POSITIVE_INFINITY,
          exchangedAt + OAUTH_FINISH_TTL_MS,
        ),
      };
      scheduleOAuthCleanup(flowId, flow, flow.exchanged.finishExpiresAt);
      return finishOAuthDeviceFlow(flowId, flow);
    }
    if (response.error === "authorization_pending") {
      return { status: "pending", retryAfterMs: flow.intervalMs };
    }
    if (response.error === "slow_down") {
      flow.intervalMs += 5_000;
      flow.nextPollAt = Date.now() + flow.intervalMs;
      return { status: "pending", retryAfterMs: flow.intervalMs };
    }
    if (response.error === "access_denied") {
      removeOAuthFlow(flowId);
      return { status: "denied", message: "GitHub authorization was cancelled." };
    }
    if (response.error === "expired_token") {
      removeOAuthFlow(flowId);
      return { status: "expired", message: "The GitHub sign-in code expired. Start again." };
    }
    removeOAuthFlow(flowId);
    throw oauthError(response, `GitHub OAuth failed (${res.status})`);
  } finally {
    flow.polling = false;
  }
}

export async function cancelOAuthDeviceFlow(flowId: string): Promise<void> {
  const flow = oauthFlows.get(flowId);
  if (!flow) return;
  flow.cancelled = true;
  if (!flow.commitStarted || !flow.commitPromise) {
    removeOAuthFlow(flowId);
    return;
  }
  await flow.commitPromise.catch(() => undefined);
  if (flow.committedRevision === null) {
    removeOAuthFlow(flowId);
    return;
  }

  const rollback = tokenWriteQueue.then(async () => {
    if (flow.committedRevision !== tokenRevision) return;
    if (flow.previousConfig) {
      await persistTokenConfig(flow.previousConfig);
      await clearRefreshRecovery().catch(() => undefined);
    } else {
      await clearRefreshRecovery();
      await fs.rm(tokenFile(), { force: true });
    }
    tokenRevision++;
    pendingOAuthRefresh = null;
    cache = flow.previousConfig;
    loaded = true;
  });
  tokenWriteQueue = rollback.catch(() => undefined);
  try {
    await rollback;
  } catch (e) {
    if (oauthFlows.get(flowId) === flow) {
      scheduleOAuthCleanup(flowId, flow, Date.now() + 1_000);
    }
    throw e;
  }
  removeOAuthFlow(flowId);
}

/** Fetch the authenticated user for a token; throws on an invalid token. */
export async function fetchUser(token: string, signal?: AbortSignal): Promise<GitHubUser> {
  const res = await fetch(`${API}/user`, { headers: ghHeaders(token), signal });
  if (!res.ok) throw ghError(res.status, await res.text());
  const j = (await res.json()) as {
    login: string;
    name: string | null;
    avatar_url: string | null;
    id: number;
    email: string | null;
  };
  return {
    login: j.login,
    name: j.name ?? null,
    avatarUrl: j.avatar_url ?? null,
    id: j.id,
    email: j.email ?? null,
  };
}

/**
 * The account's primary verified email via `/user/emails`. Requires the token's
 * `user:email` (or `read:user`) scope; returns null if the scope is missing or
 * the call fails, so the caller can fall back gracefully.
 */
export async function fetchPrimaryEmail(token: string): Promise<string | null> {
  try {
    const res = await fetch(`${API}/user/emails`, { headers: ghHeaders(token) });
    if (!res.ok) return null;
    const emails = (await res.json()) as Array<{
      email: string;
      primary: boolean;
      verified: boolean;
    }>;
    if (!Array.isArray(emails)) return null;
    const chosen =
      emails.find((e) => e.primary && e.verified) ??
      emails.find((e) => e.verified) ??
      emails[0];
    return chosen?.email ?? null;
  } catch {
    return null;
  }
}

/**
 * Commit identity derived from the connected GitHub account, or null if no
 * token is stored / it's invalid. Prefers the primary verified email; falls
 * back to the public-profile email, then GitHub's noreply address, so commits
 * always attribute to the account even when no email scope is granted.
 */
export async function githubIdentity(): Promise<CommitIdentity | null> {
  const token = await getToken();
  if (!token) return null;
  try {
    const u = await fetchUser(token);
    const name = u.name || u.login;
    const primary = await fetchPrimaryEmail(token);
    const email = primary || u.email || `${u.id}+${u.login}@users.noreply.github.com`;
    return { name, email };
  } catch {
    return null;
  }
}

/** Current connection status: whether credentials are stored and, if valid, the user. */
export async function status(): Promise<{
  configured: boolean;
  authMethod: GitHubAuthMethod | null;
  user: GitHubUser | null;
  error?: string;
}> {
  const stored = await read();
  if (!stored) return { configured: false, authMethod: null, user: null };
  const token = await getToken();
  const authMethod = (await read())?.authMethod ?? stored.authMethod;
  if (!token) return { configured: true, authMethod, user: null, error: "OAuth token expired" };
  try {
    return { configured: true, authMethod, user: await fetchUser(token) };
  } catch (e) {
    return {
      configured: true,
      authMethod,
      user: null,
      error: e instanceof Error ? e.message : "Invalid token",
    };
  }
}

export interface GitHubRepo {
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  cloneUrl: string;
  description: string | null;
  updatedAt: string | null;
}

/**
 * List repositories the authenticated account can access (owned, collaborator,
 * and org member), public and private, most-recently-updated first. Paginates
 * up to a sane cap so the clone picker stays snappy.
 */
export async function listRepos(token: string): Promise<GitHubRepo[]> {
  const perPage = 100;
  const maxPages = 5;
  const repos: GitHubRepo[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const url =
      `${API}/user/repos?per_page=${perPage}&page=${page}` +
      `&sort=updated&affiliation=owner,collaborator,organization_member`;
    const res = await fetch(url, { headers: ghHeaders(token) });
    if (!res.ok) throw ghError(res.status, await res.text());
    const batch = (await res.json()) as Array<{
      full_name: string;
      name: string;
      owner: { login: string };
      private: boolean;
      clone_url: string;
      description: string | null;
      updated_at: string | null;
    }>;
    for (const r of batch) {
      repos.push({
        fullName: r.full_name,
        name: r.name,
        owner: r.owner?.login ?? "",
        private: r.private,
        cloneUrl: r.clone_url,
        description: r.description ?? null,
        updatedAt: r.updated_at ?? null,
      });
    }
    if (batch.length < perPage) break;
  }
  return repos;
}

export interface CreatedRepo {
  fullName: string;
  cloneUrl: string;
  htmlUrl: string;
}

/** Create a repository under the authenticated account. */
export async function createRepo(
  token: string,
  opts: { name: string; description?: string; private: boolean; autoInit?: boolean },
): Promise<CreatedRepo> {
  const res = await fetch(`${API}/user/repos`, {
    method: "POST",
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({
      name: opts.name,
      description: opts.description || undefined,
      private: opts.private,
      auto_init: opts.autoInit ?? false,
    }),
  });
  if (!res.ok) throw ghError(res.status, await res.text());
  const j = (await res.json()) as { full_name: string; clone_url: string; html_url: string };
  return { fullName: j.full_name, cloneUrl: j.clone_url, htmlUrl: j.html_url };
}

// ---- Pull requests ----

/** A repository as the pull-request dialog needs it (target + fork lineage). */
export interface GitHubRepoRef {
  fullName: string;
  owner: string;
  name: string;
  defaultBranch: string;
  private: boolean;
  isFork: boolean;
  /** The upstream this repo was forked from ("owner/name"), or null. */
  parentFullName: string | null;
}

/** A user that can be requested as a reviewer or set as an assignee. */
export interface GitHubAccount {
  login: string;
  avatarUrl: string | null;
}

export interface GitHubLabel {
  name: string;
  color: string;
  description: string | null;
}

export interface CreatedPullRequest {
  number: number;
  htmlUrl: string;
  title: string;
}

/**
 * Extract `owner/repo` from a github.com clone URL — HTTPS, `ssh://`, `git://`,
 * and the scp-like `git@github.com:owner/repo.git` form. Anything hosted
 * elsewhere (GitLab, a private server) returns null so non-GitHub remotes are
 * simply skipped by the caller.
 */
export function parseGitHubSlug(url: string): { owner: string; repo: string } | null {
  const raw = (url ?? "").trim();
  if (!raw) return null;

  let host: string;
  let rest: string;
  const scp = raw.match(/^[\w.+-]+@([^/:]+):(.+)$/);
  if (scp) {
    host = scp[1];
    rest = scp[2];
  } else {
    const m = raw.match(/^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/i);
    if (!m) return null;
    host = m[1];
    rest = m[2];
  }

  host = host.toLowerCase().replace(/:\d+$/, "");
  if (host !== "github.com" && host !== "www.github.com") return null;

  const segments = rest
    .replace(/[/]+$/, "")
    .replace(/\.git$/i, "")
    .split("/")
    .filter(Boolean);
  if (segments.length < 2) return null;
  return { owner: segments[0], repo: segments[1] };
}

function toRepoRef(j: {
  full_name: string;
  name: string;
  owner: { login: string };
  default_branch: string;
  private: boolean;
  fork: boolean;
  parent?: { full_name: string } | null;
}): GitHubRepoRef {
  return {
    fullName: j.full_name,
    owner: j.owner?.login ?? "",
    name: j.name,
    defaultBranch: j.default_branch || "main",
    private: j.private,
    isFork: Boolean(j.fork),
    parentFullName: j.parent?.full_name ?? null,
  };
}

/** Fetch a single repository, including its fork parent when it has one. */
export async function fetchRepo(token: string, owner: string, repo: string): Promise<GitHubRepoRef> {
  const res = await fetch(`${API}/repos/${owner}/${repo}`, { headers: ghHeaders(token) });
  if (!res.ok) throw ghError(res.status, await res.text());
  return toRepoRef(await res.json());
}

/** Branch names of a repository (paginated up to a sane cap). */
export async function listBranchNames(
  token: string,
  owner: string,
  repo: string,
): Promise<string[]> {
  const perPage = 100;
  const maxPages = 5;
  const names: string[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = `${API}/repos/${owner}/${repo}/branches?per_page=${perPage}&page=${page}`;
    const res = await fetch(url, { headers: ghHeaders(token) });
    if (!res.ok) throw ghError(res.status, await res.text());
    const batch = (await res.json()) as Array<{ name: string }>;
    for (const b of batch) names.push(b.name);
    if (batch.length < perPage) break;
  }
  return names;
}

/**
 * GET a list endpoint that requires push access, degrading to an empty list when
 * the token can only read the repo — the dialog then shows "None available"
 * instead of failing outright.
 */
async function listOrEmpty<T>(token: string, path: string): Promise<T[]> {
  try {
    const res = await fetch(`${API}${path}`, { headers: ghHeaders(token) });
    if (!res.ok) return [];
    const j = await res.json();
    return Array.isArray(j) ? (j as T[]) : [];
  } catch {
    return [];
  }
}

function toAccounts(raw: Array<{ login: string; avatar_url: string | null }>): GitHubAccount[] {
  return raw.map((u) => ({ login: u.login, avatarUrl: u.avatar_url ?? null }));
}

/** Users who can be requested as reviewers (repo collaborators). */
export async function listCollaborators(
  token: string,
  owner: string,
  repo: string,
): Promise<GitHubAccount[]> {
  return toAccounts(
    await listOrEmpty<{ login: string; avatar_url: string | null }>(
      token,
      `/repos/${owner}/${repo}/collaborators?per_page=100`,
    ),
  );
}

/** Users who can be assigned to an issue/pull request. */
export async function listAssignableUsers(
  token: string,
  owner: string,
  repo: string,
): Promise<GitHubAccount[]> {
  return toAccounts(
    await listOrEmpty<{ login: string; avatar_url: string | null }>(
      token,
      `/repos/${owner}/${repo}/assignees?per_page=100`,
    ),
  );
}

/** Labels defined on a repository. */
export async function listLabels(
  token: string,
  owner: string,
  repo: string,
): Promise<GitHubLabel[]> {
  const raw = await listOrEmpty<{ name: string; color: string; description: string | null }>(
    token,
    `/repos/${owner}/${repo}/labels?per_page=100`,
  );
  return raw.map((l) => ({ name: l.name, color: l.color, description: l.description ?? null }));
}

/**
 * Open a pull request on `owner/repo`. For a cross-repository (fork) PR the
 * caller passes `head` as "owner:branch"; same-repo PRs pass the bare branch.
 */
export async function createPullRequest(
  token: string,
  opts: {
    owner: string;
    repo: string;
    title: string;
    body: string;
    head: string;
    base: string;
    draft: boolean;
  },
): Promise<CreatedPullRequest> {
  const res = await fetch(`${API}/repos/${opts.owner}/${opts.repo}/pulls`, {
    method: "POST",
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({
      title: opts.title,
      body: opts.body || undefined,
      head: opts.head,
      base: opts.base,
      draft: opts.draft,
    }),
  });
  if (!res.ok) throw ghError(res.status, await res.text());
  const j = (await res.json()) as { number: number; html_url: string; title: string };
  return { number: j.number, htmlUrl: j.html_url, title: j.title };
}

/** Request reviews on an open pull request. */
export async function requestReviewers(
  token: string,
  owner: string,
  repo: string,
  number: number,
  reviewers: string[],
): Promise<void> {
  const res = await fetch(`${API}/repos/${owner}/${repo}/pulls/${number}/requested_reviewers`, {
    method: "POST",
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ reviewers }),
  });
  if (!res.ok) throw ghError(res.status, await res.text());
}

/** Set assignees and/or labels (a PR is an issue as far as these fields go). */
export async function updateIssueFields(
  token: string,
  owner: string,
  repo: string,
  number: number,
  fields: { assignees?: string[]; labels?: string[] },
): Promise<void> {
  const res = await fetch(`${API}/repos/${owner}/${repo}/issues/${number}`, {
    method: "PATCH",
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });
  if (!res.ok) throw ghError(res.status, await res.text());
}

/** Test hook to reset the in-memory cache. */
export function _resetTokenCache(): void {
  tokenRevision++;
  cache = null;
  loaded = false;
  refreshPromise = null;
  pendingOAuthRefresh = null;
  for (const flow of oauthFlows.values()) {
    if (flow.cleanupTimer) clearTimeout(flow.cleanupTimer);
  }
  oauthFlows.clear();
}
