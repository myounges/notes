import { describe, it, expect, afterAll, beforeAll, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Must set DATA_DIR before the storage modules are imported (they read env at load).
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "notes-voice-"));
const originalEnv = process.env.DATA_DIR;
process.env.DATA_DIR = dataDir;

const notes = await import("../src/storage/notes.js");
const voice = await import("../src/lib/voice.js");

afterAll(() => {
  if (originalEnv === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalEnv;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

beforeAll(async () => {
  await notes.ensureDirs();
});

beforeEach(() => {
  fs.rmSync(path.join(dataDir, "notes"), { recursive: true, force: true });
  fs.mkdirSync(path.join(dataDir, "notes"), { recursive: true });
});

describe("voice transcription orchestration", () => {
  it("forwards to the worker with the resolved filename and model", async () => {
    const note = await notes.createNote({ title: "Memo", body: "body" });
    const dir = notes.attachmentDir(note.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "voice.m4a"), "dummy audio bytes");

    const worker = vi.fn(async () => ({
      transcribed: true,
      language: "es",
      duration: 12.5,
      text: "Hola, esto es una nota de voz.",
      error: null,
    }));

    const res = await voice.transcribeVoice(note.id, "voice.m4a", "small", worker);
    expect(res.transcribed).toBe(true);
    expect(res.language).toBe("es");
    expect(worker).toHaveBeenCalledWith(note.id, "voice.m4a", "small");
  });

  it("rejects a transcription for a missing attachment", async () => {
    const note = await notes.createNote({ title: "M", body: "b" });
    const worker = vi.fn(async () => ({ transcribed: true }));
    await expect(voice.transcribeVoice(note.id, "missing.m4a", "small", worker)).rejects.toThrow(
      "Voice note not found",
    );
    expect(worker).not.toHaveBeenCalled();
  });

  it("rejects a transcription for a missing note", async () => {
    const worker = vi.fn(async () => ({ transcribed: true }));
    await expect(voice.transcribeVoice("no-such-note", "a.m4a", "small", worker)).rejects.toThrow();
  });

  it("returns the worker outcome unchanged (e.g. unsupported language refusal)", async () => {
    const note = await notes.createNote({ title: "M", body: "b" });
    const dir = notes.attachmentDir(note.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "br.m4a"), "x");
    const res = await voice.transcribeVoice(note.id, "br.m4a", "small", async () => ({
      transcribed: false,
      language: "fr",
      error: "Detected French — only English and Spanish voice notes are transcribed.",
    }));
    expect(res.transcribed).toBe(false);
    expect(res.language).toBe("fr");
  });
});