import type { FastifyInstance } from "fastify";
import { config } from "../lib/config.js";
import { runAutotag } from "../lib/autotag.js";

// Single-flight: only one Auto Tag pass can run in this process at a time.
// A second click during a run reports "already running" instead of launching
// a competing pass (which would contend for worker CPU and feel like a hang).
let autotagPromise: ReturnType<typeof runAutotag> | null = null;

/** Manual auto-tag pass: classifies notes and applies vocabulary-bound tags. */
export function attachAutotagRoutes(app: FastifyInstance): void {
  app.post("/api/autotag/run", async (_req, reply) => {
    if (autotagPromise) {
      return reply.code(409).send({
        error: "Auto Tag is already running — it's tagging notes right now. Refresh status in a moment.",
      });
    }
    autotagPromise = runAutotag(config.aiWorkerUrl);
    try {
      return await autotagPromise;
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("aborted")) {
        return reply.code(504).send({
          error:
            "AI worker is busy or slow — Auto Tag did not finish in time. If a transcription pass is running, wait for it and try again.",
        });
      }
      return reply.code(502).send({
        error: `AI worker unavailable: ${msg}. Is the ai-worker container running?`,
      });
    } finally {
      autotagPromise = null;
    }
  });
}