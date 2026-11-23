import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { config } from "../lib/config.js";

export interface AppSettings {
  enabled: boolean;
  model: "florence-2-base" | "florence-2-large" | "tesseract";
  schedule: string;
  whisper_model: "base" | "small" | "medium";
}

const SETTINGS_FILE = "settings.json";

function whisperModel(value: string | undefined): AppSettings["whisper_model"] {
  return value === "base" || value === "medium" ? value : "small";
}

const DEFAULT_SETTINGS: AppSettings = {
  enabled: config.enableAiTranscription,
  model: "florence-2-base",
  schedule: config.transcriptionSchedule,
  whisper_model: whisperModel(config.whisperModel),
};

let cached: AppSettings | null = null;

function settingsPath(): string {
  return path.join(config.configDir, SETTINGS_FILE);
}

export function getSettings(): AppSettings {
  if (cached) return { ...cached };
  try {
    if (fs.existsSync(settingsPath())) {
      const raw = JSON.parse(fs.readFileSync(settingsPath(), "utf8")) as Partial<AppSettings>;
      cached = {
        enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_SETTINGS.enabled,
        model:
          raw.model === "florence-2-large" || raw.model === "tesseract"
            ? raw.model
            : "florence-2-base",
        schedule: typeof raw.schedule === "string" ? raw.schedule : DEFAULT_SETTINGS.schedule,
        whisper_model: whisperModel(raw.whisper_model),
      };
      return { ...cached };
    }
  } catch {
    // fall through to defaults
  }
  cached = { ...DEFAULT_SETTINGS };
  return { ...cached };
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = getSettings();
  const next: AppSettings = {
    enabled: typeof patch.enabled === "boolean" ? patch.enabled : current.enabled,
    model:
      patch.model === "florence-2-large" || patch.model === "tesseract"
        ? patch.model
        : current.model === "florence-2-large" || current.model === "tesseract"
          ? current.model
          : "florence-2-base",
    schedule: typeof patch.schedule === "string" && patch.schedule.trim() ? patch.schedule : current.schedule,
    whisper_model: whisperModel(patch.whisper_model),
  };
  await fsp.mkdir(config.configDir, { recursive: true });
  await fsp.writeFile(settingsPath(), JSON.stringify(next, null, 2), { mode: 0o600 });
  cached = next;
  return { ...next };
}