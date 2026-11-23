import fs from "node:fs/promises";
import path from "node:path";
import { readNote, attachmentDir } from "../storage/notes.js";
import { config } from "./config.js";

export interface VoiceOutcome {
  transcribed: boolean;
  busy?: boolean;
  language?: string | null;
  duration?: number | null;
  text?: string | null;
  error?: string | null;
}

type WorkerCall = (noteId: string, filename: string, model: string) => Promise<VoiceOutcome>;

/** Long timeout: on-demand Whisper runs on CPU and a long recording takes real time. */
export const VOICE_WORKER_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * Verify the note exists and owns the given attachment. Throws a non-2xx-style
 * Error (with a statusCode) so the route can map it to a reply.
 */
export async function resolveVoiceAttachment(noteId: string, filename: string): Promise<void> {
  await readNote(noteId); // throws if the note doesn't exist
  const file = path.join(attachmentDir(noteId), filename);
  const st = await fs.stat(file).catch(() => null);
  if (!st?.isFile()) {
    throw Object.assign(new Error("Voice note not found"), { statusCode: 404 });
  }
}

async function callWorker(workerUrl: string, noteId: string, filename: string, model: string): Promise<VoiceOutcome> {
  const res = await fetch(`${workerUrl}/transcribe-voice`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note_id: noteId, filename, model }),
    signal: AbortSignal.timeout(VOICE_WORKER_TIMEOUT_MS),
  });
  const data = (await res.json().catch(() => null)) as VoiceOutcome | null;
  if (!res.ok && !data) {
    throw new Error(`worker /transcribe-voice responded ${res.status}`);
  }
  return data ?? { transcribed: false, error: `Worker responded ${res.status}` };
}

/** Forward a voice transcription to the worker (default call; overridable in tests). */
export function transcribeVoice(
  noteId: string,
  filename: string,
  model: string,
  workerCall: WorkerCall = (id, name, m) => callWorker(config.aiWorkerUrl, id, name, m),
): Promise<VoiceOutcome> {
  return (async () => {
    await resolveVoiceAttachment(noteId, filename);
    return workerCall(noteId, filename, model);
  })();
}