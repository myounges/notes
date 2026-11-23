import type { FastifyInstance } from "fastify";
import { getSettings, updateSettings, type AppSettings } from "../lib/settings.js";
import { attachmentStatusCounts, listAttachmentText } from "../storage/index.js";

export function attachTranscriptionRoutes(app: FastifyInstance): void {
  app.get("/api/settings", async () => getSettings());

  app.put("/api/settings", async (req) => {
    const body = (req.body ?? {}) as Partial<AppSettings>;
    return updateSettings(body);
  });

  app.get("/api/transcription/status", async () => ({
    counts: attachmentStatusCounts(),
    attachments: listAttachmentText("pending").slice(0, 20),
  }));

  app.post("/api/transcription/run", async (_req, reply) => {
    const settings = getSettings();
    if (!settings.enabled) {
      return reply.code(400).send({ error: "AI transcription is disabled" });
    }
    // call the AI worker /process endpoint on internal network
    const workerUrl = process.env.AI_WORKER_URL ?? "http://ai-worker:8000";
    try {
      // The worker kicks the pass off in a background thread and replies
      // immediately, so a running pass must never tie up this request.
      const res = await fetch(`${workerUrl}/process`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings }),
        signal: AbortSignal.timeout(20_000),
      });
      const data = (await res.json()) as { started?: boolean; busy?: boolean; error?: string };
      if (data.started === true) {
        return { workerResponse: data, busy: true };
      }
      if (data.busy === true) {
        return reply.code(409).send({
          error: "A transcription pass is already running on the worker — it's still processing. Check status again in a bit.",
        });
      }
      return reply.code(502).send({
        error: `AI worker rejected the request: ${data.error ?? res.status}. Is the ai-worker container running?`,
      });
    } catch (err) {
      const msg = (err as Error).message;
      return reply.code(502).send({
        error: msg.includes("aborted")
          ? `AI worker is busy or slow — it did not respond in time (it may still be processing a pass). Check status again shortly.`
          : `AI worker unavailable: ${msg}. Is the ai-worker container running?`,
      });
    }
  });

}

/** Poll the AI worker health endpoint. */
export async function checkAiWorkerHealth(workerUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${workerUrl}/health`, { signal: AbortSignal.timeout(5_000) });
    const data = await res.json() as { model_loaded?: boolean };
    return data.model_loaded === true;
  } catch {
    return false;
  }
}