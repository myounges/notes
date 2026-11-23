import cron from "node-cron";
import type { FastifyInstance } from "fastify";
import { getSettings } from "../lib/settings.js";
import { config } from "../lib/config.js";

let task: ReturnType<typeof cron.schedule> | null = null;

/**
 * Schedules the AI worker pass based on the current settings.schedule.
 * Reschedules automatically if settings change at runtime.
 */
export function scheduleTranscription(app: FastifyInstance): void {
  app.log.info(`AI transcription ${config.enableAiTranscription ? "enabled" : "disabled"}`);
  if (!config.enableAiTranscription) return;
  void startCron(app);
}

export function startCron(app: FastifyInstance): void {
  const settings = getSettings();
  if (!settings.enabled) {
    app.log.info("AI transcription disabled in settings; not scheduling");
    return;
  }
  const expr = settings.schedule;
  if (!cron.validate(expr)) {
    app.log.warn(`Invalid cron expression "${expr}" — transcription not scheduled`);
    return;
  }
  if (task) task.stop();
  task = cron.schedule(
    expr,
    () => {
      app.log.info("Running scheduled AI transcription pass");
      runPass(app).catch((err) => app.log.error({ err }, "Scheduled transcription pass failed"));
    },
    { timezone: "UTC" },
  );
  app.log.info(`Scheduled AI transcription on cron "${expr}"`);
}

async function runPass(app: FastifyInstance): Promise<void> {
  const workerUrl = config.aiWorkerUrl;
  try {
    const res = await fetch(`${workerUrl}/process`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings: getSettings() }),
      signal: AbortSignal.timeout(60 * 60 * 1000),
    });
    const data = await res.json();
    app.log.info({ worker: data }, "AI transcription pass complete");
  } catch (err) {
    app.log.error({ err }, "AI worker unreachable during scheduled pass");
  }
}

/** Call after updating settings to reschedule with the new cron/settings. */
export function reschedule(app: FastifyInstance): void {
  if (!config.enableAiTranscription) return;
  startCron(app);
}

export function stopSchedule(): void {
  if (task) {
    task.stop();
    task = null;
  }
}