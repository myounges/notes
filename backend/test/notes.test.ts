import { describe, it, expect, afterAll, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Must set DATA_DIR before the storage module is imported (module reads env at load).
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "notes-test-"));
const originalEnv = process.env.DATA_DIR;
process.env.DATA_DIR = dataDir;

const notes = await import("../src/storage/notes.js");

afterAll(() => {
  if (originalEnv === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalEnv;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

beforeAll(async () => {
  await notes.ensureDirs();
});

const { ensureDirs, createNote, updateNote, readNote, deleteNote, listNotes, noteCount, listTags, computeWordCount, parseNoteFile, restoreNote, purgeTrashedNote, emptyTrash, listTrashedNotes, noteSize, writeAttachment } = notes;

describe("frontmatter round-trip", () => {
  it("creates a note and reads it back identically", async () => {
    await ensureDirs();
    const note = await createNote({
      title: "My First Note",
      body: "# Hello\n\nSome **bold** text and [a link](https://example.com).\n\n![diagram](attachments/x.png)",
      tags: ["ideas", "project-x"],
      device: "iPhone / Safari",
    });
    expect(note.id).toMatch(/^\d{4}-\d{2}-\d{2}-/);
    expect(note.title).toBe("My First Note");
    expect(note.word_count).toBeGreaterThanOrEqual(4);

    const reread = await readNote(note.id);
    expect(reread.title).toBe("My First Note");
    expect(reread.tags).toEqual(["ideas", "project-x"]);
    expect(reread.body).toContain("**bold**");
    expect(reread.location).toBeNull();
  });

  it("keeps an empty title empty (no 'Untitled' fallback)", async () => {
    const note = await createNote({ title: "", body: "some body" });
    expect(note.title).toBe("");
    const reread = await readNote(note.id);
    expect(reread.title).toBe("");
  });

  it("round-trips location metadata", async () => {
    const note = await createNote({
      title: "Location note",
      body: "body",
      location: { lat: 40.4168, lon: -3.7038, name: "Madrid, Spain" },
    });
    const reread = await readNote(note.id);
    expect(reread.location).toEqual({ lat: 40.4168, lon: -3.7038, name: "Madrid, Spain" });
  });

  it("keeps location.name optional", async () => {
    const note = await createNote({
      title: "Raw coords",
      body: "body",
      location: { lat: 1.5, lon: 2.5 },
    });
    const reread = await readNote(note.id);
    expect(reread.location?.lat).toBe(1.5);
    expect(reread.location?.name).toBeNull();
  });
});

describe("updates", () => {
  it("preserves created, bumps updated, recomputes word_count", async () => {
    const note = await createNote({ title: "Update me", body: "one two three" });
    const before = note.updated;
    await new Promise((r) => setTimeout(r, 10));
    const updated = await updateNote(note.id, { body: "one two three four five" });
    expect(updated.created).toBe(note.created);
    expect(updated.updated >= before).toBe(true);
    expect(updated.word_count).toBe(5);
    const reread = await readNote(note.id);
    expect(reread.word_count).toBe(5);
  });

  it("updates pinned and tags", async () => {
    const note = await createNote({ title: "Pinnable", body: "x", tags: ["a"] });
    const updated = await updateNote(note.id, { pinned: true, tags: ["a", "b"] });
    expect(updated.pinned).toBe(true);
    expect(updated.tags).toEqual(["a", "b"]);
  });
});

describe("deletion", () => {
  it("removes the folder", async () => {
    const note = await createNote({ title: "Delete me", body: "x" });
    await deleteNote(note.id);
    await expect(readNote(note.id)).rejects.toThrow();
  });
});

describe("bin", () => {
  it("soft-deletes a note into the bin and restores it", async () => {
    const note = await createNote({ title: "Bin me", body: "keep me safe" });
    await deleteNote(note.id);

    // Gone from the normal list, present in the bin.
    await expect(readNote(note.id)).rejects.toThrow();
    const trashed = await listTrashedNotes();
    expect(trashed.some((n) => n.id === note.id)).toBe(true);

    // Restore brings it back intact.
    const restored = await restoreNote(note.id);
    expect(restored.id).toBe(note.id);
    expect(restored.title).toBe("Bin me");
    expect(restored.body).toContain("keep me safe");
    expect((await listTrashedNotes()).some((n) => n.id === note.id)).toBe(false);
  });

  it("purges a single note permanently", async () => {
    const note = await createNote({ title: "Purge me", body: "x" });
    await deleteNote(note.id);
    await purgeTrashedNote(note.id);
    expect((await listTrashedNotes()).some((n) => n.id === note.id)).toBe(false);
    await expect(restoreNote(note.id)).rejects.toThrow();
  });

  it("empties the bin", async () => {
    const a = await createNote({ title: "Empty A", body: "x" });
    const b = await createNote({ title: "Empty B", body: "y" });
    await deleteNote(a.id);
    await deleteNote(b.id);
    expect((await listTrashedNotes()).length).toBeGreaterThanOrEqual(2);
    const purged = await emptyTrash();
    expect(purged).toBeGreaterThanOrEqual(2);
    expect((await listTrashedNotes()).length).toBe(0);
  });
});

describe("listing", () => {
  it("lists and counts notes with sort by title asc", async () => {
    await createNote({ title: "zebra", body: "a" });
    await createNote({ title: "apple", body: "b" });
    const all = await listNotes({ sort: "title", order: "asc", limit: 50 });
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all[all.length - 1]!.title).toBe("zebra");
    expect(await noteCount()).toBeGreaterThanOrEqual(2);
  });

  it("lists tags with counts", async () => {
    await createNote({ title: "Tagged one", body: "x", tags: ["ideas"] });
    await createNote({ title: "Tagged two", body: "y", tags: ["ideas", "other"] });
    const tags = await listTags();
    const ideas = tags.find((t) => t.name === "ideas");
    expect(ideas).toBeTruthy();
    expect(ideas!.count).toBeGreaterThanOrEqual(2);
  });
});

describe("listNotes pagination", () => {
  it("paginates consistently with the unsliced list", async () => {
    const a = await createNote({ title: "Pagination Alpha", body: "one" });
    const b = await createNote({ title: "Pagination Beta", body: "two" });

    const all = await listNotes({ sort: "title", order: "asc", limit: 50, offset: 0 });
    expect(all.map((n) => n.title)).toContain("Pagination Alpha");
    expect(all.map((n) => n.title)).toContain("Pagination Beta");

    for (let offset = 0; offset < all.length; offset++) {
      const page = await listNotes({ sort: "title", order: "asc", limit: 1, offset });
      expect(page.length).toBe(1);
      expect(page[0].id).toBe(all[offset].id);
    }

    await deleteNote(a.id);
    await deleteNote(b.id);
  });
});

describe("note size", () => {
  it("sums note.md plus attachment bytes", async () => {
    const note = await createNote({ title: "Size me", body: "# Title\n\nsome text here" });
    await writeAttachment(note.id, "data.bin", Buffer.alloc(2048, 7));
    const { bytes, count } = await noteSize(note.id);
    expect(count).toBe(1);
    expect(bytes).toBeGreaterThan(2048);
  });
});

describe("word count", () => {
  it("ignores code blocks and markdown links", () => {
    const body = "```js\nconst x = 1;\n```\n\nHello [world](https://x.com) ![](img.png)";
    expect(computeWordCount(body)).toBe(2); // "Hello" + "world"
  });

  it("counts unicode words", () => {
    expect(computeWordCount("país dirección 你好")).toBe(3);
  });
});

describe("malformed input", () => {
  it("parses a note with missing metadata gracefully", async () => {
    const content = "# Just a heading\n\nSome content.";
    const file = path.join(dataDir, "notes", "2024-01-01-bare-0001", "note.md");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    const parsed = notes.parseNoteFile(content);
    expect(parsed.title).toBe("Untitled");
    expect(parsed.body).toContain("# Just a heading");
    fs.rmSync(path.join(dataDir, "notes", "2024-01-01-bare-0001"), { recursive: true, force: true });
  });

  it("rejects invalid note ids on delete", async () => {
    await expect(deleteNote("../escape")).rejects.toThrow();
  });
});