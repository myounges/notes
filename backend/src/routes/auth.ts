import type { FastifyInstance } from "fastify";
import {
  readAuthConfig,
  verifyPassword,
  issueSessionToken,
  verifySessionToken,
  ensureSessionSecret,
  shouldRenew,
} from "../lib/auth.js";
import { config } from "../lib/config.js";

export const COOKIE_NAME = "notes_session";

export function attachAuthRoutes(app: FastifyInstance): void {
  const cookieOpts = {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "strict" as const,
    path: "/",
  };

  app.post("/api/auth/login", { config: { rateLimit: { max: config.loginRateLimit.max, timeWindow: config.loginRateLimit.timeWindow } } }, async (req, reply) => {
    const { password } = (req.body ?? {}) as { password?: unknown };
    if (typeof password !== "string" || !password) {
      return reply.code(400).send({ error: "password is required" });
    }
    const auth = readAuthConfigSafe();
    if (!auth || !verifyPassword(password, auth.passwordHash)) {
      return reply.code(401).send({ error: "Invalid password" });
    }
    const secret = ensureSessionSecret();
    const { token, exp } = issueSessionToken(secret, config.sessionTtlMs);
    reply.setCookie(COOKIE_NAME, token, { ...cookieOpts, expires: new Date(exp) });
    return { ok: true };
  });

  app.post("/api/auth/logout", async (_req, reply) => {
    reply.clearCookie(COOKIE_NAME, { ...cookieOpts });
    return { ok: true };
  });

  app.get("/api/auth/session", async (req, reply) => {
    const secret = ensureSessionSecret();
    const payload = verifySessionToken(req.cookies[COOKIE_NAME], secret);
    if (!payload) return reply.code(401).send({ error: "Unauthorized" });
    return { authenticated: true };
  });

  function readAuthConfigSafe() {
    try {
      return readAuthConfig();
    } catch {
      return null;
    }
  }
}

export interface AuthenticatedRequest {
  authenticated: boolean;
}

/** Auth hook: protects everything under /api except allowlisted paths. */
export function authHook(app: FastifyInstance): void {
  app.addHook("onRequest", (req, reply, done) => {
    const url = req.url.split("?")[0];
    const allowlist = new Set(["/api/auth/login", "/api/health"]);
    if (!url.startsWith("/api/") || allowlist.has(url)) {
      done();
      return;
    }
    const secret = ensureSessionSecret();
    const payload = verifySessionToken(req.cookies[COOKIE_NAME], secret);
    if (!payload) {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    if (shouldRenew(payload)) {
      const { token, exp } = issueSessionToken(secret, config.sessionTtlMs);
      reply.setCookie(COOKIE_NAME, token, {
        httpOnly: true,
        secure: config.cookieSecure,
        sameSite: "strict",
        path: "/",
        expires: new Date(exp),
      });
    }
    done();
  });
}