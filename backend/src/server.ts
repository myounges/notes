import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { config } from "./lib/config.js";
import { ensureDirs } from "./storage/notes.js";
import { initIndex } from "./storage/index.js";
import { authHook, attachAuthRoutes } from "./routes/auth.js";
import { attachNoteRoutes } from "./routes/notes.js";
import { attachSearchRoutes } from "./routes/search.js";
import { attachImportRoutes } from "./routes/import.js";
import { attachExportRoutes } from "./routes/export.js";
import { attachTranscriptionRoutes } from "./routes/transcription.js";
import { attachAutotagRoutes } from "./routes/autotag.js";
import { attachVoiceRoutes } from "./routes/voice.js";
import { attachLinkPreviewRoutes } from "./routes/linkpreview.js";
import { scheduleTranscription, stopSchedule } from "./lib/scheduler.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// In source mode, frontend dist is at ../frontend/dist relative to backend/src.
// In compiled mode: dist/server.js -> ../.. (backend) -> ../frontend/dist
const FRONTEND_DIST = process.env.FRONTEND_DIST
  ? process.env.FRONTEND_DIST
  : path.resolve(__dirname, "../../frontend/dist");

export async function buildServer(overrides: Partial<typeof config> = {}) {
  const cfg = { ...config, ...overrides };
  await ensureDirs();
  initIndex();

  const app = Fastify({
    logger: { level: "info" },
    trustProxy: cfg.trustProxy,
    bodyLimit: cfg.maxUploadMb * 1024 * 1024,
  });

  await app.register(cookie);
  await app.register(rateLimit, { max: 1000, timeWindow: "1 minute" });
  await app.register(multipart, {
    limits: { fileSize: cfg.maxUploadMb * 1024 * 1024, files: 20 },
  });

  app.addHook("onSend", (_req, reply, _payload, done) => {
    if (!reply.getHeader("x-content-type-options")) {
      reply.header("X-Content-Type-Options", "nosniff");
    }
    if (!reply.getHeader("x-frame-options")) {
      reply.header("X-Frame-Options", "DENY");
    }
    if (!reply.getHeader("referrer-policy")) {
      reply.header("Referrer-Policy", "no-referrer");
    }
    done();
  });

  authHook(app);
  attachAuthRoutes(app);
  attachNoteRoutes(app);
  attachSearchRoutes(app);
  attachImportRoutes(app);
  attachExportRoutes(app);
  attachTranscriptionRoutes(app);
  attachAutotagRoutes(app);
  attachVoiceRoutes(app);
  attachLinkPreviewRoutes(app);

  // Serve static frontend (after API so /api/* wins)
  try {
    await app.register(fastifyStatic, {
      root: FRONTEND_DIST,
      prefix: "/",
    });
  } catch {
    app.log.warn("Frontend dist not present — serving API only");
  }

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/")) {
      return reply.code(404).send({ error: "Not found" });
    }
    try {
      return reply.sendFile("index.html");
    } catch {
      return reply.code(404).send({ error: "Not found" });
    }
  });

  app.addHook("onClose", async () => {
    stopSchedule();
  });

  scheduleTranscription(app);

  return app;
}

async function start() {
  const app = await buildServer();
  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

if (process.argv[1] && path.normalize(process.argv[1]).includes("server")) {
  start();
}