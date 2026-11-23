import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "notes-settings-"));
const originalEnv = process.env.DATA_DIR;
process.env.DATA_DIR = dataDir;

const settings = await import("../src/lib/settings.js");

afterAll(() => {
  if (originalEnv === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalEnv;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("settings (whisper model)", () => {
  it("defaults to small", () => {
    expect(settings.getSettings().whisper_model).toBe("small");
  });

  it("persists a chosen model and falls back on invalid values", async () => {
    const updated = await settings.updateSettings({ whisper_model: "base" });
    expect(updated.whisper_model).toBe("base");
    expect(settings.getSettings().whisper_model).toBe("base");

    const invalid = await settings.updateSettings({ whisper_model: "huge" as never });
    expect(invalid.whisper_model).toBe("small");
  });
});