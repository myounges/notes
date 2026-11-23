import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

export interface SessionPayload {
  sub: "user";
  exp: number; // unix ms
  iat: number;
}

const ALGO = "sha256";

function b64url(data: Buffer | string): string {
  return Buffer.from(data).toString("base64url");
}

function sign(payload: string, secret: string): string {
  return crypto.createHmac(ALGO, secret).update(payload).digest("base64url");
}

export function issueSessionToken(secret: string, ttlMs: number): { token: string; exp: number } {
  const now = Date.now();
  const exp = now + ttlMs;
  const payload: SessionPayload = { sub: "user", exp, iat: now };
  const payloadB64 = b64url(JSON.stringify(payload));
  const token = `${payloadB64}.${sign(payloadB64, secret)}`;
  return { token, exp };
}

/** Returns the valid payload or null if invalid/expired/tampered. */
export function verifySessionToken(token: string | undefined, secret: string): SessionPayload | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(payloadB64, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as SessionPayload;
    if (payload.sub !== "user" || typeof payload.exp !== "number") return null;
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Sliding renewal: re-issue when less than half the TTL remains. */
export function shouldRenew(payload: SessionPayload): boolean {
  return payload.exp - Date.now() < config.sessionTtlMs / 2;
}

// ---------- password bootstrap ----------

export interface AuthConfig {
  passwordHash: string;
  sessionSecret: string;
}

const AUTH_FILE = "auth.json";

export function authFilePath(): string {
  return path.join(config.configDir, AUTH_FILE);
}

export function ensureSessionSecret(): string {
  if (config.sessionSecret) return config.sessionSecret;
  let auth: AuthConfig | null = null;
  try {
    auth = readAuthConfig();
  } catch {
    // not yet existing
  }
  if (auth?.sessionSecret) return auth.sessionSecret;
  const generated = crypto.randomBytes(32).toString("hex");
  if (auth) {
    fs.mkdirSync(config.configDir, { recursive: true });
    fs.writeFileSync(authFilePath(), JSON.stringify({ ...auth, sessionSecret: generated }, null, 2), {
      mode: 0o600,
    });
  }
  return generated;
}

export function readAuthConfig(): AuthConfig {
  const raw = fs.readFileSync(authFilePath(), "utf8");
  const parsed = JSON.parse(raw) as Partial<AuthConfig>;
  if (typeof parsed.passwordHash !== "string" || !parsed.passwordHash) {
    throw new Error(`No password hash in ${authFilePath()} — run: npm run setup-password`);
  }
  return {
    passwordHash: parsed.passwordHash,
    sessionSecret:
      typeof parsed.sessionSecret === "string" && parsed.sessionSecret ? parsed.sessionSecret : "",
  };
}

export function authConfigured(): boolean {
  try {
    const c = readAuthConfig();
    return !!c.passwordHash;
  } catch {
    return false;
  }
}

export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, 12);
}

export function verifyPassword(password: string, hash: string): boolean {
  return bcrypt.compareSync(password, hash);
}

/** Write initial auth config (used by bootstrap script). */
export async function bootstrapPassword(password: string, existingSecret?: string): Promise<void> {
  if (password.length < 8) {
    throw new Error("Password must be at least 8 characters long");
  }
  await fsp.mkdir(config.configDir, { recursive: true });
  const existing = readAuthConfigSafe();
  const secret = existingSecret ?? existing?.sessionSecret ?? crypto.randomBytes(32).toString("hex");
  const payload: AuthConfig = { passwordHash: hashPassword(password), sessionSecret: secret };
  await fsp.writeFile(authFilePath(), JSON.stringify(payload, null, 2), { mode: 0o600 });
}

function readAuthConfigSafe(): AuthConfig | null {
  try {
    return readAuthConfig();
  } catch {
    return null;
  }
}

// ---------- device detection ----------

export function deviceFromUserAgent(ua: string | undefined): string {
  if (!ua) return "Unknown device";
  let device = "Desktop";
  if (/iPhone|iPod/.test(ua)) device = "iPhone";
  else if (/iPad/.test(ua)) device = "iPad";
  else if (/Android/.test(ua)) device = "Android";
  else if (!/Mobi/.test(ua) && /Macintosh|Windows|Linux|X11/.test(ua)) device = "Desktop";
  const browser =
    /Edg\//.test(ua) ? "Edge"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari"
    : /Firefox\//.test(ua) ? "Firefox"
    : /OPR\//.test(ua) ? "Opera"
    : "";
  return browser ? `${device} / ${browser}` : device;
}