import type { FastifyInstance } from "fastify";
import { sanitizeFilename } from "../storage/notes.js";
import { getSettings } from "../lib/settings.js";
import { resolveVoiceAttachment, transcribeVoice } from "../lib/voice.js";

// Single-flight: only one voice transcription can run in this process at a
// time. A second request during a run reports "already running" instead of
// launching a competing transcription (which would double-load Whisper and
// contend for worker CPU).
let transcribePromise: Promise<unknown> | null = null;

/** On-demand Whisper transcription of a recorded voice note.
 *
 * Runs asynchronously: the request returns 202 immediately and the worker
 * streams progress into the attachment_text row (see progress:
 * { phase, pct }) which the client polls. The transcript itself is persisted
 * into the note body by the worker when it finishes, so a long transcription
 * can never trip an edge-proxy timeout (e.g. Cloudflare's ~100s cap → 524).
 */
export function attachVoiceRoutes(app: FastifyInstance): void {
  app.post("/api/voice/transcribe", async (req, reply) => {
    const { noteId, filename } = (req.body ?? {}) as { noteId?: unknown; filename?: unknown };
    if (typeof noteId !== "string" || !noteId || typeof filename !== "string" || !filename) {
      return reply.code(400).send({ error: "noteId and filename are required" });
    }
    let safeName: string;
    try {
      safeName = sanitizeFilename(filename);
    } catch {
      return reply.code(400).send({ error: "Invalid filename" });
    }

    try {
      await resolveVoiceAttachment(noteId, safeName);
    } catch (err) {
      return reply.code((err as { statusCode?: number }).statusCode ?? 500).send({
        error: (err as Error).message,
      });
    }

    if (transcribePromise) {
      return reply.code(409).send({
        error:
          "A voice transcription is already running — it's converting your recording now. Check back in a moment.",
      });
    }

    const settings = getSettings();
    const job = transcribeVoice(noteId, safeName, settings.whisper_model);
    transcribePromise = job;
    // The HTTP response must not wait on the worker; failures are surfaced via
    // the status progress column, and the transcript is written to the note by
    // the worker when done. Just clear the single-flight guard. The nested
    // .catch keeps an unreachable worker from crashing the process on the
    // (unavoidably unsettled) background promise.
    void job
      .catch((err: unknown) => {
        app.log.warn({ err }, "Background voice transcription failed for %s/%s", noteId, safeName);
      })
      .finally(() => {
        transcribePromise = null;
      });
    return reply.code(202).send({ queued: true });
  });
}