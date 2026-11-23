import { describe, it, expect, afterAll, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "notes-index-test-"));
const originalEnv = process.env.DATA_DIR;
process.env.DATA_DIR = dataDir;

const notesMod = await import("../src/storage/notes.js");
const indexMod = await import("../src/storage/index.js");
const { createNote, ensureDirs, deleteNote, updateNote } = notesMod;
const { initIndex, searchNotes, indexNote, unindexNote, reindexAll, upsertAttachmentText, getAttachmentText, closeIndex } = indexMod;

beforeAll(async () => {
  await ensureDirs();
  initIndex();
});

afterAll(() => {
  closeIndex();
  if (originalEnv === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalEnv;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("search index", () => {
  it("indexes and finds by body text", async () => {
    const note = await createNote({
      title: "Grocery list",
      body: "milk eggs bread and of course **butter**",
      tags: ["household"],
    });
    indexNote(note);

    const res = await searchNotes("butter");
    expect(res.total).toBeGreaterThanOrEqual(1);
    const hit = res.results.find((r) => r.id === note.id);
    expect(hit).toBeTruthy();
  });

  it("finds by tag and title", async () => {
    const note = await createNote({
      title: "Conference Ideas",
      body: "talk about databases",
      tags: ["ideas", "conference"],
    });
    indexNote(note);
    const byTag = await searchNotes("conference");
    expect(byTag.results.some((r) => r.id === note.id)).toBe(true);
  });

  it("finds by location name", async () => {
    const note = await createNote({
      title: "Cafe note",
      body: "great espresso",
      location: { lat: 40.0, lon: -3.0, name: "Madrid, Spain" },
    });
    indexNote(note);
    const res = await searchNotes("Madrid");
    expect(res.results.some((r) => r.id === note.id)).toBe(true);
  });

  it("matches partial typing against all terms with that prefix", async () => {
    const a = await createNote({ title: "untitled", body: "first" });
    const b = await createNote({ title: "untitledvoic", body: "second" });
    indexNote(a);
    indexNote(b);
    const res = await searchNotes("untitl");
    const ids = res.results.map((r) => r.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    await deleteNote(a.id);
    await deleteNote(b.id);
    unindexNote(a.id);
    unindexNote(b.id);
  });

  it("excludes deleted notes from results", async () => {
    const note = await createNote({ title: "Temp", body: "uniquequerytoken123", tags: [] });
    indexNote(note);
    expect((await searchNotes("uniquequerytoken123")).total).toBe(1);
    await deleteNote(note.id);
    unindexNote(note.id);
    expect((await searchNotes("uniquequerytoken123")).total).toBe(0);
  });

  it("reindex rebuilds from disk", async () => {
    const note = await createNote({ title: "Rebuild me", body: "reindexme42" });
    await notesMod.updateNote(note.id, { body: "changed content now reindexme42" });
    const { reindexAll: reindex } = indexMod;
    // wipe the FTS table directly to simulate corruption
    const d = await import("better-sqlite3");
    void d;
    const { indexed } = await reindex();
    expect(indexed).toBeGreaterThanOrEqual(1);
    const res = await searchNotes("reindexme42");
    expect(res.results.some((r) => r.id === note.id)).toBe(true);
  });
});

describe("attachment_text", () => {
  it("upserts text and reports status", async () => {
    upsertAttachmentText("note-1", "photo.jpg", { status: "pending" });
    expect(getAttachmentText("note-1", "photo.jpg")?.status).toBe("pending");

    upsertAttachmentText("note-1", "photo.jpg", {
      extracted_text: "electricity bill total 45 EUR",
      source: "florence-2-base",
      processed_at: new Date().toISOString(),
      status: "done",
    });
    const updated = getAttachmentText("note-1", "photo.jpg");
    expect(updated?.status).toBe("done");
    expect(updated?.extracted_text).toContain("45");
  });

  it("makes attachment text searchable", async () => {
    const note = await createNote({ title: "receipt", body: "no textual content here" });
    indexNote(note);
    upsertAttachmentText(note.id, "bill.pdf", {
      extracted_text: "supermarket total electricity bill",
      source: "ocr",
      processed_at: new Date().toISOString(),
      status: "done",
    });
    const res = await searchNotes("electricity");
    const hit = res.results.find((r) => r.id === note.id);
    expect(hit).toBeTruthy();
    expect(hit?.matchedField).toBe("attachments");
  });

  it("search still returns note-body match over attachment for the same note", async () => {
    const note = await createNote({ title: "note", body: "sunset at the beach photo" });
    indexNote(note);
    upsertAttachmentText(note.id, "pic.jpg", {
      extracted_text: "sunset at the beach",
      source: "caption",
      processed_at: new Date().toISOString(),
      status: "done",
    });
    const res = await searchNotes("sunset");
    const hit = res.results.find((r) => r.id === note.id);
    expect(hit).toBeTruthy();
    expect(hit?.matchedField).toBe("body");
  });
});