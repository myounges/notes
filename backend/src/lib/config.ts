import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  return v === "1" || v.toLowerCase() === "true";
}

function int(v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
}

/** Default data root. In production this is /data; locally it's ./data at repo root. */
const defaultDataDir = process.env.DATA_DIR ?? path.resolve(__dirname, "../../../data");

export interface AppConfig {
  port: number;
  host: string;
  dataDir: string;
  notesDir: string;
  trashDir: string;
  indexDbPath: string;
  configDir: string;
  sessionSecret: string;
  sessionTtlMs: number;
  trustProxy: boolean;
  maxUploadMb: number;
  enableAiTranscription: boolean;
  transcriptionSchedule: string;
  whisperModel: string;
  aiWorkerUrl: string;
  cookieSecure: boolean;
  loginRateLimit: { max: number; timeWindow: string };
}

function buildConfig(): AppConfig {
  const dataDir = process.env.DATA_DIR ?? defaultDataDir;
  const notesDir = path.join(dataDir, "notes");
  const trashDir = path.join(dataDir, "trash");
  const configDir = path.join(dataDir, "config");
  const indexDbPath = path.join(dataDir, "index", "search.db");

  const sessionSecret = process.env.SESSION_SECRET ?? "";
  const cookieSecure = bool(process.env.COOKIE_SECURE, true);

  return {
    port: int(process.env.PORT, 8082),
    host: process.env.HOST ?? "0.0.0.0",
    dataDir,
    notesDir,
    trashDir,
    indexDbPath,
    configDir,
    sessionSecret,
    // 30 days
    sessionTtlMs: int(process.env.SESSION_TTL_MS, 30 * 24 * 60 * 60 * 1000),
    trustProxy: bool(process.env.TRUST_PROXY, false),
    maxUploadMb: int(process.env.MAX_UPLOAD_MB, 512),
    enableAiTranscription: bool(process.env.ENABLE_AI_TRANSCRIPTION, false),
    transcriptionSchedule: process.env.TRANSCRIPTION_SCHEDULE ?? "0 2 * * *",
    whisperModel: process.env.WHISPER_MODEL ?? "small",
    aiWorkerUrl: process.env.AI_WORKER_URL ?? "http://ai-worker:8000",
    cookieSecure,
    loginRateLimit: { max: 5, timeWindow: "15 minutes" },
  };
}

export const config = buildConfig();